import { Channel, ChannelState, ChannelConfig } from '../../domain/channel/Channel';
import { MediaFile } from '../../domain/media/MediaFile';
import { FFmpegEngine, StreamConfig } from '../../infrastructure/ffmpeg/FFmpegEngine';
import { createLogger } from '../../utils/logger';
import {
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../utils/errors';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../../config/env';
import { ChannelRepository } from '../../infrastructure/database/repositories/ChannelRepository';
import { MediaFileRepository } from '../../infrastructure/database/repositories/MediaFileRepository';
import { ChannelMediaRepository } from '../../infrastructure/database/repositories/ChannelMediaRepository';
import { PlaybackSessionRepository } from '../../infrastructure/database/repositories/PlaybackSessionRepository';
import { VirtualTimeService } from '../virtual-time/VirtualTimeService';
import { BumperGenerator } from '../bumper/BumperGenerator';
import { PlaylistManipulator } from '../playlist/PlaylistManipulator';
import { PlaylistService } from '../playlist/PlaylistService';
import { EPGService } from '../epg/EPGService';

const logger = createLogger('ChannelService');

export class ChannelService {
  // In-memory cache for fast access (synced with database)
  private channels: Map<string, Channel> = new Map()
  
  // Discontinuity tracking for HLS RFC 8216 compliance
  private channelDiscontinuityCount: Map<string, number> = new Map()
  
  // Playlist manipulator for HLS enhancements
  private playlistManipulator: PlaylistManipulator = new PlaylistManipulator();
  // Playlist service for transition tracking and tag injection
  // Note: This must be shared with route handlers to ensure transition points are visible
  public readonly playlistService: PlaylistService = new PlaylistService();
  private channelMedia: Map<string, MediaFile[]> = new Map();
  private readonly ffmpegEngine: FFmpegEngine;
  private readonly channelRepository: ChannelRepository;
  private readonly mediaFileRepository: MediaFileRepository;
  private readonly channelMediaRepository: ChannelMediaRepository;
  private readonly playbackSessionRepository: PlaybackSessionRepository;
  private readonly virtualTimeService: VirtualTimeService;
  private readonly bumperGenerator: BumperGenerator;
  private readonly epgService: EPGService;
  private virtualTimeUpdateInterval: NodeJS.Timeout | null = null;
  private bucketService?: any; // MediaBucketService - injected via setter
  private playlistResolver?: any; // PlaylistResolver - injected via setter

  // Grace period timers for pausing streams after inactivity
  private pauseTimers: Map<string, NodeJS.Timeout> = new Map();

  // Pre-generated bumpers keyed by the target nextIndex. Prevents overwriting when pre-generating for different upcoming files.
  // Note: In the new pipeline, bumpers stream as separate FFmpeg processes (not merged into playlists)
  private channelPregenBumpers: Map<string, Map<number, { segmentsDir: string; segmentCount: number }>> = new Map();

  // Track active playback session IDs for each channel
  private activeSessionIds: Map<string, string> = new Map();

  constructor(ffmpegEngine: FFmpegEngine) {
    this.ffmpegEngine = ffmpegEngine;
    this.channelRepository = new ChannelRepository();
    this.mediaFileRepository = new MediaFileRepository();
    this.channelMediaRepository = new ChannelMediaRepository();
    this.virtualTimeService = new VirtualTimeService();
    this.bumperGenerator = new BumperGenerator();
    this.playbackSessionRepository = new PlaybackSessionRepository();
    this.epgService = new EPGService();

    // Start virtual time update loop (updates every 10 seconds while streaming)
    this.startVirtualTimeUpdateLoop();
  }

  /**
   * Start periodic virtual time updates for streaming channels
   */
  private startVirtualTimeUpdateLoop(): void {
    this.virtualTimeUpdateInterval = setInterval(async () => {
      try {
        await this.updateVirtualTimeForStreamingChannels();
      } catch (error) {
        logger.error({ error }, 'Error in virtual time update loop');
      }
    }, 10000); // Update every 10 seconds
  }

  /**
   * Update virtual time for all currently streaming channels
   */
  private async updateVirtualTimeForStreamingChannels(): Promise<void> {
    const streamingChannels = Array.from(this.channels.values()).filter(
      (ch) => ch.isStreaming()
    );

    for (const channel of streamingChannels) {
      try {
        const media = await this.getChannelMedia(channel.id);
        if (media.length === 0) continue;

        // CRITICAL: Skip virtual time updates when there are active viewers!
        // Virtual time is only for tracking position when nobody is watching.
        // During active streaming, currentIndex is managed by file transitions.
        const viewerCount = channel.getMetadata().viewerCount;
        if (viewerCount > 0) {
          logger.debug(
            { channelId: channel.id, viewerCount },
            'Skipping virtual time update (active viewers)'
          );
          continue;
        }

        // Get current virtual time state
        const virtualTime = await this.virtualTimeService.getChannelVirtualTime(
          channel.id
        );

        if (!virtualTime || virtualTime.virtualPausedAt !== null) {
          continue; // Skip paused channels
        }

        // Calculate current position
        const position = this.virtualTimeService.calculateCurrentVirtualPosition(
          virtualTime,
          media
        );

        // Update in database
        await this.virtualTimeService.advanceVirtualTime(
          channel.id,
          position.totalVirtualSeconds,
          position.currentIndex,
          position.positionInFile
        );

        // Update channel's current index if it changed
        if (position.currentIndex !== channel.getMetadata().currentIndex) {
          channel.updateCurrentIndex(position.currentIndex);
          await this.channelRepository.update(channel.id, {
            current_index: position.currentIndex,
          });
        }
      } catch (error) {
        logger.error({ error, channelId: channel.id }, 'Failed to update virtual time');
      }
    }
  }

  /**
   * Load all channels from database on startup
   */
  public async loadChannelsFromDatabase(): Promise<void> {
    try {
      const rows = await this.channelRepository.findAll();

      for (const row of rows) {
        const channel = ChannelRepository.rowToChannel(row);

        // Reset orphaned streaming states (no actual FFmpeg process running after restart)
        // Channels in STREAMING, STARTING, STOPPING, or ERROR state need to be reset to IDLE
        const currentState = channel.getState();
        if (
          currentState === ChannelState.STREAMING ||
          currentState === ChannelState.STARTING ||
          currentState === ChannelState.STOPPING ||
          currentState === ChannelState.ERROR
        ) {
          logger.info(
            { channelId: channel.id, state: currentState },
            'Resetting orphaned state to IDLE after server restart'
          );

          // Follow proper state transitions
          if (currentState === ChannelState.STREAMING) {
            channel.transitionTo(ChannelState.STOPPING);
            channel.transitionTo(ChannelState.IDLE);
          } else if (currentState === ChannelState.STARTING || currentState === ChannelState.STOPPING) {
            channel.transitionTo(ChannelState.IDLE);
          } else if (currentState === ChannelState.ERROR) {
            channel.transitionTo(ChannelState.IDLE);
          }

          await this.channelRepository.update(channel.id, {
            state: ChannelState.IDLE,
          });
        }

        // Reset viewer count to 0 (no viewers after server restart)
        const viewerCount = channel.getMetadata().viewerCount;
        if (viewerCount > 0) {
          logger.info(
            { channelId: channel.id, oldViewerCount: viewerCount },
            'Resetting viewer count to 0 after server restart'
          );

          // Reset in-memory
          while (channel.getMetadata().viewerCount > 0) {
            channel.decrementViewerCount();
          }

          // Reset in database
          await this.channelRepository.update(channel.id, {
            viewer_count: 0,
          });
        }

        this.channels.set(channel.id, channel);

        // Load media for this channel
        const channelMedia = await this.channelMediaRepository.getChannelMedia(
          channel.id
        );
        const mediaFiles = await Promise.all(
          channelMedia.map(async (cm) => {
            const mfRow = await this.mediaFileRepository.findById(cm.media_file_id);
            if (mfRow) {
              return MediaFileRepository.rowToMediaFile(mfRow);
            }
            return null;
          })
        );
        this.channelMedia.set(
          channel.id,
          mediaFiles.filter((f): f is MediaFile => f !== null)
        );
      }

      logger.info({ count: rows.length }, 'Channels loaded from database');
    } catch (error) {
      logger.error({ error }, 'Failed to load channels from database');
      // Continue with empty state - allows server to start even if DB is unavailable
    }
  }

  /**
   * Create a new channel
   */
  public async createChannel(config: ChannelConfig): Promise<Channel> {
    // Validate slug is unique
    const existing = await this.channelRepository.findBySlug(config.slug);
    if (existing) {
      throw new ConflictError(`Channel with slug '${config.slug}' already exists`);
    }

    const channel = new Channel(config);
    
    // Save to database
    await this.channelRepository.create(channel);
    
    // Cache in memory
    this.channels.set(channel.id, channel);

    logger.info({ channelId: channel.id, slug: config.slug }, 'Channel created');
    return channel;
  }

  /**
   * Get channel by ID (from cache or database)
   */
  public async getChannel(channelId: string): Promise<Channel> {
    // Try cache first
    let channel = this.channels.get(channelId);
    
    if (!channel) {
      // Load from database
      const row = await this.channelRepository.findById(channelId);
      if (!row) {
        throw new NotFoundError(`Channel '${channelId}'`);
      }
      channel = ChannelRepository.rowToChannel(row);
      this.channels.set(channelId, channel);
    }
    
    return channel;
  }

  /**
   * Get channel by slug
   */
  public async findChannelBySlug(slug: string): Promise<Channel | undefined> {
    // Try cache first
    const cached = Array.from(this.channels.values()).find(
      (ch) => ch.config.slug === slug
    );
    if (cached) {
      return cached;
    }

    // Load from database
    const row = await this.channelRepository.findBySlug(slug);
    if (!row) {
      return undefined;
    }

    const channel = ChannelRepository.rowToChannel(row);
    this.channels.set(channel.id, channel);
    return channel;
  }

  /**
   * Update channel configuration
   */
  public async updateChannelConfig(channelId: string, updates: { useDynamicPlaylist?: boolean; includeBumpers?: boolean; autoStart?: boolean }): Promise<void> {
    const channel = await this.getChannel(channelId);
    
    // Update database
    await this.channelRepository.update(channelId, {
      use_dynamic_playlist: updates.useDynamicPlaylist,
      include_bumpers: updates.includeBumpers,
      auto_start: updates.autoStart,
    });
    
    // Update in-memory channel config
    if (updates.useDynamicPlaylist !== undefined) {
      channel.config.useDynamicPlaylist = updates.useDynamicPlaylist;
    }
    if (updates.includeBumpers !== undefined) {
      channel.config.includeBumpers = updates.includeBumpers;
    }
    if (updates.autoStart !== undefined) {
      channel.config.autoStart = updates.autoStart;
    }
    
    // Update cache
    this.channels.set(channelId, channel);
    
    logger.info({ channelId, updates }, 'Channel configuration updated');
  }

  /**
   * Get all channels
   */
  public getAllChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Delete channel
   */
  public async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    // Stop streaming if active
    if (channel.isStreaming()) {
      await this.stopChannel(channelId);
    }

    // Delete from database
    await this.channelRepository.delete(channelId);

    // Remove from cache
    this.channels.delete(channelId);
    this.channelMedia.delete(channelId);

    logger.info({ channelId }, 'Channel deleted');
  }

  /**
   * Set media files for a channel (DEPRECATED - use buckets instead)
   * @deprecated Direct media assignment is no longer supported. Use buckets to assign media to channels.
   */
  public async setChannelMedia(
    channelId: string,
    _mediaFiles: MediaFile[]
  ): Promise<void> {
    logger.warn(
      { channelId },
      'setChannelMedia is deprecated. Channels should get media from buckets, not direct assignment.'
    );
    throw new Error('Direct media assignment is no longer supported. Use buckets to assign media to channels.');
  }

  /**
   * Set bucket service (for getting media from buckets)
   */
  public setBucketService(bucketService: any): void {
    this.bucketService = bucketService;
  }

  /**
   * Set playlist resolver for dynamic playlist generation
   */
  public setPlaylistResolver(playlistResolver: any): void {
    this.playlistResolver = playlistResolver;
  }

  /**
   * Invalidate EPG cache for a channel
   * Call this when the channel's playlist changes (media added/removed/reordered)
   */
  public async invalidateEPGCache(channelId: string): Promise<void> {
    await this.epgService.invalidateCache(channelId);
    logger.info({ channelId }, 'EPG cache invalidated due to playlist change');
  }

  /**
   * Invalidate channel media cache
   * Call this when schedule blocks or buckets are added/removed/modified
   * This ensures the channel will re-resolve media on the next getChannelMedia call
   */
  public invalidateChannelMediaCache(channelId: string): void {
    this.channelMedia.delete(channelId);
    logger.debug({ channelId }, 'Channel media cache invalidated');
  }

  /**
   * Get media files for a channel
   * Supports both static (bucket-based) and dynamic (resolver-based) playlist generation
   * 
   * IMPORTANT: Dynamic playlists are NOT cached because they depend on current time.
   * Static playlists are cached for performance.
   */
  public async getChannelMedia(channelId: string): Promise<MediaFile[]> {
    const channel = await this.getChannel(channelId);
    const useDynamicPlaylist = channel.config.useDynamicPlaylist || false;

    // If dynamic playlist is enabled and resolver is available, use resolver
    if (useDynamicPlaylist && this.playlistResolver) {
      try {
        // Get virtual time context for resolver
        const virtualTimeState = await this.virtualTimeService.getChannelVirtualTime(channelId);
        const context = {
          virtualTime: virtualTimeState?.totalVirtualSeconds,
          currentTime: new Date(), // Always use current time - don't cache dynamic playlists
          currentIndex: channel.getMetadata().currentIndex,
        };

        // CRITICAL: Do NOT cache dynamic playlists - they depend on current time
        // Schedule blocks can change, so we must resolve fresh each time
        const mediaFiles = await this.playlistResolver.resolveMedia(channelId, context);
        logger.debug({ channelId, mediaCount: mediaFiles.length, mode: 'dynamic' }, 'Resolved media using PlaylistResolver (fresh resolution)');
        return mediaFiles;
      } catch (error) {
        logger.error({ error, channelId }, 'Failed to resolve media using PlaylistResolver, falling back to static');
        // Fall through to static resolution
      }
    }

    // Static resolution (backward compatible) - use bucket service directly
    // Static playlists are safe to cache because they don't change based on time
    // BUT: Don't trust cache if it's empty - buckets might have been assigned after cache was set
    if (this.channelMedia.has(channelId)) {
      const cached = this.channelMedia.get(channelId)!;
      if (cached.length > 0) {
        logger.debug({ channelId, mediaCount: cached.length, mode: 'static (cached)' }, 'Returning cached static playlist');
        return cached;
      } else {
        logger.debug({ channelId, mode: 'static (cached empty, refreshing)' }, 'Cache has empty array, refreshing from buckets');
        // Cache has empty array - refresh from buckets in case buckets were assigned
        this.channelMedia.delete(channelId);
      }
    }

    if (!this.bucketService) {
      logger.warn({ channelId }, 'Bucket service not available, returning empty media list');
      return [];
    }

    try {
      logger.info({ channelId, hasBucketService: !!this.bucketService }, 'Getting media IDs from channel buckets');
      const mediaIds = await this.bucketService.getMediaFromChannelBuckets(channelId);
      logger.info({ channelId, mediaIdsCount: mediaIds.length, sampleMediaIds: mediaIds.slice(0, 5) }, 'Got media IDs from channel buckets');
      
      if (mediaIds.length === 0) {
        logger.warn({ channelId }, 'No media IDs found in channel buckets - buckets may be empty or not assigned');
        // Don't cache empty arrays - allows retry if buckets are assigned later
        return [];
      }
      
      // Get full media file details
      const mediaFiles = await Promise.all(
        mediaIds.map(async (id: string) => {
          const mfRow = await this.mediaFileRepository.findById(id);
          if (mfRow) {
            return MediaFileRepository.rowToMediaFile(mfRow);
          }
          logger.warn({ channelId, mediaId: id }, 'Media file ID from bucket not found in database');
          return null;
        })
      );

      const validFiles = mediaFiles.filter((f): f is MediaFile => f !== null);
      const missingCount = mediaIds.length - validFiles.length;
      
      if (missingCount > 0) {
        logger.warn(
          { channelId, missingCount, totalIds: mediaIds.length, validCount: validFiles.length },
          'Some media IDs from buckets were not found in database'
        );
      }
      
      // Only cache if we have valid files
      if (validFiles.length > 0) {
        this.channelMedia.set(channelId, validFiles);
        logger.debug({ channelId, mediaCount: validFiles.length, mode: 'static' }, 'Resolved media from buckets (static)');
      } else {
        logger.warn({ channelId }, 'No valid media files found after resolving from buckets - not caching');
      }
      
      return validFiles;
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to get media from buckets');
      return [];
    }
  }

  /**
   * Start streaming a channel
   * Uses virtual time to determine starting position if resuming
   */
  public async startChannel(
    channelId: string,
    startIndex?: number
  ): Promise<void> {
    const channel = await this.getChannel(channelId);
    // CRITICAL: For dynamic playlists, we should NOT get media here using current time
    // because EPG will determine the correct media list based on the program's schedule block.
    // We'll get the media list from EPG after getting the position.
    let media: MediaFile[] = [];
    
    // For static playlists, get media now
    if (!channel.config.useDynamicPlaylist || !this.playlistResolver) {
      media = await this.getChannelMedia(channelId);
    }
    
    // For dynamic playlists, store media list for comparison in onFileEnd
    // This allows us to detect schedule block transitions
    if (channel.config.useDynamicPlaylist) {
      // We'll set this after we get the EPG media list
      logger.debug({ channelId }, 'Dynamic playlist - will get media list from EPG');
    }

    // Handle orphaned states (STOPPING, ERROR) - reset to IDLE before starting
    const currentState = channel.getState();
    if (currentState === ChannelState.STOPPING || currentState === ChannelState.ERROR) {
      logger.info(
        { channelId, currentState },
        'Resetting orphaned state to IDLE before starting'
      );
      channel.transitionTo(ChannelState.IDLE);
      await this.channelRepository.update(channelId, {
        state: ChannelState.IDLE,
      });
    }

    // Validate state
    if (!channel.canTransitionTo(ChannelState.STARTING)) {
      throw new ConflictError(`Channel is already ${channel.getState()}`);
    }

    // For dynamic playlists, media will be set from EPG below
    // For static playlists, validate media now
    if (!channel.config.useDynamicPlaylist && media.length === 0) {
      throw new ValidationError('Channel has no media files');
    }

    // DEBUG: For dynamic playlists, check what blocks exist and why getActiveBlock might not find them
    if (channel.config.useDynamicPlaylist && this.playlistResolver) {
      try {
        const ScheduleRepository = (await import('../../infrastructure/database/repositories/ScheduleRepository')).ScheduleRepository;
        const scheduleRepository = new ScheduleRepository();
        const allBlocks = await scheduleRepository.getAllEnabledBlocks(channelId);
        const now = new Date();
        const activeBlock = await scheduleRepository.getActiveBlock(channelId, now);
        
        logger.info(
          {
            channelId,
            currentTime: now.toISOString(),
            dayOfWeek: now.getDay(),
            timeStr: now.toTimeString().substring(0, 8),
            totalEnabledBlocks: allBlocks.length,
            hasActiveBlock: !!activeBlock,
            activeBlockName: activeBlock?.name,
            allBlockNames: allBlocks.map(b => ({
              name: b.name,
              dayOfWeek: b.day_of_week,
              startTime: b.start_time,
              endTime: b.end_time,
              enabled: b.enabled,
            })),
          },
          'Schedule block check for dynamic playlist channel'
        );
      } catch (error) {
        logger.warn({ error, channelId }, 'Failed to check schedule blocks (non-fatal)');
      }
    }

    try {
      // Transition to STARTING
      channel.transitionTo(ChannelState.STARTING);
      await this.channelRepository.update(channelId, {
        state: ChannelState.STARTING,
        started_at: new Date(),
      });

      // Determine starting position
      // Use virtual time if resuming after pause (channel was paused)
      // During active streaming transitions, always start from beginning of file
      // Initialize with default to ensure it's always defined
      let actualStartIndex: number = startIndex ?? channel.getMetadata().currentIndex ?? 0;
      let seekToSeconds = 0;

      const virtualTime = await this.virtualTimeService.getChannelVirtualTime(
        channelId
      );

      // Log virtual time state to troubleshoot resumption
      logger.info(
        {
          channelId,
          hasVirtualTime: !!virtualTime,
          virtualStartTime: virtualTime?.virtualStartTime?.toISOString(),
          virtualPausedAt: virtualTime?.virtualPausedAt?.toISOString(),
          totalVirtualSeconds: virtualTime?.totalVirtualSeconds,
          virtualCurrentIndex: virtualTime?.virtualCurrentIndex,
          virtualPositionInFile: virtualTime?.virtualPositionInFile,
          startIndex,
        },
        'Virtual time state check in startChannel'
      );

      // Use virtual time if:
      // 1. Virtual timeline exists (virtual_start_time is set)
      // 2. Channel was paused (virtual_paused_at is set) OR channel is IDLE (resuming after restart/manual start)
      // 3. Not an explicit startIndex (automatic resume)
      // 
      // CRITICAL: Check pause state BEFORE resuming, so we can use the virtual position
      // If channel is IDLE and has virtual timeline, use stored position (handles resume after server restart)
      // The stored virtual_current_index and virtual_position_in_file will have the correct values
      const wasPaused = virtualTime?.virtualPausedAt !== null;
      const isIdle = channel.getState() === ChannelState.IDLE;
      const shouldUseVirtualTime =
        virtualTime?.virtualStartTime &&
        (wasPaused || isIdle) &&
        startIndex === undefined;

      // CRITICAL: For dynamic playlists, ALWAYS get media from EPG before anything else
      // This ensures we use the schedule block's media that matches what EPG shows
      if (channel.config.useDynamicPlaylist && this.playlistResolver) {
        logger.debug(
          { channelId },
          'Dynamic playlist detected - getting media from EPG before determining position'
        );
        
        // Get temp media to generate programs
        const tempMedia = media.length > 0 ? media : await this.getChannelMedia(channelId);
        logger.debug(
          {
            channelId,
            tempMediaCount: tempMedia.length,
            tempMediaFirstFile: tempMedia[0]?.filename,
          },
          'Got temporary media list to generate EPG programs'
        );
        
        const programs = await this.epgService.generatePrograms(channel, tempMedia);
        const now = new Date();
        const currentProgram = programs.find((p) => p.isAiring(now));
        
        logger.info(
          {
            channelId,
            programCount: programs.length,
            currentTime: now.toISOString(),
            hasCurrentProgram: !!currentProgram,
            currentProgramTitle: currentProgram?.info?.title,
            currentProgramStart: currentProgram?.startTime.toISOString(),
          },
          'Generated EPG programs and found current program'
        );
        
        if (currentProgram) {
          // Get the media list that EPG actually used for this program
          const epgContext = {
            currentTime: currentProgram.startTime,
            currentIndex: 0,
          };
          
          logger.debug(
            {
              channelId,
              programStartTime: currentProgram.startTime.toISOString(),
              programTitle: currentProgram.info.title,
              contextTime: epgContext.currentTime.toISOString(),
            },
            'Calling resolveMedia with program start time to get EPG media list'
          );
          
          let epgMedia = await this.playlistResolver.resolveMedia(channelId, epgContext);
          
          logger.info(
            {
              channelId,
              epgMediaCount: epgMedia.length,
              programStartTime: currentProgram.startTime.toISOString(),
              programTitle: currentProgram.info.title,
              epgMediaFirstFile: epgMedia[0]?.filename,
              epgMediaFirstTitle: epgMedia[0]?.info?.title,
            },
            'Resolved EPG media list from program\'s schedule block'
          );
          
          if (epgMedia.length === 0) {
            logger.warn(
              { channelId, programTitle: currentProgram.info.title },
              'EPG media list is empty, falling back to current time media'
            );
            epgMedia = await this.getChannelMedia(channelId);
          }
          
          if (epgMedia.length > 0) {
            media = epgMedia;
            logger.info(
              {
                channelId,
                epgMediaCount: epgMedia.length,
                firstFile: media[0]?.filename,
              },
              'Using EPG media list for playback'
            );
          }
        } else {
          logger.warn({ channelId }, 'No current program in EPG, using current time media');
          media = await this.getChannelMedia(channelId);
        }
      }
      
      if (shouldUseVirtualTime) {
        // Channel was paused - use EPG as the single source of truth for resume position
        // EPG knows what should be playing now based on program schedule
        logger.debug(
          {
            channelId,
            totalVirtualSeconds: virtualTime.totalVirtualSeconds,
            virtualPausedAt: virtualTime.virtualPausedAt?.toISOString(),
            mediaCount: media.length,
          },
          'Getting resume position from EPG (single source of truth)'
        );
        
        // Media was already set above from EPG for dynamic playlists
        logger.debug(
          {
            channelId,
            mediaCount: media.length,
            firstFile: media[0]?.filename,
          },
          'Media already set from EPG, now getting playback position'
        );
        
        // Validate media is not empty
        if (media.length === 0) {
          logger.error(
            { channelId },
            'Media list is empty after EPG resolution - cannot use EPG for position'
          );
          // Fall through to virtual time fallback below
        }
        
        const epgPosition = media.length > 0 ? await this.epgService.getCurrentPlaybackPosition(channel, media) : null;
        if (epgPosition) {
          actualStartIndex = epgPosition.fileIndex;
          seekToSeconds = epgPosition.seekPosition;
          
          // CRITICAL: Verify we're playing what EPG says should be playing NOW
          // This ensures UX consistency - if EPG shows "Robot Chicken", we should be playing Robot Chicken
          try {
            const { current } = await this.epgService.getCurrentAndNext(channel, media);
            if (current) {
              const currentFile = media[actualStartIndex];
              const epgProgramTitle = current.info.title;
              const actualFileTitle = currentFile?.getDisplayName() || currentFile?.filename || 'Unknown';
              
              // Check if the file we're about to play matches what EPG says should be playing
              if (epgProgramTitle !== actualFileTitle) {
                logger.info(
                  {
                    channelId,
                    epgProgramTitle,
                    actualFileTitle,
                    epgIndex: actualStartIndex,
                    willSync: true,
                  },
                  'EPG program title does not match current file - EPG says should be playing different content'
                );
                
                // Find the file that matches the EPG program title
                const matchingFileIndex = media.findIndex(m => {
                  const displayName = m.getDisplayName();
                  return displayName === epgProgramTitle || m.filename === epgProgramTitle;
                });
                
                if (matchingFileIndex !== -1) {
                  logger.info(
                    {
                      channelId,
                      oldIndex: actualStartIndex,
                      newIndex: matchingFileIndex,
                      epgProgramTitle,
                      oldFile: actualFileTitle,
                      newFile: media[matchingFileIndex]?.getDisplayName(),
                    },
                    'Syncing to EPG program - switching to file that matches EPG current program'
                  );
                  actualStartIndex = matchingFileIndex;
                  seekToSeconds = 0; // Start from beginning of the correct file
                } else {
                  logger.warn(
                    {
                      channelId,
                      epgProgramTitle,
                      mediaFiles: media.map(m => m.getDisplayName()),
                    },
                    'Could not find file matching EPG program title - using EPG position as-is'
                  );
                }
              } else {
                logger.debug(
                  {
                    channelId,
                    epgProgramTitle,
                    actualFileTitle,
                    fileIndex: actualStartIndex,
                  },
                  'EPG program matches current file - no sync needed'
                );
              }
            }
          } catch (epgCheckError) {
            logger.warn(
              { error: epgCheckError, channelId },
              'Failed to verify EPG program match (non-fatal, continuing with EPG position)'
            );
          }
          
          // Store the EPG media list for dynamic playlists
          if (channel.config.useDynamicPlaylist) {
            this.channelMedia.set(channelId, [...media]); // Store copy for comparison
            logger.debug({ channelId, mediaCount: media.length }, 'Stored EPG media list for schedule block transition detection');
          }
          
          // Validate media after getting EPG media list
          if (media.length === 0) {
            throw new ValidationError('Channel has no media files (EPG returned empty media list)');
          }

          logger.info(
            {
              channelId,
              epgIndex: actualStartIndex,
              epgPosition: seekToSeconds,
              method: 'EPG-based (single source of truth)',
              mediaCount: media.length,
              fileAtIndex: media[actualStartIndex]?.filename,
              fileTitle: media[actualStartIndex]?.info?.title,
            },
            'Resuming from EPG-calculated position (synced with EPG current program)'
          );
        } else {
          // EPG couldn't determine position - fallback to virtual time
          logger.warn(
            { channelId },
            'EPG could not determine position, falling back to virtual time calculation'
          );
          
          const position = this.virtualTimeService.calculateCurrentVirtualPosition(
            virtualTime,
            media
          );
          actualStartIndex = position.currentIndex;
          seekToSeconds = position.positionInFile;

          logger.info(
            {
              channelId,
              virtualIndex: actualStartIndex,
              virtualPosition: seekToSeconds,
              method: 'Virtual time fallback',
            },
            'Resuming from virtual time position (EPG fallback)'
          );
        }
      } else if (startIndex !== undefined) {
        // Explicit index provided - use it, start from beginning during active streaming
        actualStartIndex = startIndex;
        seekToSeconds = 0; // Always start from beginning when explicitly specifying index during transitions

        logger.debug(
          { channelId, startIndex },
          'Starting from explicit index (active streaming transition)'
        );
      } else {
        // CRITICAL: For non-dynamic channels without virtual time, check EPG first
        // This ensures all channels (dynamic and non-dynamic) respect EPG positioning
        // Previously, non-dynamic channels would always start at index 0 (episode 1)
        const epgPosition = media.length > 0 ? await this.epgService.getCurrentPlaybackPosition(channel, media) : null;
        
        if (epgPosition) {
          actualStartIndex = epgPosition.fileIndex;
          seekToSeconds = epgPosition.seekPosition;
          
          logger.info(
            {
              channelId,
              epgIndex: actualStartIndex,
              epgPosition: seekToSeconds,
              method: 'EPG-based (non-dynamic channel first start)',
              mediaCount: media.length,
              fileAtIndex: media[actualStartIndex]?.filename,
              fileTitle: media[actualStartIndex]?.info?.title,
            },
            'Starting from EPG-calculated position (non-dynamic channel respects EPG)'
          );
        } else {
          // No EPG position available - use current channel index or 0
          actualStartIndex = channel.getMetadata().currentIndex ?? 0;
          seekToSeconds = 0;
          
          logger.debug(
            { channelId, actualStartIndex },
            'No EPG position available, using current channel index or defaulting to 0'
          );
        }
      }

      // Initialize virtual timeline if it doesn't exist
      if (!virtualTime?.virtualStartTime) {
        await this.virtualTimeService.initializeVirtualTimeline(channelId);
      }

      // CRITICAL: Validate media is not empty before proceeding
      if (media.length === 0) {
        logger.error(
          {
            channelId,
            actualStartIndex,
            useDynamicPlaylist: channel.config.useDynamicPlaylist,
          },
          'Cannot start channel: media list is empty'
        );
        throw new ValidationError('Channel has no media files available. Cannot start streaming.');
      }

      // Validate and fix index if out of bounds (can happen when playlist changes)
      if (actualStartIndex < 0) {
        logger.warn(
          { channelId, actualStartIndex, mediaCount: media.length },
          'Start index is negative, resetting to 0'
        );
        actualStartIndex = 0;
        seekToSeconds = 0;
      } else if (actualStartIndex >= media.length) {
        // Index is beyond available media - reset to last valid index or 0
        const lastValidIndex = Math.max(0, media.length - 1);
        logger.warn(
          { channelId, actualStartIndex, mediaCount: media.length, resetTo: lastValidIndex },
          'Start index is beyond available media, resetting to last valid index'
        );
        actualStartIndex = lastValidIndex;
        seekToSeconds = 0;
        
        // Update virtual time to match the corrected index
        let accumulatedSeconds = 0;
        for (let i = 0; i < actualStartIndex; i++) {
          accumulatedSeconds += media[i].metadata?.duration || 0;
        }
        await this.virtualTimeService.advanceVirtualTime(
          channelId,
          accumulatedSeconds,
          actualStartIndex,
          0
        );
      }

      // Resume virtual time if paused
      if (virtualTime && virtualTime.virtualPausedAt !== null) {
        await this.virtualTimeService.resumeVirtualTime(channelId, media);
      }

      const currentFile = media[actualStartIndex];
      
      // Calculate expected segment count for accurate end-of-file detection
      const fileDuration = currentFile.metadata.duration; // seconds
      const remainingDuration = Math.max(0, fileDuration - seekToSeconds);
      const expectedSegmentCount = Math.ceil(remainingDuration / channel.config.segmentDuration);
      const expectedEndTime = Date.now() + (remainingDuration * 1000); // milliseconds
      
      logger.info(
        {
          channelId,
          startIndex: actualStartIndex,
          seekToSeconds,
          totalFiles: media.length,
          currentFile: currentFile.filename,
          fileDuration,
          remainingDuration,
          expectedSegments: expectedSegmentCount,
          estimatedEndTime: new Date(expectedEndTime).toISOString()
        },
        'Starting single-file streaming with calculated duration'
      );

      // Update channel index
      channel.updateCurrentIndex(actualStartIndex);
      await this.channelRepository.update(channelId, {
        current_index: actualStartIndex,
      });

      // Create stream config for single file
      const outputDir = path.resolve(channel.config.outputDir);

      // CRITICAL: If starting from virtual time position, clean up old playlist!
      // Otherwise append_list will keep old segments and player will start from wrong file
      if (shouldUseVirtualTime) {
        const playlistPath = path.join(outputDir, 'stream.m3u8');
        try {
          await fs.unlink(playlistPath);
          logger.info(
            { channelId, actualStartIndex, file: currentFile.filename },
            'Deleted old playlist (starting from virtual time position - need fresh playlist)'
          );
        } catch (error) {
          // Playlist might not exist - that's fine
          logger.debug({ channelId }, 'No old playlist to delete');
        }

        // Also clean up old segments so FFmpeg starts fresh from segment 0
        try {
          const files = await fs.readdir(outputDir);
          let cleaned = 0;
          for (const file of files) {
            if (file.endsWith('.ts')) {
              await fs.unlink(path.join(outputDir, file));
              cleaned++;
            }
          }
          if (cleaned > 0) {
            logger.info({ channelId, cleaned }, 'Cleaned old segments for fresh start');
          }
        } catch (error) {
          logger.debug({ channelId, error }, 'Failed to clean old segments (non-fatal)');
        }
      }

      // With append_list flag: FFmpeg reads existing playlist to continue segment numbering
      // append_list automatically:
      // - Reads last segment number from existing playlist
      // - Continues numbering from there
      // - Adds EXT-X-DISCONTINUITY via discont_start flag
      // - Cleans old segments via delete_segments flag
      logger.info({ channelId }, 'Starting stream with append_list (continuous playlist)');

      const streamConfig: StreamConfig = {
        inputFile: currentFile.path,
        outputDir: outputDir,
        videoBitrate: channel.config.videoBitrate,
        audioBitrate: channel.config.audioBitrate,
        resolution: channel.config.resolution,
        fps: channel.config.fps,
        segmentDuration: channel.config.segmentDuration,
        startPosition: seekToSeconds > 0 ? seekToSeconds : undefined, // Seek if resuming
      };

      // Placeholder creation now happens earlier in startChannel (after cleanup)

      // Set up callback for when current file finishes (transition to next file)
      const onFileEnd = async () => {
        try {
          const currentChannel = this.channels.get(channelId);
          if (!currentChannel) {
            logger.warn({ channelId }, 'Channel no longer exists, skipping file transition');
            return;
          }

          // Only continue if channel is still supposed to be streaming
          if (!currentChannel.isStreaming() && currentChannel.getState() !== ChannelState.STREAMING) {
            logger.info({ channelId }, 'Channel no longer streaming, skipping file transition');
            return;
          }

          const currentMedia = await this.getChannelMedia(channelId);
          if (currentMedia.length === 0) {
            logger.warn({ channelId }, 'No media files available for transition');
            return;
          }

          // CRITICAL: Detect if media list changed (schedule block transition)
          // For dynamic playlists, the media list can change when schedule blocks transition
          // Use stored media from start of file (not from cache which is empty for dynamic playlists)
          const previousMedia = currentChannel.config.useDynamicPlaylist 
            ? (this.channelMedia.get(channelId) || [])
            : [];
          const mediaListChanged = currentChannel.config.useDynamicPlaylist && (
            currentMedia.length !== previousMedia.length ||
            currentMedia.some((m, i) => !previousMedia[i] || m.id !== previousMedia[i].id)
          );

          // If media list changed, reset to beginning of new schedule block
          if (mediaListChanged) {
            logger.info(
              {
                channelId,
                previousMediaCount: previousMedia.length,
                currentMediaCount: currentMedia.length,
                previousMediaIds: previousMedia.slice(0, 3).map(m => m.id),
                currentMediaIds: currentMedia.slice(0, 3).map(m => m.id),
              },
              'Schedule block changed - media list changed, resetting to start of new block'
            );
            // Store current media list for next comparison (only for dynamic playlists)
            if (currentChannel.config.useDynamicPlaylist) {
              this.channelMedia.set(channelId, [...currentMedia]); // Store copy for next comparison
            }
          }

          let nextIndex: number;

          // EPG as single source of truth - try EPG first
          try {
            const epgFileIndex = await this.epgService.getCurrentFileIndexFromEPG(
              currentChannel,
              currentMedia
            );

            if (epgFileIndex !== null) {
              // EPG determined what should be playing - use it
              nextIndex = epgFileIndex;
              
              logger.info(
                {
                  channelId,
                  currentIndex: currentChannel.getMetadata().currentIndex,
                  nextIndex,
                  nextFile: currentMedia[nextIndex]?.filename,
                  source: 'EPG',
                  mediaListChanged,
                },
                'Current file finished, transitioning to next file based on EPG schedule (single source of truth)'
              );
            } else {
              // EPG unavailable - fall back to existing logic
              throw new Error('EPG unavailable, using fallback logic');
            }
          } catch (epgError) {
            // EPG failed or unavailable - use existing fallback logic
            
            // If media list changed, always start from beginning of new block
            if (mediaListChanged) {
              nextIndex = 0;
              logger.info(
                {
                  channelId,
                  nextIndex,
                  nextFile: currentMedia[0]?.filename,
                  reason: 'schedule block changed, starting from beginning',
                },
                'Schedule block changed, starting from beginning of new block'
              );
            } else {
              // Media list unchanged - use normal transition logic
              const currentViewerCount = currentChannel.getMetadata().viewerCount;
              
              // If there are active viewers, transition immediately to next file (start at beginning)
              // Virtual time is only for resuming after no viewers, not during active streaming
              if (currentViewerCount > 0) {
                // Active streaming - just go to next file in sequence
                const currentIndex = currentChannel.getMetadata().currentIndex;
                nextIndex = (currentIndex + 1) % currentMedia.length;
                
                logger.info(
                  {
                    channelId,
                    currentIndex,
                    nextIndex,
                    nextFile: currentMedia[nextIndex]?.filename,
                    viewerCount: currentViewerCount,
                    fallback: 'sequential (active streaming)',
                  },
                  'Current file finished, transitioning to next file (EPG unavailable, using sequential fallback)'
                );
              } else {
                // No viewers - use virtual time to determine position
                const virtualTimeState = await this.virtualTimeService.getChannelVirtualTime(
                  channelId
                );
                if (!virtualTimeState || !virtualTimeState.virtualStartTime) {
                  // No virtual time state - fall back to sequential transition
                  const currentIndex = currentChannel.getMetadata().currentIndex;
                  nextIndex = (currentIndex + 1) % currentMedia.length;
                  
                  logger.info(
                    {
                      channelId,
                      currentIndex,
                      nextIndex,
                      nextFile: currentMedia[nextIndex]?.filename,
                      fallback: 'sequential (no virtual time)',
                    },
                    'Current file finished, transitioning to next file (EPG unavailable, no virtual time, using sequential)'
                  );
                } else {
                  // Calculate where we should be in the virtual timeline
                  const position = this.virtualTimeService.calculateCurrentVirtualPosition(
                    virtualTimeState,
                    currentMedia
                  );
                  
                  const currentIndex = currentChannel.getMetadata().currentIndex;
                  
                  // If virtual time says we're at the same file, advance to next
                  // Otherwise use virtual time position
                  if (position.currentIndex === currentIndex) {
                    // Same file - advance to next in sequence
                    nextIndex = (currentIndex + 1) % currentMedia.length;
                    logger.info(
                      {
                        channelId,
                        currentIndex,
                        nextIndex,
                        nextFile: currentMedia[nextIndex]?.filename,
                        reason: 'virtual time at same file, advancing to next',
                        fallback: 'virtual time (same file)',
                      },
                      'Current file finished, advancing to next file (EPG unavailable, virtual time at same position)'
                    );
                  } else {
                    // Virtual time says we should be at a different file
                    nextIndex = position.currentIndex;
                    logger.info(
                      {
                        channelId,
                        currentIndex,
                        nextIndex,
                        nextFile: currentMedia[nextIndex]?.filename,
                        virtualPosition: position.positionInFile,
                        fallback: 'virtual time',
                      },
                      'Current file finished, transitioning to next file (EPG unavailable, using virtual time)'
                    );
                  }
                }
              }
            }
          }

          // CRITICAL: Validate nextIndex is within bounds
          if (nextIndex < 0 || nextIndex >= currentMedia.length) {
            logger.warn(
              {
                channelId,
                nextIndex,
                mediaCount: currentMedia.length,
                mediaListChanged,
              },
              'Next index is out of bounds, resetting to 0'
            );
            nextIndex = 0;
          }

          // Validate file exists before accessing
          const nextFile = currentMedia[nextIndex];
          if (!nextFile) {
            logger.error(
              {
                channelId,
                nextIndex,
                mediaCount: currentMedia.length,
                mediaListChanged,
              },
              'Next file not found, cannot transition'
            );
            return; // Stop transition
          }

          // FFmpeg process has already ended, prepare for next file
          // Longer delay to ensure Roku players have time to fetch the last playlist update
          // Roku is slow at playlist refreshes, needs 1.5s minimum
          await new Promise((resolve) => setTimeout(resolve, 1500));
          
          // Update index first (before state transition to avoid conflicts)
          currentChannel.updateCurrentIndex(nextIndex);

          // CRITICAL: Update total_virtual_seconds to match the new file position
          // This prevents the virtual time loop from resetting currentIndex back to 0!
          // Calculate accumulated time up to the START of the next file
          let accumulatedSeconds = 0;
          for (let i = 0; i < nextIndex; i++) {
            accumulatedSeconds += currentMedia[i].metadata?.duration || 0;
          }

          logger.info(
            {
              channelId,
              nextIndex,
              accumulatedSeconds,
              nextFile: nextFile.filename,
            },
            'Updating virtual time to match file transition'
          );

          await this.channelRepository.update(channelId, {
            current_index: nextIndex,
          });

          // Update virtual time in database
          await this.virtualTimeService.advanceVirtualTime(
            channelId,
            accumulatedSeconds,
            nextIndex,
            0 // Starting at beginning of next file
          );

          // Update bucket progression for sequential playback with schedule blocks
          if (currentChannel.config.useDynamicPlaylist && this.playlistResolver && this.bucketService) {
            try {
              // Get active schedule block to find bucket
              const ScheduleRepository = (await import('../../infrastructure/database/repositories/ScheduleRepository')).ScheduleRepository;
              const scheduleRepository = new ScheduleRepository();
              const activeBlock = await scheduleRepository.getActiveBlock(channelId, new Date());
              
              if (activeBlock && activeBlock.bucket_id && activeBlock.playback_mode === 'sequential') {
                // For sequential playback, track progression so we can resume next time the block runs
                // The media list returned by resolver might be rotated, so we need the original bucket order
                const bucketMediaIds = await this.bucketService.getMediaInBucket(activeBlock.bucket_id);
                
                if (nextFile) {
                  // Find the position in the original bucket order
                  const positionInBucket = bucketMediaIds.indexOf(nextFile.id);
                  
                  if (positionInBucket !== -1) {
                    // Update progression to track where we'll be starting from next time
                    // This is the position we're transitioning TO, which will be the start position next time
                    await this.bucketService.updateProgression({
                      channelId,
                      bucketId: activeBlock.bucket_id,
                      lastPlayedMediaId: nextFile.id,
                      currentPosition: positionInBucket,
                    });
                    
                    logger.debug(
                      { channelId, bucketId: activeBlock.bucket_id, position: positionInBucket, mediaId: nextFile.id, mediaName: nextFile.filename },
                      'Updated bucket progression for sequential playback (will resume from this position next time block runs)'
                    );
                  }
                }
              }
            } catch (error) {
              // Log but don't fail transition if progression update fails
              logger.warn({ channelId, error }, 'Failed to update bucket progression, continuing transition');
            }
          }

          // FFmpeg process has already ended, so clear the streaming state
          // Manually transition to IDLE (bypassing normal stop flow since FFmpeg already stopped)
          if (currentChannel.isStreaming() || currentChannel.getState() === ChannelState.STARTING) {
            try {
              if (currentChannel.getState() === ChannelState.STREAMING) {
                currentChannel.transitionTo(ChannelState.STOPPING);
              }
              currentChannel.transitionTo(ChannelState.IDLE);
              await this.channelRepository.update(channelId, { state: ChannelState.IDLE });
            } catch (stateError) {
              logger.warn({ channelId, stateError }, 'State transition issue during file transition');
            }
          }

          // === BETA APPROACH: Stream bumper as separate FFmpeg process ===
          // Seamless flow: File1 ends ? Stream Bumper ? Wait 500ms ? Start File2 ? Buffer segments
          // No playlist merging, no MEDIA-SEQUENCE juggling, just clean sequential streaming

          // Get channel configuration for bumper streaming
          const channel = this.channels.get(channelId);
          if (!channel) throw new Error('Channel not found');

          // Check if bumpers are enabled for this channel
          const includeBumpers = channel.config.includeBumpers !== false; // Default to true for backward compatibility

          // Check if we have a pre-generated bumper for the NEXT file
          let pregenMap = this.channelPregenBumpers.get(channelId);
          let bumperInfo = pregenMap?.get(nextIndex);

          logger.info(
            { channelId, hasBumperInfo: !!bumperInfo, includeBumpers, nextIndex, nextFile: nextFile.filename },
            'Checking for pre-generated bumper'
          );

          try {
            // If bumpers are enabled and we have a pre-generated bumper, stream it as separate FFmpeg process
            if (includeBumpers && bumperInfo?.segmentsDir && bumperInfo.segmentCount) {
              try {
                // Find the first bumper segment file
                const segmentFiles = await fs.readdir(bumperInfo.segmentsDir);
                const bumperFile = segmentFiles.find(f => f.endsWith('.ts') && f.startsWith('bumper_'));

                if (bumperFile) {
                  const bumperPath = path.join(bumperInfo.segmentsDir, bumperFile);

                  logger.info(
                    { channelId, bumperPath, nextFile: nextFile.filename },
                    'Streaming bumper between files'
                  );

                  // Stream bumper - blocks until finished
                  // FFmpeg will automatically detect transition point (no file-system race condition)
                  await this.ffmpegEngine.streamBumper(channelId, bumperPath, {
                    inputFile: bumperPath,
                    outputDir: channel.config.outputDir,
                    videoBitrate: channel.config.videoBitrate,
                    audioBitrate: channel.config.audioBitrate,
                    resolution: channel.config.resolution,
                    fps: channel.config.fps,
                    segmentDuration: channel.config.segmentDuration
                  });

                  logger.info({ channelId }, 'Bumper finished (FFmpeg handles discontinuity tags automatically)');

                  // Clean up bumper directory after use
                  setTimeout(async () => {
                    try {
                      await fs.rm(bumperInfo.segmentsDir, { recursive: true, force: true });
                      logger.debug({ channelId, segmentsDir: bumperInfo.segmentsDir }, 'Cleaned up bumper directory');

                      // Remove from pregen map
                      const m = this.channelPregenBumpers.get(channelId);
                      if (m) m.delete(nextIndex);
                    } catch {}
                  }, 2000);
                } else {
                  logger.warn({ channelId }, 'Bumper file not found, skipping bumper');
                }
              } catch (bumperError) {
                logger.error({ error: bumperError, channelId }, 'Bumper streaming failed, proceeding without bumper');
              }
            } else {
              if (!includeBumpers) {
                logger.debug({ channelId }, 'Bumpers disabled for this channel, skipping bumper');
              } else {
                logger.info({ channelId }, 'No bumper available, transitioning directly to next file');
              }
            }

            // Longer delay after bumper for Roku to process playlist changes
            // Roku needs time to fetch updated playlist and parse discontinuity tags
            await new Promise((resolve) => setTimeout(resolve, 1500));

            // Start next file (bumper has finished)
            logger.info({ channelId, nextIndex, nextFile: nextFile.filename }, 'Starting next file after bumper');

            await this.startChannel(channelId, nextIndex);

            // Transition point for discontinuity tag injection is recorded automatically
            // when FFmpeg starts and detects a transition (first new segment written)

            // Pre-generate bumper for the NEXT transition (only if bumpers are enabled)
            if (includeBumpers) {
              // CRITICAL: Pass nextIndex so bumper is generated for the correct file!
              // Without it, preGenerateBumper reads stale/updated currentIndex from DB
              setTimeout(() => {
                this.preGenerateBumper(channelId, nextIndex).catch(() => {});
              }, 2000);
            }
          } catch (error) {
            logger.error({ error, channelId, stack: error instanceof Error ? error.stack : undefined }, 'CRITICAL: Transition failed, attempting recovery');
            // Fallback: try to start next file
            try {
              await this.startChannel(channelId, nextIndex);
              logger.info({ channelId }, 'Recovery startChannel succeeded');
            } catch (recoveryError) {
              logger.error({ error: recoveryError, channelId }, 'FATAL: Recovery startChannel also failed');
            }
          }
        } catch (error) {
          logger.error(
            { error, channelId },
            'Failed to transition to next file'
          );
          const currentChannel = this.channels.get(channelId);
          if (currentChannel) {
            currentChannel.setError(error instanceof Error ? error.message : String(error));
            await this.channelRepository.update(channelId, {
              last_error: error instanceof Error ? error.message : String(error),
              last_error_at: new Date(),
            });
          }
        }
      };
      
      // Start FFmpeg for single file with callback for when file finishes
      // FFmpeg's discont_start flag automatically handles discontinuity tags at transitions
      await this.ffmpegEngine.start(channelId, streamConfig, onFileEnd);
      
      logger.info(
        { channelId },
        'FFmpeg started (discontinuity tags handled automatically by FFmpeg discont_start flag)'
      );
      
      logger.info(
        {
          channelId,
          expectedSegments: expectedSegmentCount,
          note: 'Segment numbering managed automatically by append_list flag'
        },
        'File streaming started'
      );


      // Transition to STREAMING
      channel.transitionTo(ChannelState.STREAMING);
      await this.channelRepository.update(channelId, {
        state: ChannelState.STREAMING,
        started_at: new Date(),
      });

      // Create playback session
      const virtualTimeState = await this.virtualTimeService.getChannelVirtualTime(channelId);
      const virtualTimeAtStart = virtualTimeState?.totalVirtualSeconds || 0;
      const sessionType: import('../../infrastructure/database/repositories/PlaybackSessionRepository').SessionType =
        shouldUseVirtualTime ? 'resumed' : 'started';

      const sessionId = await this.playbackSessionRepository.create({
        channelId,
        sessionStart: new Date(),
        virtualTimeAtStart,
        sessionType,
        triggeredBy: startIndex !== undefined ? 'manual' : 'automatic',
      });

      this.activeSessionIds.set(channelId, sessionId);

      logger.info(
        { channelId, sessionId, sessionType, virtualTimeAtStart },
        'Playback session started'
      );

      logger.info(
        { channelId, file: media[actualStartIndex].filename },
        'Channel started streaming'
      );

      // Schedule bumper pre-generation for optimal timing (only if bumpers are enabled)
      const includeBumpers = channel.config.includeBumpers !== false; // Default to true for backward compatibility
      
      if (includeBumpers) {
        // Generate bumper 60 seconds before file ends (or immediately if file is short)
        const bumperPregenDelay = Math.max(1000, (remainingDuration - 60) * 1000);
        
        logger.info(
          { 
            channelId, 
            remainingDuration, 
            bumperPregenDelaySeconds: Math.floor(bumperPregenDelay / 1000),
            willPregenerateAt: new Date(Date.now() + bumperPregenDelay).toISOString()
          },
          'Scheduled bumper pre-generation'
        );
        
        setTimeout(() => {
          logger.info({ channelId }, 'Starting bumper pre-generation (60s before file end)');
          this.preGenerateBumper(channelId, actualStartIndex).catch((err) => {
            logger.warn({ error: err, channelId }, 'Bumper pre-generation failed (non-fatal)');
          });
        }, bumperPregenDelay);
      } else {
        logger.debug({ channelId }, 'Bumpers disabled, skipping bumper pre-generation');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      channel.setError(errorMessage);
      await this.channelRepository.update(channelId, {
        state: ChannelState.ERROR,
        last_error: errorMessage,
        last_error_at: new Date(),
      });
      logger.error({ error, channelId }, 'Failed to start channel');
      throw error;
    }
  }

  /**
   * Stop streaming a channel
   */
  public async stopChannel(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    if (!channel.isStreaming()) {
      logger.warn({ channelId, state: channel.getState() }, 'Channel is not streaming');
      return;
    }

    try {
      channel.transitionTo(ChannelState.STOPPING);
      await this.channelRepository.update(channelId, { state: ChannelState.STOPPING });

      // Stop FFmpeg - wrap in try-catch to handle errors gracefully
      // Note: FFmpeg errors during stop are expected (how we pause streams)
      try {
        await this.ffmpegEngine.stop(channelId);
        logger.debug({ channelId }, 'FFmpeg stop completed');
      } catch (ffmpegError) {
        logger.warn(
          { error: ffmpegError, channelId },
          'FFmpeg stop error (continuing with channel stop)'
        );
        // Continue anyway - channel state will be updated
      }

      // End playback session if one is active
      const sessionId = this.activeSessionIds.get(channelId);
      if (sessionId) {
        try {
          const virtualTimeState = await this.virtualTimeService.getChannelVirtualTime(channelId);
          const virtualTimeAtEnd = virtualTimeState?.totalVirtualSeconds || 0;

          await this.playbackSessionRepository.endSession(sessionId, {
            sessionEnd: new Date(),
            virtualTimeAtEnd,
          });

          this.activeSessionIds.delete(channelId);

          logger.info(
            { channelId, sessionId, virtualTimeAtEnd },
            'Playback session ended'
          );
        } catch (sessionError) {
          logger.warn({ error: sessionError, channelId }, 'Failed to end playback session');
        }
      }

      channel.transitionTo(ChannelState.IDLE);
      await this.channelRepository.update(channelId, {
        state: ChannelState.IDLE,
        started_at: null,
      });

      // Pause virtual time if no viewers - CRITICAL for virtual time progression
      const viewerCount = channel.getMetadata().viewerCount;
      if (viewerCount === 0) {
        try {
          logger.info(
            { channelId, viewerCount },
            'Pausing virtual time (no viewers)'
          );
          const media = await this.getChannelMedia(channelId);
          await this.virtualTimeService.pauseVirtualTime(channelId, media);
        } catch (pauseError) {
          logger.error(
            { error: pauseError, channelId },
            'CRITICAL: Failed to pause virtual time - this will break virtual time progression!'
          );
          // Don't throw - we still want to mark channel as stopped
        }
      } else {
        logger.debug(
          { channelId, viewerCount },
          'Not pausing virtual time (viewers still present)'
        );
      }

      logger.info({ channelId }, 'Channel stopped');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      channel.setError(errorMessage);
      await this.channelRepository.update(channelId, {
        state: ChannelState.ERROR,
        last_error: errorMessage,
        last_error_at: new Date(),
      });
      
      // CRITICAL: Even if stop failed, pause virtual time if no viewers
      // This ensures virtual time progression is preserved even on errors
      try {
        const viewerCount = channel.getMetadata().viewerCount;
        if (viewerCount === 0) {
          logger.info(
            { channelId, viewerCount },
            'Pausing virtual time after stop error (no viewers)'
          );
          const media = await this.getChannelMedia(channelId);
          await this.virtualTimeService.pauseVirtualTime(channelId, media);
        }
      } catch (pauseError) {
        logger.error({ error: pauseError, channelId }, 'Failed to pause virtual time after stop error');
      }
      
      logger.error({ error, channelId }, 'Failed to stop channel');
      throw error;
    }
  }

  /**
   * Restart a channel
   */
  public async restartChannel(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    const currentIndex = channel.getMetadata().currentIndex;

    await this.stopChannel(channelId);
    await this.startChannel(channelId, currentIndex);

    logger.info({ channelId }, 'Channel restarted');
  }


  /**
   * Copy bumper segments to stream output and update playlist
   * Returns the last segment number used
   * 
   * LEGACY METHOD - Not used in new pipeline (bumpers stream separately)
   * Kept for reference only
   */
  // @ts-ignore - Unused in new pipeline
  private async insertBumperSegments(
    channelId: string,
    segmentsDir: string,
    segmentCount: number,
    startSegmentNumber: number
  ): Promise<number> {
    const channel = await this.getChannel(channelId);
    const outputDir = path.resolve(channel.config.outputDir);
    const playlistPath = path.join(outputDir, 'stream.m3u8');

    logger.info(
      { channelId, segmentsDir, segmentCount, startSegmentNumber },
      'Copying bumper segments to stream output'
    );

    try {
      // Verify bumper directory exists before trying to read it
      try {
        await fs.access(segmentsDir);
      } catch (error) {
        logger.error(
          { channelId, segmentsDir, error },
          'Bumper directory does not exist, bumper generation may have failed'
        );
        throw new Error(`Bumper directory not found: ${segmentsDir}`);
      }

      // Read bumper segments
      const bumperFiles = await fs.readdir(segmentsDir);
      const bumperSegments = bumperFiles
        .filter(f => f.endsWith('.ts'))
        .sort();

      if (bumperSegments.length === 0) {
        throw new Error('No bumper segments found');
      }

      // Read current playlist to get existing segments
      let playlistContent = '';
      let lastSegmentNumber = startSegmentNumber - 1;
      try {
        playlistContent = await fs.readFile(playlistPath, 'utf-8');
        // Find the last segment number in the playlist
        const segmentMatches = playlistContent.matchAll(/stream_(\d+)\.ts/g);
        for (const match of segmentMatches) {
          const segNum = parseInt(match[1], 10);
          if (segNum > lastSegmentNumber) {
            lastSegmentNumber = segNum;
          }
        }
      } catch {
        // Playlist doesn't exist yet, start from 0
        lastSegmentNumber = -1;
      }

      // Copy bumper segments with continuous numbering
      // Validate segment sizes before copying to catch corruption/issues
      const copiedSegments: string[] = [];
      const maxExpectedSegmentSize = 10 * 1024 * 1024; // 10MB max per segment (normal is ~1-2MB)
      const minExpectedSegmentSize = 50 * 1024; // 50KB minimum
      
      for (let i = 0; i < bumperSegments.length; i++) {
        const bumperSegment = bumperSegments[i];
        const bumperSegmentPath = path.join(segmentsDir, bumperSegment);
        const newSegmentNumber = lastSegmentNumber + 1 + i;
        const newSegmentName = `stream_${newSegmentNumber.toString().padStart(3, '0')}.ts`;
        const newSegmentPath = path.join(outputDir, newSegmentName);

        // Validate source segment size before copying
        try {
          const sourceStats = await fs.stat(bumperSegmentPath);
          const sourceSize = sourceStats.size;
          
          if (sourceSize > maxExpectedSegmentSize) {
            logger.error(
              { 
                channelId, 
                bumperSegment, 
                sourceSize, 
                maxExpectedSize: maxExpectedSegmentSize,
                sizeMB: (sourceSize / 1024 / 1024).toFixed(2)
              },
              'Bumper segment file is abnormally large, skipping copy'
            );
            throw new Error(`Bumper segment ${bumperSegment} is too large (${(sourceSize / 1024 / 1024).toFixed(2)}MB), possible corruption`);
          }
          
          if (sourceSize < minExpectedSegmentSize) {
            logger.error(
              { 
                channelId, 
                bumperSegment, 
                sourceSize, 
                minExpectedSize: minExpectedSegmentSize
              },
              'Bumper segment file is abnormally small, skipping copy'
            );
            throw new Error(`Bumper segment ${bumperSegment} is too small (${sourceSize} bytes), possible corruption`);
          }

          // Copy segment file
          await fs.copyFile(bumperSegmentPath, newSegmentPath);
          
          // Verify copied file size matches
          const destStats = await fs.stat(newSegmentPath);
          if (destStats.size !== sourceSize) {
            logger.error(
              { channelId, sourceSize, destSize: destStats.size, bumperSegment, newSegmentName },
              'Copied segment size mismatch, removing corrupted copy'
            );
            await fs.unlink(newSegmentPath).catch(() => {});
            throw new Error(`Copy verification failed: size mismatch`);
          }
          
          copiedSegments.push(newSegmentName);
          
          logger.debug(
            { 
              channelId, 
              from: bumperSegment, 
              to: newSegmentName, 
              sizeKB: (sourceSize / 1024).toFixed(0) 
            },
            'Copied and verified bumper segment'
          );
        } catch (error) {
          logger.error(
            { 
              error, 
              channelId, 
              bumperSegment, 
              newSegmentName,
              stack: error instanceof Error ? error.stack : undefined
            },
            'Failed to copy bumper segment, aborting bumper insertion'
          );
          // Clean up any partial copies
          for (const seg of copiedSegments) {
            try {
              await fs.unlink(path.join(outputDir, seg));
            } catch {
              // Ignore cleanup errors
            }
          }
          throw error; // Re-throw to trigger fallback
        }
      }

      // Get bumper segment durations
      // Since we generate a single MPEG-TS file with 5-second duration (not HLS segments),
      // we use 5 seconds per segment instead of trying to read a non-existent playlist
      let segmentDurations: number[] = [];
      try {
        // Try to read playlist if it exists (for backwards compatibility with old HLS segment generation)
        const bumperPlaylistPath = path.join(segmentsDir, 'playlist.m3u8');
        const bumperPlaylist = await fs.readFile(bumperPlaylistPath, 'utf-8');
        const durationMatches = bumperPlaylist.matchAll(/#EXTINF:([\d.]+)/g);
        for (const match of durationMatches) {
          segmentDurations.push(parseFloat(match[1]));
        }
      } catch {
        // No playlist file (single MPEG-TS generation) - bumpers are always 10 seconds
        segmentDurations = copiedSegments.map(() => 10.0); // 10-second bumper
      }

      // Note: Bumpers now stream as separate FFmpeg processes (not copied to playlist)
      // This old method is preserved for reference but no longer used in the new pipeline

      const lastUsedSegment = lastSegmentNumber + copiedSegments.length;
      logger.info(
        { channelId, segmentCount: copiedSegments.length, lastSegment: lastUsedSegment },
        'Bumper segments copied (legacy method - not used in new pipeline)'
      );

      return lastUsedSegment;
    } catch (error) {
      logger.error({ error, channelId, segmentsDir }, 'Failed to copy bumper segments');
      throw error;
    }
  }

  /**
   * Clear old segment files and playlist to start fresh
   * DISABLED - Let FFmpeg manage segments naturally
   */
  // @ts-ignore
  private async _clearOldSegments_disabled(outputDir: string, channelId: string): Promise<void> {
    try {
      logger.debug({ channelId, outputDir }, 'Clearing old segments for initial start');
      
      // Initial start: remove ALL old segments and playlist
      const files = await fs.readdir(outputDir);
      let removedCount = 0;
      
      for (const file of files) {
        // Remove all .ts segments and .m3u8 playlists
        if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
          try {
            await fs.unlink(path.join(outputDir, file));
            removedCount++;
          } catch (error) {
            logger.warn({ channelId, file, error }, 'Failed to remove old file');
          }
        }
      }
      
      logger.info(
        { channelId, removedFiles: removedCount, outputDir },
        'Cleared old segments for initial start'
      );
    } catch (error) {
      logger.error({ error, channelId, outputDir }, 'Failed to clear old segments (non-fatal)');
      // Don't throw - continue with start even if cleanup fails
    }
  }

  /**
   * UNUSED with append_list approach - kept for reference
   * Create initial placeholder playlist (beta approach)
   * Creates a playlist with 5 placeholder segments to give viewers immediate content
   * while FFmpeg initializes and generates real segments
   *
   * @param channelId - Channel ID
   * @param outputDir - Output directory
   * @param channel - Channel entity
   */
  // @ts-ignore - Intentionally unused, kept for reference
  private async _createInitialPlaceholderPlaylist_unused(
    channelId: string,
    outputDir: string,
    channel: Channel
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });

    // Generate/reuse single placeholder segment file
    const placeholderDir = path.join(config.paths.temp, 'bumpers', 'placeholders');
    await fs.mkdir(placeholderDir, { recursive: true });
    const placeholderPath = path.join(placeholderDir, 'starting.ts');

    // Generate placeholder if it doesn't exist
    const [width, height] = channel.config.resolution.split('x').map(Number);
    const placeholderFileExists = await fs.access(placeholderPath).then(() => true).catch(() => false);
    
    if (!placeholderFileExists) {
      logger.debug({ channelId, placeholderPath }, 'Generating placeholder segment');
      await this.bumperGenerator.generateSinglePlaceholderSegment(
        placeholderPath,
        'Stream Starting...',
        channel.config.segmentDuration,
        width,
        height,
        channel.config.fps,
        channel.config.videoBitrate,
        channel.config.audioBitrate
      );
    }

    // Copy placeholder to channel output directory
    const localPlaceholderName = 'starting.ts';
    const localPlaceholderPath = path.join(outputDir, localPlaceholderName);
    await fs.copyFile(placeholderPath, localPlaceholderPath);

    // Create playlist with 5 placeholder segments (matches beta)
    const numSegments = 5;
    const targetDuration = Math.ceil(channel.config.segmentDuration);
    const now = new Date();
    const playlistPath = path.join(outputDir, 'stream.m3u8');

    let playlist = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-ALLOW-CACHE:NO
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-PLAYLIST-TYPE:EVENT
`;

    // Add placeholder segments in a loop
    for (let i = 0; i < numSegments; i++) {
      const segmentTime = new Date(now.getTime() + (i * channel.config.segmentDuration * 1000));
      playlist += `#EXTINF:${channel.config.segmentDuration.toFixed(6)},\n`;
      playlist += `#EXT-X-PROGRAM-DATE-TIME:${segmentTime.toISOString()}\n`;
      playlist += `${localPlaceholderName}\n`;
    }

    // Mark discontinuity for when FFmpeg's real segments appear
    playlist += `#EXT-X-DISCONTINUITY\n`;

    await fs.writeFile(playlistPath, playlist);
    
    logger.debug({ channelId, numSegments }, 'Created startup playlist with placeholders');
  }

  /**
   * UNUSED with append_list approach - kept for reference
   * Clean up ALL old segments and playlist before starting a new file
   * This prevents old bumper/file segments from interfering with buffer detection
   *
   * @param channelId - Channel ID
   * @param outputDir - Output directory path
   */
  // @ts-ignore - Intentionally unused, kept for reference
  private async _cleanupAllSegments_unused(channelId: string, outputDir: string): Promise<void> {
    try {
      const files = await fs.readdir(outputDir);
      const segments = files.filter(f => f.endsWith('.ts') && f.startsWith('stream_'));

      let deletedCount = 0;
      for (const segment of segments) {
        try {
          const segmentPath = path.join(outputDir, segment);
          await fs.unlink(segmentPath);
          deletedCount++;
        } catch (err) {
          // Continue on error
        }
      }

      // Delete old playlist file
      const playlistPath = path.join(outputDir, 'stream.m3u8');
      try {
        await fs.unlink(playlistPath);
      } catch {
        // Playlist might not exist
      }

      logger.info({ channelId, deletedCount }, 'Cleaned up old segments');
    } catch (err) {
      logger.warn({ channelId, error: err }, 'Cleanup failed (non-fatal)');
    }
  }

  /**
   * UNUSED with append_list approach - kept for reference
   * Get current segment count from playlist
   * Used for baseline counting to detect new segments
   *
   * @param outputDir - Output directory path
   * @returns Number of segments in playlist
   */
  // @ts-ignore - Intentionally unused, kept for reference
  private async _getCurrentSegmentCount_unused(outputDir: string): Promise<number> {
    try {
      const playlistPath = path.join(outputDir, 'stream.m3u8');
      const content = await fs.readFile(playlistPath, 'utf-8');
      const matches = content.match(/\.ts/g) || [];
      return matches.length;
    } catch {
      return 0; // Playlist doesn't exist or can't be read
    }
  }

  /**
   * UNUSED with append_list approach - kept for reference
   * Wait for NEW segments to be generated after starting FFmpeg
   * Uses baseline counting to detect only new segments (not old ones from previous file/bumper)
   * This ensures seamless playback by buffering segments before transition completes
   *
   * @param channelId - Channel ID
   * @param requiredSegments - Number of NEW segments to wait for (default: 2)
   * @param timeout - Maximum wait time in ms (default: 15000)
   * @param baselineCount - Number of segments that existed before (default: 0)
   * @returns true if segments buffered, false if timeout
   */
  // @ts-ignore - Intentionally unused, kept for reference
  private async _waitForSegmentsToBuffer_unused(
    channelId: string,
    requiredSegments: number = 2,
    timeout: number = 15000,
    baselineCount: number = 0
  ): Promise<boolean> {
    const channel = await this.getChannel(channelId);
    const playlistPath = path.join(channel.config.outputDir, 'stream.m3u8');
    const startTime = Date.now();
    let lastCount = 0;
    let checkCount = 0;
    let currentBaseline = baselineCount;

    logger.info(
      { channelId, requiredSegments, timeout, baseline: baselineCount },
      '[BUFFER] Starting - waiting for NEW segments beyond baseline'
    );

    return new Promise((resolve) => {
      const checkSegments = async () => {
        checkCount++;
        const elapsed = Date.now() - startTime;

        try {
          // Check if playlist exists
          const playlistExists = await fs.access(playlistPath).then(() => true).catch(() => false);
          
          if (!playlistExists) {
            // Playlist doesn't exist yet, check again soon
            if (elapsed < timeout) {
              if (checkCount % 10 === 0) {
                logger.debug({ channelId, elapsed }, '[BUFFER] Waiting for playlist...');
              }
              setTimeout(checkSegments, 200);
            } else {
              logger.warn({ channelId, elapsed }, '[BUFFER] TIMEOUT: No playlist created');
              resolve(false);
            }
            return;
          }

          // Read playlist and count segments
          const content = await fs.readFile(playlistPath, 'utf-8');
          const totalSegmentCount = (content.match(/\.ts/g) || []).length;
          
          // If fresh playlist was created (total < baseline), reset baseline
          // This handles cases where FFmpeg creates a brand new playlist
          if (totalSegmentCount < currentBaseline) {
            logger.debug(
              { channelId, totalSegmentCount, oldBaseline: currentBaseline },
              '[BUFFER] Detected fresh playlist, resetting baseline'
            );
            currentBaseline = totalSegmentCount;
            lastCount = 0;
          }
          
          // Calculate NEW segments beyond baseline
          const newSegments = Math.max(0, totalSegmentCount - currentBaseline);
          const isProgress = newSegments > lastCount;

          // Log progress
          if (isProgress || checkCount % 5 === 0) {
            logger.debug(
              { 
                channelId, 
                checkCount, 
                elapsed, 
                total: totalSegmentCount,
                baseline: currentBaseline,
                new: newSegments,
                need: requiredSegments
              },
              '[BUFFER] Checking segments'
            );
          }

          if (isProgress) {
            lastCount = newSegments;
          }

          if (newSegments >= requiredSegments) {
            logger.info(
              { channelId, newSegments, elapsed },
              '[BUFFER] SUCCESS: Segments buffered successfully - transition seamless'
            );
            resolve(true);
          } else if (elapsed < timeout) {
            // Not enough NEW segments yet, keep checking
            setTimeout(checkSegments, 200);
          } else {
            logger.warn(
              { channelId, newSegments, requiredSegments, elapsed },
              '[BUFFER] TIMEOUT: Not enough new segments buffered (continuing anyway)'
            );
            resolve(false);
          }
        } catch (error) {
          logger.error({ error, channelId }, '[BUFFER] Error checking segments');
          if (elapsed < timeout) {
            setTimeout(checkSegments, 200);
          } else {
            resolve(false);
          }
        }
      };

      checkSegments();
    });
  }

  /**
   * UNUSED with append_list approach - discont_start flag handles this automatically
   * Inject EXT-X-DISCONTINUITY tag at file transition point
   *
   * RFC 8216 compliance: Section 6.3.3 requires discontinuity tags when
   * encoding parameters change (which they do at every file transition).
   *
   * This method:
   * 1. Reads the current playlist
   * 2. Finds the first segment of the new file
   * 3. Inserts EXT-X-DISCONTINUITY tag before it
   * 4. Updates discontinuity sequence counter
   * 5. Writes modified playlist back
   *
   * @param channelId - Channel ID
   * @param firstNewSegmentNumber - Segment number where new file starts
   */
  // @ts-ignore - Intentionally unused, kept for reference
  private async _injectDiscontinuityTag_unused(
    channelId: string,
    firstNewSegmentNumber: number
  ): Promise<void> {
    // Check if discontinuity tracking is enabled
    if (!config.hls.insertDiscontinuityTags) {
      logger.debug({ channelId }, 'Discontinuity tag insertion disabled in config');
      return;
    }

    try {
      const channel = await this.getChannel(channelId);
      const playlistPath = path.join(channel.config.outputDir, 'stream.m3u8');

      // Check if playlist exists
      const playlistExists = await fs.access(playlistPath).then(() => true).catch(() => false);
      if (!playlistExists) {
        logger.warn(
          { channelId, playlistPath },
          'Cannot inject discontinuity tag - playlist does not exist'
        );
        return;
      }

      // Read current playlist
      let playlistContent = await fs.readFile(playlistPath, 'utf-8');

      // Get or initialize discontinuity count for this channel
      const currentDiscCount = this.channelDiscontinuityCount.get(channelId) || 0;
      const newDiscCount = currentDiscCount + 1;

      // Inject discontinuity tag before the first segment of new file
      playlistContent = this.playlistManipulator.insertDiscontinuityBeforeSegment(
        playlistContent,
        firstNewSegmentNumber
      );

      // Add discontinuity sequence tag if tracking is enabled
      if (config.hls.discontinuityTracking) {
        playlistContent = this.playlistManipulator.addDiscontinuitySequence(
          playlistContent,
          newDiscCount
        );
      }

      // Write modified playlist back
      await fs.writeFile(playlistPath, playlistContent);

      // Update discontinuity count
      this.channelDiscontinuityCount.set(channelId, newDiscCount);

      logger.info(
        {
          channelId,
          firstNewSegmentNumber,
          discontinuitySequence: newDiscCount,
        },
        'Injected EXT-X-DISCONTINUITY tag at file transition (RFC 8216 compliance)'
      );

      // Validate the result
      const validation = this.playlistManipulator.validateDiscontinuityTags(playlistContent);
      if (!validation.valid) {
        logger.warn(
          {
            channelId,
            issues: validation.issues,
            suggestions: validation.suggestions,
          },
          'Playlist discontinuity validation found issues'
        );
      }
    } catch (error) {
      logger.error(
        { error, channelId, firstNewSegmentNumber },
        'Failed to inject discontinuity tag (non-fatal)'
      );
    }
  }

  /**
   * Pre-generate bumper for next file in background
   * Generates both MP4 and HLS segments for fast transition
   * @param channelId - Channel ID
   * @param currentFileIndex - Optional: current file index (overrides DB value). Use this when calling after startChannel to avoid stale DB index.
   */
  private async preGenerateBumper(channelId: string, currentFileIndex?: number): Promise<void> {
    try {
      const channel = await this.getChannel(channelId);
      const media = await this.getChannelMedia(channelId);

      if (media.length === 0) return;

      // Use provided index if available (more reliable after restart), otherwise fall back to DB
      const currentIndex = currentFileIndex !== undefined ? currentFileIndex : channel.getMetadata().currentIndex;
      const nextIndex = (currentIndex + 1) % media.length;
      const nextFile = media[nextIndex];

      logger.info(
        { channelId, nextFile: nextFile.filename, currentIndex, nextIndex },
        'Pre-generating bumper for next file'
      );

      // Always clear any existing cached bumper for this index
      // Don't cache bumpers - always regenerate fresh to avoid stale directory references
      const pregenForChannel = this.channelPregenBumpers.get(channelId);
      if (pregenForChannel?.has(nextIndex)) {
        const existingForIndex = pregenForChannel.get(nextIndex);
        logger.debug({ channelId, nextIndex, oldDir: existingForIndex?.segmentsDir }, 'Clearing cached bumper entry (will regenerate fresh)');
        pregenForChannel.delete(nextIndex);

        // Clean up old directory if it exists
        if (existingForIndex?.segmentsDir) {
          setTimeout(async () => {
            try {
              await fs.rm(existingForIndex.segmentsDir, { recursive: true, force: true });
              logger.debug({ channelId, segmentsDir: existingForIndex.segmentsDir }, 'Cleaned up old pre-generated bumper directory');
            } catch {}
          }, 100);
        }
      }

      // Generate HLS segments directly (no intermediate MP4)
      const generationStartTime = Date.now();
      this.bumperGenerator.generateUpNextBumperSegments({
        showName: nextFile.info.showName,
        episodeName: nextFile.info.title || nextFile.getDisplayName(),
        duration: 10, // 10 second bumper (gives FFmpeg time to generate next file's segments)
        resolution: channel.config.resolution,
        fps: channel.config.fps,
        videoBitrate: channel.config.videoBitrate,
        audioBitrate: channel.config.audioBitrate,
      }).then(({ segmentsDir, segmentCount }) => {
        // Store bumper segments info for the specific target index
        let map = this.channelPregenBumpers.get(channelId);
        if (!map) {
          map = new Map();
          this.channelPregenBumpers.set(channelId, map);
        }
        map.set(nextIndex, { segmentsDir, segmentCount });
        const generationTime = Date.now() - generationStartTime;
        logger.info(
          { 
            channelId, 
            segmentsDir, 
            segmentCount, 
            nextFile: nextFile.filename,
            generationTimeMs: generationTime,
            nextIndex 
          },
          'Bumper segments pre-generated successfully'
        );
      }).catch((error) => {
        const generationTime = Date.now() - generationStartTime;
        logger.error({ 
          error, 
          channelId, 
          nextFile: nextFile.filename,
          generationTimeMs: generationTime,
          nextIndex,
          stack: error instanceof Error ? error.stack : undefined
        }, 'Failed to pre-generate bumper segments (non-fatal)');
        // Remove partial bumper info if it exists
        // If a partial entry exists for this index, remove it
        const map = this.channelPregenBumpers.get(channelId);
        if (map && map.has(nextIndex)) {
          const info = map.get(nextIndex)!;
          if (!info.segmentsDir || !info.segmentCount) {
            map.delete(nextIndex);
          }
        }
      });
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to pre-generate bumper (non-fatal)');
      // Don't throw - bumper generation failure shouldn't stop streaming
    }
  }

  /**
   * Move to next media file
   */
  public async nextFile(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    const media = await this.getChannelMedia(channelId);
    const currentIndex = channel.getMetadata().currentIndex;
    const nextIndex = (currentIndex + 1) % media.length;

    if (channel.isStreaming()) {
      await this.stopChannel(channelId);
      await this.startChannel(channelId, nextIndex);
    } else {
      channel.updateCurrentIndex(nextIndex);
      await this.channelRepository.update(channelId, {
        current_index: nextIndex,
      });
    }

    logger.info({ channelId, nextIndex }, 'Moved to next file');
  }

  /**
   * Set specific file index
   */
  public async setFileIndex(channelId: string, index: number): Promise<void> {
    const channel = await this.getChannel(channelId);
    const media = await this.getChannelMedia(channelId);

    if (index < 0 || index >= media.length) {
      throw new ValidationError(`Invalid index: ${index}`);
    }

    const wasStreaming = channel.isStreaming();

    if (wasStreaming) {
      await this.stopChannel(channelId);
      await this.startChannel(channelId, index);
    } else {
      channel.updateCurrentIndex(index);
      await this.channelRepository.update(channelId, {
        current_index: index,
      });
    }

    logger.info({ channelId, index }, 'File index updated');
  }

  /**
   * Handle viewer connection
   * Resumes streaming if paused due to no viewers
   */
  public async onViewerConnect(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    // Cancel any pending pause timer
    const pauseTimer = this.pauseTimers.get(channelId);
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      this.pauseTimers.delete(channelId);
      logger.info({ channelId }, 'Viewer reconnected, cancelled pause timer');
    }

    // Handle orphaned states dynamically (STOPPING, ERROR)
    const currentState = channel.getState();
    if (currentState === ChannelState.STOPPING || currentState === ChannelState.ERROR) {
      logger.info(
        { channelId, currentState },
        'Resetting orphaned state to IDLE on viewer connect'
      );

      channel.transitionTo(ChannelState.IDLE);
      await this.channelRepository.update(channelId, {
        state: ChannelState.IDLE,
      });
    }

    // Increment viewer count
    const newCount = channel.getMetadata().viewerCount + 1;
    channel.incrementViewerCount();
    await this.channelRepository.update(channelId, {
      viewer_count: newCount,
    });

    // If this is the first viewer and channel is not streaming, start streaming
    // This handles both: (1) resuming after pause (uses EPG to determine unpause position), and (2) starting fresh on demand
    if (newCount === 1 && !channel.isStreaming()) {
      const virtualTime = await this.virtualTimeService.getChannelVirtualTime(channelId);
      const isResuming = virtualTime?.virtualPausedAt !== null;
      logger.info(
        { 
          channelId, 
          isResuming,
          willUseEPG: isResuming || channel.isIdle()
        }, 
        `First viewer connected, ${isResuming ? 'unpausing stream' : 'starting stream'} (will use EPG to determine position if available)`
      );

      // Initialize or check virtual time state
      if (!virtualTime || !virtualTime.virtualStartTime) {
        // Initialize virtual timeline for new channel
        await this.virtualTimeService.initializeVirtualTimeline(channelId);
      }
      
      logger.debug(
        {
          channelId,
          hasVirtualTime: !!virtualTime,
          virtualStartTime: virtualTime?.virtualStartTime?.toISOString(),
          virtualPausedAt: virtualTime?.virtualPausedAt?.toISOString(),
          totalVirtualSeconds: virtualTime?.totalVirtualSeconds,
          isResuming: isResuming,
        },
        'Virtual time state before unpausing (startChannel will use EPG to determine position)'
      );
      // Note: Don't call resumeVirtualTime here - let startChannel handle it
      // This ensures startChannel can detect paused state and use virtual position

      // Start streaming from virtual position
      await this.startChannel(channelId);
    }
  }

  /**
   * Handle viewer disconnection
   * Pauses streaming after 200 seconds if last viewer leaves
   */
  public async onViewerDisconnect(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);

    // Decrement viewer count
    const newCount = Math.max(0, channel.getMetadata().viewerCount - 1);
    channel.decrementViewerCount();
    await this.channelRepository.update(channelId, {
      viewer_count: newCount,
    });

    // If last viewer disconnected, schedule stream pause after grace period
    if (newCount === 0 && channel.isStreaming()) {
      const gracePeriodSeconds = config.viewer.disconnectGracePeriod;
      const gracePeriodMs = gracePeriodSeconds * 1000;
      
      logger.info(
        { channelId, gracePeriodSeconds },
        'Last viewer disconnected, will pause stream after grace period'
      );

      // Set configurable grace period before pausing (default 45 seconds)
      const pauseTimer = setTimeout(async () => {
        try {
          // Verify no viewers reconnected during grace period
          const currentChannel = await this.getChannel(channelId);
          const currentCount = currentChannel.getMetadata().viewerCount;

          if (currentCount === 0 && currentChannel.isStreaming()) {
            logger.info(
              { channelId },
              'Grace period expired with no viewers, pausing stream'
            );

            // Pause virtual time BEFORE stopping - this ensures it happens even if stopChannel fails
            // This is the critical hook for virtual time progression
            try {
              logger.info(
                { channelId },
                'Pausing virtual time (grace period expired, no viewers)'
              );
              const media = await this.getChannelMedia(channelId);
              await this.virtualTimeService.pauseVirtualTime(channelId, media);
            } catch (pauseError) {
              logger.error(
                { error: pauseError, channelId },
                'CRITICAL: Failed to pause virtual time during grace period pause'
              );
            }

            // Stop streaming (FFmpeg errors during stop are expected)
            await this.stopChannel(channelId);
          } else {
            logger.info(
              { channelId, viewerCount: currentCount },
              'Viewers reconnected during grace period, keeping stream active'
            );
          }

          // Clean up timer reference
          this.pauseTimers.delete(channelId);
        } catch (error) {
          logger.error({ error, channelId }, 'Error during grace period pause');
        }
      }, gracePeriodMs);

      // Store timer so it can be cancelled if viewer reconnects
      this.pauseTimers.set(channelId, pauseTimer);
    }
  }

  /**
   * Restore a channel from saved state (for backward compatibility)
   * This bypasses normal validation to restore channels with existing IDs
   */
  public async restoreChannel(channel: Channel): Promise<void> {
    // Check if channel with this ID already exists in cache
    const existingById = this.channels.get(channel.id);
    if (existingById) {
      logger.warn({ channelId: channel.id }, 'Channel already exists in cache, skipping restore');
      return;
    }

    // Check database for existing channel by ID
    const existingByIdInDb = await this.channelRepository.findById(channel.id);
    if (existingByIdInDb) {
      logger.warn({ channelId: channel.id }, 'Channel already exists in database, skipping restore');
      // Load into cache
      const restoredChannel = ChannelRepository.rowToChannel(existingByIdInDb);
      this.channels.set(channel.id, restoredChannel);
      return;
    }

    // Check database for existing channel by slug
    const existingBySlug = await this.channelRepository.findBySlug(channel.config.slug);
    if (existingBySlug) {
      logger.warn(
        { channelId: channel.id, slug: channel.config.slug },
        'Channel with slug already exists in database, skipping restore'
      );
      return;
    }

    // Save to database and cache
    try {
      await this.channelRepository.create(channel);
      this.channels.set(channel.id, channel);
      logger.info({ channelId: channel.id, slug: channel.config.slug }, 'Channel restored to database');
    } catch (error) {
      logger.error({ error, channelId: channel.id }, 'Failed to restore channel to database');
      throw error;
    }
  }

  /**
   * Cleanup all channels on shutdown
   */
  public async cleanup(): Promise<void> {
    logger.info('Cleaning up all channels');

    // Stop virtual time update loop
    if (this.virtualTimeUpdateInterval) {
      clearInterval(this.virtualTimeUpdateInterval);
      this.virtualTimeUpdateInterval = null;
    }

    // Clear all pending pause timers
    for (const [channelId, timer] of this.pauseTimers.entries()) {
      clearTimeout(timer);
      logger.debug({ channelId }, 'Cleared pending pause timer during cleanup');
    }
    this.pauseTimers.clear();

    const streamingChannels = this.getAllChannels().filter((ch) => ch.isStreaming());

    await Promise.all(
      streamingChannels.map((ch) =>
        this.stopChannel(ch.id).catch((err) => {
          logger.error({ error: err, channelId: ch.id }, 'Error stopping channel');
        })
      )
    );

    await this.ffmpegEngine.cleanup();
    
    // Kill any active bumper generation processes
    this.bumperGenerator.killAllActiveGenerations();
  }
}
