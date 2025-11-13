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
import { ScheduleTimeService } from '../schedule-time/ScheduleTimeService';
import { BumperGenerator } from '../bumper/BumperGenerator';
// import { PlaylistManipulator } from '../playlist/PlaylistManipulator'; // UNUSED - kept for reference
import { PlaylistService } from '../playlist/PlaylistService';
import { EPGService } from '../epg/EPGService';
import { AsyncMutex } from '../../utils/AsyncMutex';
import { ConcatFileManager } from '../concat/ConcatFileManager';

const logger = createLogger('ChannelService');

export class ChannelService {
  // In-memory cache for fast access (synced with database)
  private channels: Map<string, Channel> = new Map()
  
  // UNUSED: Discontinuity tracking (kept for reference in _injectDiscontinuityTag_unused)
  // private channelDiscontinuityCount: Map<string, number> = new Map()
  
  // UNUSED: Playlist manipulator (kept for reference in _injectDiscontinuityTag_unused)
  // private playlistManipulator: PlaylistManipulator = new PlaylistManipulator();
  // Playlist service for transition tracking and tag injection
  // Note: This must be shared with route handlers to ensure transition points are visible
  public readonly playlistService: PlaylistService = new PlaylistService();
  private channelMedia: Map<string, MediaFile[]> = new Map();
  private readonly ffmpegEngine: FFmpegEngine;
  private readonly channelRepository: ChannelRepository;
  private readonly mediaFileRepository: MediaFileRepository;
  private readonly channelMediaRepository: ChannelMediaRepository;
  private readonly playbackSessionRepository: PlaybackSessionRepository;
  private readonly scheduleTimeService: ScheduleTimeService;
  private readonly bumperGenerator: BumperGenerator;
  private readonly epgService: EPGService;
  private readonly concatFileManager: ConcatFileManager;
  private bucketService?: any; // MediaBucketService - injected via setter
  private playlistResolver?: any; // PlaylistResolver - injected via setter

  // Grace period timers for pausing streams after inactivity
  private pauseTimers: Map<string, NodeJS.Timeout> = new Map();

  // Early-start timers: schedule next file to start 6 seconds before current file ends
  private earlyStartTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Track if early start has already happened for a channel (prevents onFileEnd from starting file again)
  private earlyStartCompleted: Set<string> = new Set();

  // Pre-generated bumpers keyed by the target file ID (not index, since dynamic playlists can change media order).
  // Note: In the new pipeline, bumpers are served directly in playlists during transition gaps
  private channelPregenBumpers: Map<string, Map<string, { segmentsDir: string; segmentCount: number }>> = new Map();
  
  // Track channels in transition state (file ended, serving bumper segments until next file starts)
  private channelsInTransition: Map<string, { nextFileId: string; transitionStartTime: number; bumperInjected: boolean }> = new Map();

  // Per-channel mutexes for transition state operations (prevents race conditions)
  private transitionMutexes: Map<string, AsyncMutex> = new Map();

  // Track active playback session IDs for each channel
  private activeSessionIds: Map<string, string> = new Map();

  // Track file progression for concat streams (maps channelId to progression tracker)
  private concatProgressionTrackers: Map<string, {
    startTime: number;
    mediaFiles: MediaFile[];
    currentFileIndex: number;
    intervalId: NodeJS.Timeout;
  }> = new Map();

  // Track active schedule block IDs for dynamic playlists (used to detect schedule transitions)
  private activeScheduleBlocks: Map<string, string> = new Map();

  constructor(ffmpegEngine: FFmpegEngine) {
    this.ffmpegEngine = ffmpegEngine;
    this.channelRepository = new ChannelRepository();
    this.mediaFileRepository = new MediaFileRepository();
    this.channelMediaRepository = new ChannelMediaRepository();
    this.scheduleTimeService = new ScheduleTimeService();
    this.bumperGenerator = new BumperGenerator();
    this.playbackSessionRepository = new PlaybackSessionRepository();
    this.epgService = new EPGService();
    this.concatFileManager = new ConcatFileManager();

    // Set ChannelService reference in PlaylistService for transition detection
    this.playlistService.setChannelService(this);

    // NOTE: No longer need virtual time update loop with schedule-based approach!
    // Position is calculated on-demand from schedule_start_time
  }

  // NOTE: Virtual time update loop removed - no longer needed with schedule-based approach
  // Position is calculated on-demand from schedule_start_time, no periodic updates required

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
   * Get or create mutex for a channel
   */
  private getMutexForChannel(channelId: string): AsyncMutex {
    let mutex = this.transitionMutexes.get(channelId);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.transitionMutexes.set(channelId, mutex);
    }
    return mutex;
  }

  /**
   * Get transition state for a channel (used by PlaylistService)
   * Returns bumper info if channel is in transition
   * 
   * Thread Safety: Uses per-channel mutex to prevent race conditions
   */
  public async getTransitionState(channelId: string): Promise<{ nextFileId: string; bumperInfo?: { segmentsDir: string; segmentCount: number }; bumperInjected: boolean } | null> {
    const mutex = this.getMutexForChannel(channelId);
    return await mutex.runExclusive(async () => {
      const transition = this.channelsInTransition.get(channelId);
      if (!transition) return null;

      const pregenMap = this.channelPregenBumpers.get(channelId);
      const bumperInfo = pregenMap?.get(transition.nextFileId);

      return {
        nextFileId: transition.nextFileId,
        bumperInfo: bumperInfo || undefined,
        bumperInjected: transition.bumperInjected
      };
    });
  }

  /**
   * Mark bumper as injected for a channel in transition
   * This prevents PlaylistService from re-injecting bumper on subsequent playlist requests
   * 
   * Thread Safety: Uses per-channel mutex to prevent race conditions
   */
  public async markBumperAsInjected(channelId: string): Promise<void> {
    const mutex = this.getMutexForChannel(channelId);
    return await mutex.runExclusive(async () => {
      const transition = this.channelsInTransition.get(channelId);
      if (transition) {
        transition.bumperInjected = true;
        this.channelsInTransition.set(channelId, transition);
      }
    });
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
   * 
   * With concat approach: Also updates the concat file if channel is streaming
   */
  public async invalidateChannelMediaCache(channelId: string): Promise<void> {
    this.channelMedia.delete(channelId);
    logger.debug({ channelId }, 'Channel media cache invalidated');
    
    // If channel is streaming with concat, update the concat file with new media list
    const channel = this.channels.get(channelId);
    if (channel && channel.isStreaming() && this.ffmpegEngine.isActive(channelId)) {
      try {
        const media = await this.getChannelMedia(channelId);
        if (media.length > 0) {
          const outputDir = path.resolve(channel.config.outputDir);
          const mediaFilePaths = media.map(m => m.path);
          const bumperPath = this.concatFileManager.getBumperPath(outputDir);
          
          await this.concatFileManager.updateConcatFile(
            channelId,
            outputDir,
            mediaFilePaths,
            bumperPath
          );
          
          // Update progression tracker with new media list
          const tracker = this.concatProgressionTrackers.get(channelId);
          if (tracker) {
            // Restart tracking with new media list
            // Use current index but no seek offset (0) since we're just updating the list
            this.stopConcatProgressionTracking(channelId);
            this.startConcatProgressionTracking(
              channelId,
              media,
              channel.getMetadata().currentIndex || 0,
              0, // No seek offset when updating media list
              channel
            );
          }
          
          logger.info(
            { channelId, mediaCount: media.length },
            'Updated concat file for media list change (dynamic playlist update)'
          );
        }
      } catch (error) {
        logger.warn(
          { channelId, error },
          'Failed to update concat file after media cache invalidation (non-fatal)'
        );
      }
    }
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
        // Prepare context for resolver
        const context = {
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
    startIndex?: number,
    isTransition: boolean = false
  ): Promise<void> {
    const channel = await this.getChannel(channelId);
    let media: MediaFile[] = [];

    // For dynamic playlists with PlaylistResolver, resolve media now based on schedule
    if (channel.config.useDynamicPlaylist && this.playlistResolver) {
      logger.debug({ channelId }, 'Dynamic playlist - resolving media from PlaylistResolver');
      try {
        media = await this.playlistResolver.resolveMedia(channelId, {
          currentTime: new Date(),
          currentIndex: startIndex || 0,
        });
        logger.info(
          { channelId, resolvedMediaCount: media.length },
          'Resolved media from PlaylistResolver for dynamic playlist'
        );
      } catch (error) {
        logger.error(
          { channelId, error },
          'Failed to resolve media from PlaylistResolver'
        );
        throw new ValidationError('Failed to resolve media for dynamic playlist');
      }
    } else {
      // For static playlists, get media from channel buckets
      media = await this.getChannelMedia(channelId);
    }

    // Handle orphaned states (STOPPING, ERROR) - reset to IDLE before starting
    // Also handle STARTING state if we're not in a transition (likely from state restoration)
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
    } else if (currentState === ChannelState.STARTING && !isTransition) {
      // STARTING state from previous failed start - reset to IDLE
      logger.info(
        { channelId, currentState },
        'Resetting orphaned STARTING state to IDLE before starting'
      );
      // STARTING can transition to IDLE according to state machine
      channel.transitionTo(ChannelState.IDLE);
      await this.channelRepository.update(channelId, {
        state: ChannelState.IDLE,
      });
    }

    // Validate state (allow transitions to bypass this check)
    // During transitions, keep channel in STREAMING state (don't change state)
    // The state machine doesn't allow STREAMING -> STARTING, so we bypass validation for transitions
    if (!isTransition && !channel.canTransitionTo(ChannelState.STARTING)) {
      throw new ConflictError(`Channel is already ${channel.getState()}`);
    }
    
    // During transitions, don't change state - keep it in STREAMING
    // We'll update it to STREAMING again after the new file starts
    if (!isTransition && channel.getState() !== ChannelState.STARTING) {
      // Only transition to STARTING for non-transition starts (and only if not already STARTING)
      channel.transitionTo(ChannelState.STARTING);
      await this.channelRepository.update(channelId, {
        state: ChannelState.STARTING,
      });
    }

    // Validate that media was resolved successfully
    if (media.length === 0) {
      if (channel.config.useDynamicPlaylist) {
        throw new ValidationError('No media available from schedule blocks for dynamic playlist');
      } else {
        throw new ValidationError('Channel has no media files');
      }
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
      // Transition to STARTING (only if not already in transition and not already STARTING)
      // During transitions, channel is already in STREAMING state, so skip this
      if (!isTransition && channel.getState() !== ChannelState.STARTING) {
        channel.transitionTo(ChannelState.STARTING);
        await this.channelRepository.update(channelId, {
          state: ChannelState.STARTING,
          started_at: new Date(),
        });
      } else if (!isTransition && channel.getState() === ChannelState.STARTING) {
        // Already in STARTING, just update timestamp
        await this.channelRepository.update(channelId, {
          started_at: new Date(),
        });
      }

      // Determine starting position
      // Use virtual time if resuming after pause (channel was paused)
      // During active streaming transitions, always start from beginning of file
      // Initialize with default to ensure it's always defined
      let actualStartIndex: number = startIndex ?? channel.getMetadata().currentIndex ?? 0;
      let seekToSeconds = 0;

      // Check if schedule time is initialized
      const hasScheduleTime = await this.scheduleTimeService.hasScheduleTime(channelId);

      // Log schedule time state
      logger.info(
        {
          channelId,
          hasScheduleTime,
          startIndex,
        },
        'Schedule time state check in startChannel'
      );

      // Use EPG/schedule time if:
      // 1. Schedule timeline exists (schedule_start_time is set)
      // 2. Not an explicit startIndex (automatic resume/start)
      const shouldUseScheduleTime = hasScheduleTime && startIndex === undefined;

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

      if (shouldUseScheduleTime) {
        // Use EPG as the single source of truth for position
        // EPG knows what should be playing now based on program schedule
        logger.debug(
          {
            channelId,
            mediaCount: media.length,
          },
          'Getting position from EPG (single source of truth)'
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
          logger.info(
            {
              channelId,
              epgFileIndex: epgPosition.fileIndex,
              epgSeekPosition: epgPosition.seekPosition,
              mediaCount: media.length,
              epgFileAtPosition: media[epgPosition.fileIndex]?.getDisplayName(),
              epgFileAtPositionFilename: media[epgPosition.fileIndex]?.filename,
            },
            'EPG position calculation result'
          );
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
            'EPG could not determine position, falling back to schedule time calculation'
          );
          
          const position = await this.scheduleTimeService.getCurrentPosition(
            channelId,
            media
          );
          logger.info(
            {
              channelId,
              scheduleFileIndex: position?.fileIndex,
              scheduleSeekPosition: position?.seekPosition,
              hasPosition: !!position,
              mediaCount: media.length,
              willUseIndex: position?.fileIndex || 0,
              fileAtFallbackIndex: media[position?.fileIndex || 0]?.getDisplayName(),
            },
            'Schedule time position calculation result (EPG fallback)'
          );
          actualStartIndex = position?.fileIndex || 0;
          seekToSeconds = position?.seekPosition || 0;

          logger.info(
            {
              channelId,
              scheduleIndex: actualStartIndex,
              schedulePosition: seekToSeconds,
              method: 'Schedule time fallback',
            },
            'Resuming from schedule time position (EPG fallback)'
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
      if (!hasScheduleTime) {
        await this.scheduleTimeService.initializeScheduleTime(channelId);
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
        // NOTE: No longer advancing virtual time - position calculated on-demand from schedule_start_time
      }

      // NOTE: No longer need to resume/pause virtual time with schedule-based approach

      const currentFile = media[actualStartIndex];

      // Calculate expected segment count for accurate end-of-file detection
      const fileDuration = currentFile.metadata.duration; // seconds
      const remainingDuration = Math.max(0, fileDuration - seekToSeconds);
      const expectedSegmentCount = Math.ceil(remainingDuration / channel.config.segmentDuration);
      const expectedEndTime = Date.now() + (remainingDuration * 1000); // milliseconds

      // Cancel any existing early-start timer for this channel
      const existingEarlyStartTimer = this.earlyStartTimers.get(channelId);
      if (existingEarlyStartTimer) {
        clearTimeout(existingEarlyStartTimer);
        this.earlyStartTimers.delete(channelId);
      }

      // NOTE: Early start logic disabled for concat approach
      // With concat demuxer, FFmpeg handles transitions automatically through the concat file
      // Early start would cause unnecessary FFmpeg restarts and frame duplication errors
      // The concat file already includes all files and bumpers, so no early start needed
      const useConcatApproach = true; // All streams now use concat approach
      
      // Schedule next file to start 6 seconds before current file ends (if remaining duration > 6 seconds)
      // Add 1 second buffer to account for timing variations and ensure segments are ready
      // DISABLED: Early start not needed with concat approach - FFmpeg handles transitions automatically
      if (false && remainingDuration > 7 && !isTransition && !useConcatApproach) {
        const earlyStartDelay = Math.max(0, (remainingDuration - 7) * 1000); // milliseconds (7s = 6s target + 1s buffer)
        const earlyStartTimer = setTimeout(async () => {
          try {
            // Clear the flag before starting (in case it was set from a previous transition)
            this.earlyStartCompleted.delete(channelId);
            await this.startNextFileEarly(channelId, actualStartIndex);
            // Mark early start as completed
            this.earlyStartCompleted.add(channelId);
          } catch (error) {
            logger.error({ error, channelId }, 'Failed to start next file early');
            // Clear flag on error so onFileEnd can handle transition normally
            this.earlyStartCompleted.delete(channelId);
          }
        }, earlyStartDelay);
        
        this.earlyStartTimers.set(channelId, earlyStartTimer);
        
        logger.info(
          {
            channelId,
            currentFile: currentFile.filename,
            remainingDuration,
            earlyStartDelayMs: earlyStartDelay,
            earlyStartTime: new Date(Date.now() + earlyStartDelay).toISOString(),
            expectedEndTime: new Date(expectedEndTime).toISOString(),
            note: 'Starting 7 seconds early (6s target + 1s buffer)'
          },
          'Scheduled next file to start 6 seconds before current file ends'
        );
      } else {
        logger.debug(
          { channelId, remainingDuration, isTransition },
          'Skipping early-start scheduling (duration too short or transition)'
        );
      }
      
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

      // Create stream config using concat approach
      const outputDir = path.resolve(channel.config.outputDir);

      // CRITICAL: Ensure output directory exists BEFORE creating concat file
      // Previously, FFmpegEngine.start() created this directory, but with concat approach
      // we need the directory to exist when writing concat.txt
      await fs.mkdir(outputDir, { recursive: true });
      logger.debug({ channelId, outputDir }, 'Created output directory for concat file');

      // CRITICAL: Clean up old HLS segments before starting (unless this is a transition)
      // Old segments from previous runs can cause confusion and playback issues
      // FFmpeg's delete_segments flag handles cleanup during streaming, but we need to start clean
      if (!isTransition) {
        try {
          const files = await fs.readdir(outputDir);
          const segments = files.filter(f => f.endsWith('.ts') && f.startsWith('stream_'));
          let deletedCount = 0;
          for (const segment of segments) {
            try {
              await fs.unlink(path.join(outputDir, segment));
              deletedCount++;
            } catch (err) {
              // Continue on error - segment might be in use or already deleted
            }
          }
          if (deletedCount > 0) {
            logger.info(
              { channelId, outputDir, deletedCount },
              'Cleaned up old HLS segments before starting stream'
            );
          }
        } catch (error) {
          // Non-fatal - directory might not exist or cleanup failed
          logger.warn(
            { channelId, outputDir, error },
            'Failed to clean up old segments before start (non-fatal)'
          );
        }
      } else {
        logger.debug({ channelId }, 'Skipping segment cleanup (transition start)');
      }

      // For dynamic playlists, media is already resolved from PlaylistResolver earlier
      // For static playlists, use the media from getChannelMedia
      // All media is now in the 'media' array and ready for concat file creation
      logger.info(
        {
          channelId,
          mediaCount: media.length,
          isDynamic: channel.config.useDynamicPlaylist,
          sampleFiles: media.slice(0, 3).map(m => m.filename)
        },
        'Building concat file with resolved media'
      );

      // Get all media file paths for concat file
      const mediaFilePaths = media.map(m => m.path);

      // Get bumper file path (same path, content gets overwritten when episodes start)
      const bumperPath = this.concatFileManager.getBumperPath(outputDir);

      // CRITICAL: Generate bumper BEFORE creating concat file
      // The concat file checks for bumper existence for each file, so it must exist before concat file creation
      logger.debug(
        { 
          channelId, 
          includeBumpers: channel.config.includeBumpers,
          mediaCount: media.length,
          actualStartIndex,
          bumperPath 
        },
        'Checking if bumper should be generated'
      );
      
      if (channel.config.includeBumpers !== false) {
        // Generate bumper for the next episode (after current one)
        // This ensures the bumper exists when the concat file is created
        const nextFileIndex = (actualStartIndex + 1) % media.length;
        const nextFile = media[nextFileIndex];
        
        logger.debug(
          { channelId, nextFileIndex, hasNextFile: !!nextFile, nextFileName: nextFile?.filename },
          'Preparing to generate bumper'
        );
        
        if (nextFile) {
          try {
            logger.info(
              { 
                channelId, 
                nextFile: nextFile.filename,
                showName: nextFile.info.showName,
                episodeName: nextFile.info.title || nextFile.getDisplayName(),
                bumperPath,
                duration: channel.config.segmentDuration
              },
              'Starting bumper generation for next episode'
            );
            
            await this.bumperGenerator.generateBumperMP4(
              {
                showName: nextFile.info.showName,
                episodeName: nextFile.info.title || nextFile.getDisplayName(),
                duration: channel.config.segmentDuration, // One segment duration
                resolution: channel.config.resolution,
                fps: channel.config.fps,
                videoBitrate: channel.config.videoBitrate,
                audioBitrate: channel.config.audioBitrate,
              },
              bumperPath
            );
            
            // Verify bumper was created
            try {
              await fs.access(bumperPath);
              const stats = await fs.stat(bumperPath);
              logger.info(
                { 
                  channelId, 
                  nextFile: nextFile.filename, 
                  bumperPath,
                  sizeBytes: stats.size,
                  sizeMB: (stats.size / 1024 / 1024).toFixed(2)
                },
                'Bumper MP4 generated and verified successfully (before concat file creation)'
              );
            } catch (verifyError) {
              logger.error(
                { error: verifyError, channelId, bumperPath },
                'Bumper generation reported success but file does not exist!'
              );
            }
          } catch (error) {
            logger.warn(
              { 
                channelId, 
                error: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                nextFile: nextFile.filename,
                bumperPath
              },
              'Failed to generate bumper before concat file creation, will try placeholder'
            );
            // Fallback: try to generate a simple placeholder
            try {
              const firstFile = media[0];
              logger.info(
                { channelId, firstFile: firstFile?.filename, bumperPath },
                'Attempting to generate placeholder bumper as fallback'
              );
              
              await this.bumperGenerator.generateBumperMP4(
                {
                  showName: firstFile?.info.showName || channel.config.name,
                  episodeName: 'Loading...',
                  duration: channel.config.segmentDuration,
                  resolution: channel.config.resolution,
                  fps: channel.config.fps,
                  videoBitrate: channel.config.videoBitrate,
                  audioBitrate: channel.config.audioBitrate,
                },
                bumperPath
              );
              
              // Verify placeholder was created
              try {
                await fs.access(bumperPath);
                logger.info({ channelId, bumperPath }, 'Placeholder bumper generated and verified as fallback');
              } catch (verifyError) {
                logger.error(
                  { error: verifyError, channelId, bumperPath },
                  'Placeholder bumper generation reported success but file does not exist!'
                );
              }
            } catch (placeholderError) {
              logger.error(
                { 
                  error: placeholderError instanceof Error ? placeholderError.message : String(placeholderError),
                  errorStack: placeholderError instanceof Error ? placeholderError.stack : undefined,
                  channelId, 
                  bumperPath 
                },
                'Failed to generate placeholder bumper - concat file will skip bumpers'
              );
            }
          }
        } else {
          // No next file - generate placeholder
          logger.info(
            { channelId, mediaCount: media.length, actualStartIndex },
            'No next file available, generating placeholder bumper'
          );
          try {
            const firstFile = media[0];
            await this.bumperGenerator.generateBumperMP4(
              {
                showName: firstFile?.info.showName || channel.config.name,
                episodeName: 'Loading...',
                duration: channel.config.segmentDuration,
                resolution: channel.config.resolution,
                fps: channel.config.fps,
                videoBitrate: channel.config.videoBitrate,
                audioBitrate: channel.config.audioBitrate,
              },
              bumperPath
            );
            
            // Verify placeholder was created
            try {
              await fs.access(bumperPath);
              logger.info({ channelId, bumperPath }, 'Placeholder bumper generated and verified (no next file)');
            } catch (verifyError) {
              logger.error(
                { error: verifyError, channelId, bumperPath },
                'Placeholder bumper generation reported success but file does not exist!'
              );
            }
          } catch (error) {
            logger.error(
              { 
                error: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                channelId, 
                bumperPath 
              },
              'Failed to generate placeholder bumper - concat file will skip bumpers'
            );
          }
        }
      } else {
        logger.debug({ channelId }, 'Bumpers disabled (includeBumpers === false), skipping bumper generation');
      }

      // For dynamic playlists, get and track the active schedule block ID
      // This allows detection of schedule block transitions during playback
      let scheduleBlockId: string | undefined;
      if (channel.config.useDynamicPlaylist && this.playlistResolver) {
        try {
          const activeBlock = await this.playlistResolver.scheduleRepository?.getActiveBlock(
            channelId,
            new Date()
          );
          if (activeBlock) {
            scheduleBlockId = activeBlock.id;
            this.activeScheduleBlocks.set(channelId, activeBlock.id);
            logger.debug(
              { channelId, scheduleBlockId, scheduleBlockName: activeBlock.name },
              'Tracking schedule block for dynamic playlist'
            );
          }
        } catch (error) {
          logger.warn({ error, channelId }, 'Failed to get active schedule block');
        }
      }

      // Create concat file starting from actualStartIndex with seeking support
      // This allows us to resume from a specific file and position when restarting
      // The bumper should now exist from the generation above
      
      // Log what we're about to create the concat file with
      logger.info(
        {
          channelId,
          actualStartIndex,
          seekToSeconds,
          mediaCount: mediaFilePaths.length,
          startFile: media[actualStartIndex]?.filename,
          startFileTitle: media[actualStartIndex]?.getDisplayName(),
          startFilePath: mediaFilePaths[actualStartIndex],
          firstFewFiles: media.slice(0, 5).map(m => m.getDisplayName()),
        },
        'Creating concat file with EPG-calculated position'
      );
      
      const { concatFilePath, startPosition } = await this.concatFileManager.createConcatFile(
        channelId,
        outputDir,
        mediaFilePaths,
        bumperPath,
        actualStartIndex,
        seekToSeconds,
        scheduleBlockId // Pass schedule block ID for metadata tracking
      );

      logger.info({ channelId, concatFilePath, mediaCount: media.length }, 'Starting stream with concat file');

      const streamConfig: StreamConfig = {
        concatFile: concatFilePath,
        outputDir: outputDir,
        videoBitrate: channel.config.videoBitrate,
        audioBitrate: channel.config.audioBitrate,
        resolution: channel.config.resolution,
        fps: channel.config.fps,
        segmentDuration: channel.config.segmentDuration,
        // startPosition is handled by inpoint in the concat file, so we don't need -ss
        // But we keep it for compatibility (it will be 0 when using concat)
        startPosition: startPosition,
      };

      // With concat approach: No onFileEnd callback needed
      // FFmpeg handles seamless transitions automatically through the concat file
      // We track file progression and regenerate bumper when episodes start
      
      // CRITICAL: Check if FFmpeg is already active before starting
      // If it is, stop it gracefully first to avoid the kill-and-restart pattern
      if (this.ffmpegEngine.isActive(channelId)) {
        logger.info(
          { channelId, isTransition },
          'FFmpeg is already active, stopping gracefully before starting new stream'
        );
        try {
          await this.ffmpegEngine.stop(channelId);
          // Small delay to ensure process fully terminates
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          logger.warn(
            { channelId, error },
            'Failed to stop existing FFmpeg process gracefully, will be killed by start()'
          );
        }
      }
      
      // Start FFmpeg stream with concat file (no callback needed - concat handles transitions)
      await this.ffmpegEngine.start(channelId, streamConfig);
      
      // Start file progression tracking for concat stream
      // This tracks which file is currently playing and regenerates bumper when episodes start
      // Pass seekToSeconds so the tracker accounts for starting mid-file
      this.startConcatProgressionTracking(channelId, media, actualStartIndex, seekToSeconds, channel);
      
      logger.info(
        { channelId },
        'FFmpeg started'
      );
      
      logger.info(
        {
          channelId,
          concatFilePath,
          mediaCount: media.length,
          note: 'Streaming with concat file - FFmpeg handles seamless transitions automatically'
        },
        'Channel streaming started with concat approach'
      );


      // Transition to STREAMING (only if not already in STREAMING)
      // If channel is already streaming (e.g., duplicate start call or during transitions), just update timestamp
      if (channel.getState() === ChannelState.STREAMING) {
        // Already in STREAMING, just update timestamp
        await this.channelRepository.update(channelId, {
          started_at: new Date(),
        });
      } else {
        // Normal start - transition to STREAMING
        channel.transitionTo(ChannelState.STREAMING);
        await this.channelRepository.update(channelId, {
          state: ChannelState.STREAMING,
          started_at: new Date(),
        });
      }

      // Create playback session
      const sessionType: import('../../infrastructure/database/repositories/PlaybackSessionRepository').SessionType =
        shouldUseScheduleTime ? 'resumed' : 'started';

      const sessionId = await this.playbackSessionRepository.create({
        channelId,
        sessionStart: new Date(),
        sessionType,
        triggeredBy: startIndex !== undefined ? 'manual' : 'automatic',
      });

      this.activeSessionIds.set(channelId, sessionId);

      logger.info(
        { channelId, sessionId, sessionType },
        'Playback session started'
      );

      logger.info(
        { channelId, file: media[actualStartIndex].filename },
        'Channel started streaming'
      );

      // NOTE: With concat approach, bumper MP4 is already generated before concat file creation
      // No need to pre-generate HLS segments - the concat file handles bumper playback seamlessly
      // The bumper MP4 gets regenerated when episodes start via progression tracking
      logger.debug(
        { channelId, includeBumpers: channel.config.includeBumpers !== false },
        'Bumper MP4 already generated before concat file creation (concat approach)'
      );
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
   * Start file progression tracking for concat stream
   * Tracks which file is currently playing and regenerates bumper when episodes start
   */
  private startConcatProgressionTracking(
    channelId: string,
    mediaFiles: MediaFile[],
    startIndex: number,
    seekToSeconds: number,
    channel: Channel
  ): void {
    // Stop any existing tracker for this channel
    this.stopConcatProgressionTracking(channelId);

    const startTime = Date.now();
    let currentFileIndex = startIndex;
    
    // Calculate total duration including bumpers (one bumper between each file)
    const bumperDuration = channel.config.segmentDuration; // Bumper is one segment duration
    
    // Calculate accumulated time up to the start position
    // This accounts for starting mid-playlist (e.g., starting at file 3, 30 seconds in)
    let accumulatedStartTime = 0;
    for (let i = 0; i < startIndex; i++) {
      accumulatedStartTime += mediaFiles[i].metadata?.duration || 0;
      if (i < mediaFiles.length - 1) {
        accumulatedStartTime += bumperDuration;
      }
    }
    // Add the seek position within the starting file
    accumulatedStartTime += seekToSeconds;
    
    const totalDuration = mediaFiles.reduce((sum, file, index) => {
      const fileDuration = file.metadata?.duration || 0;
      // Add bumper after each file except the last
      const bumper = index < mediaFiles.length - 1 ? bumperDuration : 0;
      return sum + fileDuration + bumper;
    }, 0);

    logger.info(
      {
        channelId,
        startIndex,
        mediaCount: mediaFiles.length,
        totalDuration,
        bumperDuration
      },
      'Starting concat file progression tracking'
    );

    // Check progression every 5 seconds
    const intervalId = setInterval(async () => {
      try {
        const channel = this.channels.get(channelId);
        if (!channel || !channel.isStreaming()) {
          this.stopConcatProgressionTracking(channelId);
          return;
        }

        // Check for schedule block transition (dynamic playlists only)
        // If a transition is detected, handle it and exit this tracker
        // (handleScheduleBlockTransition will restart the channel with new media)
        if (channel.config.useDynamicPlaylist) {
          const hasTransitioned = await this.checkScheduleTransition(channelId);
          if (hasTransitioned) {
            // Schedule block changed - need to update concat file and restart
            logger.info(
              { channelId },
              'Schedule transition detected in progression tracker - handling transition'
            );
            await this.handleScheduleBlockTransition(channelId);
            return; // Exit - new tracker will be started after restart
          }
        }

        const elapsedMs = Date.now() - startTime;
        const elapsedSeconds = elapsedMs / 1000;
        
        // Calculate which file should be playing based on elapsed time
        // Account for starting mid-playlist by adding accumulatedStartTime
        const totalElapsedSeconds = accumulatedStartTime + elapsedSeconds;
        
        // Handle looping if we've exceeded total duration
        const normalizedElapsed = totalElapsedSeconds % totalDuration;
        
        let accumulatedTime = 0;
        let expectedFileIndex = 0;
        
        for (let i = 0; i < mediaFiles.length; i++) {
          const fileDuration = mediaFiles[i].metadata?.duration || 0;
          const bumper = i < mediaFiles.length - 1 ? bumperDuration : 0;
          const segmentDuration = fileDuration + bumper;
          
          if (normalizedElapsed < accumulatedTime + segmentDuration) {
            expectedFileIndex = i;
            break;
          }
          
          accumulatedTime += segmentDuration;
        }

        // If we've moved to a new file, update tracking and regenerate bumper
        if (expectedFileIndex !== currentFileIndex) {
          const oldIndex = currentFileIndex;
          currentFileIndex = expectedFileIndex;
          
          logger.info(
            {
              channelId,
              oldIndex,
              newIndex: currentFileIndex,
              currentFile: mediaFiles[currentFileIndex]?.filename,
              elapsedSeconds
            },
            'File progression: moved to new file in concat stream'
          );

          // Update channel's currentIndex
          channel.updateCurrentIndex(currentFileIndex);
          await this.channelRepository.update(channelId, {
            current_index: currentFileIndex,
          });

          // Update virtual time
          let accumulatedSeconds = 0;
          for (let i = 0; i < currentFileIndex; i++) {
            accumulatedSeconds += mediaFiles[i].metadata?.duration || 0;
            if (i < mediaFiles.length - 1) {
              accumulatedSeconds += bumperDuration;
            }
          }
        // NOTE: No longer advancing virtual time - position calculated on-demand from schedule_start_time

          // Regenerate bumper for the NEXT file (when this one ends)
          // The concat file references the same bumper.mp4 path multiple times
          // We overwrite the file content with fresh "Up Next" info for each episode
          // FFmpeg can handle file overwrites as long as we do it atomically (which generateBumperMP4 does)
          const nextFileIndex = (currentFileIndex + 1) % mediaFiles.length;
          const nextFile = mediaFiles[nextFileIndex];
          const includeBumpers = channel.config.includeBumpers !== false;
          
          if (nextFile && includeBumpers) {
            // Resolve outputDir to absolute path to ensure bumper path is absolute
            const outputDir = path.resolve(channel.config.outputDir);
            const bumperPath = this.concatFileManager.getBumperPath(outputDir);
            try {
              // Regenerate bumper with content for the next episode
              // This overwrites the existing bumper.mp4 file that FFmpeg will read next
              // FFmpeg reads files on-demand, so regenerating now ensures the correct content
              // is ready when FFmpeg reaches the bumper in the concat sequence
              await this.bumperGenerator.generateBumperMP4(
                {
                  showName: nextFile.info.showName,
                  episodeName: nextFile.info.title || nextFile.getDisplayName(),
                  duration: bumperDuration,
                  resolution: channel.config.resolution,
                  fps: channel.config.fps,
                  videoBitrate: channel.config.videoBitrate,
                  audioBitrate: channel.config.audioBitrate,
                },
                bumperPath
              );
              logger.info(
                {
                  channelId,
                  currentFile: mediaFiles[currentFileIndex]?.filename,
                  nextFile: nextFile.filename,
                  bumperPath,
                  note: 'Bumper regenerated for next episode - FFmpeg will read this when it reaches the bumper in concat sequence'
                },
                'Regenerated bumper MP4 for next episode'
              );
            } catch (error) {
              logger.warn(
                { channelId, error, nextFile: nextFile.filename },
                'Failed to regenerate bumper (non-fatal - old bumper will be used)'
              );
            }
          }
        }
      } catch (error) {
        logger.error(
          { channelId, error },
          'Error in concat progression tracking'
        );
      }
    }, 5000); // Check every 5 seconds

    // Store tracker
    this.concatProgressionTrackers.set(channelId, {
      startTime,
      mediaFiles: [...mediaFiles], // Store copy
      currentFileIndex,
      intervalId
    });
  }

  /**
   * Stop file progression tracking for a channel
   */
  private stopConcatProgressionTracking(channelId: string): void {
    const tracker = this.concatProgressionTrackers.get(channelId);
    if (tracker) {
      clearInterval(tracker.intervalId);
      this.concatProgressionTrackers.delete(channelId);

      // NOTE: Do NOT delete activeScheduleBlocks here - we need to preserve it across restarts
      // to avoid false schedule transition detections. Only clear it when channel is fully stopped.

      logger.debug({ channelId }, 'Stopped concat progression tracking');
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

    // Cancel early-start timer if it exists
    const earlyStartTimer = this.earlyStartTimers.get(channelId);
    if (earlyStartTimer) {
      clearTimeout(earlyStartTimer);
      this.earlyStartTimers.delete(channelId);
      logger.debug({ channelId }, 'Cancelled early-start timer (channel stopping)');
    }
    
    // Clear early start completion flag
    this.earlyStartCompleted.delete(channelId);

    // Stop concat progression tracking
    this.stopConcatProgressionTracking(channelId);

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
          await this.playbackSessionRepository.endSession(sessionId, {
            sessionEnd: new Date(),
          });

          this.activeSessionIds.delete(channelId);

          logger.info(
            { channelId, sessionId },
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

      // Clean up schedule block tracking for dynamic playlists (only when fully stopped)
      this.activeScheduleBlocks.delete(channelId);

      // NOTE: No longer need to pause/track virtual time with schedule-based approach
      // Position is calculated on-demand from schedule_start_time when channel resumes

      logger.info({ channelId }, 'Channel stopped');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      channel.setError(errorMessage);
      await this.channelRepository.update(channelId, {
        state: ChannelState.ERROR,
        last_error: errorMessage,
        last_error_at: new Date(),
      });
      
      // NOTE: No longer need to pause virtual time on error with schedule-based approach

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
   * Check if schedule block has transitioned for a dynamic playlist channel
   *
   * @param channelId - Channel ID
   * @returns True if schedule block has changed, false otherwise
   */
  private async checkScheduleTransition(channelId: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel?.config.useDynamicPlaylist) {
      return false; // Static playlists don't have schedule transitions
    }

    // Check if we have a playlist resolver (needed for dynamic playlists)
    if (!this.playlistResolver) {
      logger.warn({ channelId }, 'No playlist resolver available for schedule transition check');
      return false;
    }

    try {
      // Get the current schedule block from the database
      const currentBlock = await this.playlistResolver.scheduleRepository?.getActiveBlock(
        channelId,
        new Date()
      );

      // Get the tracked schedule block ID from our Map
      const trackedBlockId = this.activeScheduleBlocks.get(channelId);

      // If we have a current block and it's different from tracked, transition has occurred
      if (currentBlock?.id && currentBlock.id !== trackedBlockId) {
        logger.info(
          {
            channelId,
            oldBlock: trackedBlockId || 'none',
            newBlock: currentBlock.id,
            newBlockName: currentBlock.name,
            playbackMode: currentBlock.playback_mode
          },
          'Schedule block transition detected'
        );
        return true;
      }

      return false;
    } catch (error) {
      logger.error({ error, channelId }, 'Error checking schedule transition');
      return false;
    }
  }

  /**
   * Handle schedule block transition for a dynamic playlist channel
   * This updates the concat file with new media list and restarts the stream
   *
   * @param channelId - Channel ID
   */
  private async handleScheduleBlockTransition(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.error({ channelId }, 'Channel not found for schedule transition');
      return;
    }

    logger.info(
      { channelId, channelName: channel.config.name },
      'Handling schedule block transition for concat stream'
    );

    try {
      // Get new media list (will be shuffled/ordered based on new block's playback_mode)
      const newMedia = await this.getChannelMedia(channelId);

      if (newMedia.length === 0) {
        logger.error({ channelId }, 'No media found for new schedule block');
        return;
      }

      // Get the new schedule block to track it
      const newBlock = await this.playlistResolver?.scheduleRepository?.getActiveBlock(
        channelId,
        new Date()
      );

      if (newBlock) {
        // Update tracked schedule block ID
        this.activeScheduleBlocks.set(channelId, newBlock.id);

        logger.info(
          {
            channelId,
            newBlockId: newBlock.id,
            newBlockName: newBlock.name,
            newMediaCount: newMedia.length,
            playbackMode: newBlock.playback_mode
          },
          'Updating concat file with new schedule block media'
        );

        // Recreate concat file with new media list
        const outputDir = path.resolve(channel.config.outputDir);
        const mediaFilePaths = newMedia.map(m => m.path);
        const bumperPath = this.concatFileManager.getBumperPath(outputDir);

        await this.concatFileManager.updateConcatFile(
          channelId,
          outputDir,
          mediaFilePaths,
          bumperPath,
          newBlock.id // Track the new schedule block ID
        );

        // Get EPG-calculated position to maintain schedule accuracy
        // This ensures we resume at the correct file/time for the new schedule block
        let resumeIndex = 0;
        try {
          const epgPosition = await this.epgService.getCurrentPlaybackPosition(channel, newMedia);
          if (epgPosition) {
            resumeIndex = epgPosition.fileIndex;
            logger.info(
              {
                channelId,
                epgFileIndex: epgPosition.fileIndex,
                epgSeekPosition: epgPosition.seekPosition,
                newBlockName: newBlock.name
              },
              'Using EPG-calculated position for schedule transition restart'
            );
          }
        } catch (error) {
          logger.warn(
            { channelId, error },
            'Failed to get EPG position for schedule transition, starting from index 0'
          );
        }

        // Restart stream gracefully with new concat file at EPG-calculated position
        logger.info(
          { channelId, resumeIndex, newBlockName: newBlock.name },
          'Restarting stream with new schedule block media'
        );
        await this.stopChannel(channelId);
        await this.startChannel(channelId, resumeIndex); // Use EPG-calculated position

        logger.info(
          { channelId, newBlockName: newBlock.name },
          'Schedule block transition completed successfully'
        );
      }
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to handle schedule block transition');
      // Don't throw - let the stream continue with current media
    }
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

    // No discontinuity tag needed - all files are re-encoded to identical parameters
    // FFmpeg will replace placeholders with real segments seamlessly

    await fs.writeFile(playlistPath, playlist);
    
    logger.debug({ channelId, numSegments }, 'Created startup playlist with placeholders');
  }

  /**
   * UNUSED with append_list approach - kept for reference
   * 
   * NOTE: This function should NEVER be used with append_list!
   * append_list REQUIRES the playlist to exist - deleting it breaks FFmpeg's segment numbering.
   * FFmpeg's delete_segments flag automatically handles old segment cleanup.
   * 
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

      // WARNING: Deleting playlist breaks append_list - DO NOT USE THIS WITH append_list!
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
  // NOTE: This method is UNUSED - we don't inject discontinuity tags because:
  // 1. All files are re-encoded to identical parameters (no encoding changes)
  // 2. discont_start flag doesn't work with append_list
  // 3. Discontinuity tags are removed on-read in PlaylistService
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async _injectDiscontinuityTag_unused(
    _channelId: string,
    _firstNewSegmentNumber: number
  ): Promise<void> {
    // UNUSED - kept for reference only
    // This method would inject discontinuity tags, but we don't need them
    // since all segments have identical encoding parameters after re-encoding
    return;
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
    // CRITICAL: Also check if FFmpeg is already active to avoid double-start race condition
    // (e.g., if admin panel start was clicked just before viewer connected)
    const isStreaming = channel.isStreaming();
    const isFFmpegActive = this.ffmpegEngine.isActive(channelId);
    const isStarting = channel.getState() === ChannelState.STARTING;
    
    if (newCount === 1 && !isStreaming && !isFFmpegActive && !isStarting) {
      const hasScheduleTime = await this.scheduleTimeService.hasScheduleTime(channelId);
      const isResuming = hasScheduleTime; // Channel resuming if schedule time exists
      logger.info(
        { 
          channelId, 
          isResuming,
          willUseEPG: isResuming || channel.isIdle(),
          channelState: channel.getState(),
          ffmpegActive: isFFmpegActive
        }, 
        `First viewer connected, ${isResuming ? 'unpausing stream' : 'starting stream'} (will use EPG to determine position if available)`
      );

      // Initialize or check virtual time state
      if (!hasScheduleTime) {
        // Initialize virtual timeline for new channel
        await this.scheduleTimeService.initializeScheduleTime(channelId);
      }
      
      logger.debug(
        {
          channelId,
          hasVirtualTime: !!channelId,
          isResuming: isResuming,
        },
        'Virtual time state before unpausing (startChannel will use EPG to determine position)'
      );
      // Note: Don't call resumeVirtualTime here - let startChannel handle it
      // This ensures startChannel can detect paused state and use virtual position

      // Start streaming from virtual position
      await this.startChannel(channelId);
    } else if (newCount === 1 && (isFFmpegActive || isStarting)) {
      logger.debug(
        {
          channelId,
          channelState: channel.getState(),
          ffmpegActive: isFFmpegActive,
          isStarting,
        },
        'First viewer connected but stream is already starting/active, skipping startChannel call'
      );
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
            // NOTE: No longer need to pause virtual time with schedule-based approach
            logger.info(
              { channelId },
              'Grace period expired, stopping channel (no viewers)'
            );

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
   * Start the next file 6 seconds before current file ends
   * This ensures segments are ready when the current stream ends, eliminating gaps
   */
  private async startNextFileEarly(
    channelId: string,
    currentIndex: number
  ): Promise<void> {
    try {
      const channel = this.channels.get(channelId);
      if (!channel) {
        logger.warn({ channelId }, 'Channel no longer exists, skipping early start');
        return;
      }

      // Only proceed if channel is still streaming
      if (!channel.isStreaming() || channel.getState() !== ChannelState.STREAMING) {
        logger.debug({ channelId, state: channel.getState() }, 'Channel not streaming, skipping early start');
        return;
      }

      // Get fresh media list (may have changed for dynamic playlists)
      const media = await this.getChannelMedia(channelId);
      if (media.length === 0) {
        logger.warn({ channelId }, 'No media files available for early start');
        return;
      }

      // Detect if media list changed (schedule block transition)
      const previousMedia = channel.config.useDynamicPlaylist 
        ? (this.channelMedia.get(channelId) || [])
        : [];
      const mediaListChanged = channel.config.useDynamicPlaylist && (
        media.length !== previousMedia.length ||
        media.some((m, i) => !previousMedia[i] || m.id !== previousMedia[i].id)
      );

      let nextIndex: number;

      // EPG as single source of truth - try EPG first
      try {
        const epgFileIndex = await this.epgService.getCurrentFileIndexFromEPG(channel, media);

        if (epgFileIndex !== null) {
          nextIndex = epgFileIndex;
          logger.info(
            {
              channelId,
              currentIndex,
              nextIndex,
              nextFile: media[nextIndex]?.filename,
              source: 'EPG',
              mediaListChanged,
            },
            'Early start: next file determined by EPG'
          );
        } else {
          throw new Error('EPG unavailable, using fallback logic');
        }
      } catch (epgError) {
        // EPG failed or unavailable - use fallback logic
        if (mediaListChanged) {
          nextIndex = 0;
          logger.info(
            {
              channelId,
              nextIndex,
              nextFile: media[0]?.filename,
              reason: 'schedule block changed',
            },
            'Early start: schedule block changed, starting from beginning'
          );
        } else {
          const currentViewerCount = channel.getMetadata().viewerCount;
          
          if (currentViewerCount > 0) {
            // Active streaming - go to next file in sequence
            nextIndex = (currentIndex + 1) % media.length;
            logger.info(
              {
                channelId,
                currentIndex,
                nextIndex,
                nextFile: media[nextIndex]?.filename,
                fallback: 'sequential (active streaming)',
              },
              'Early start: next file (EPG unavailable, using sequential fallback)'
            );
          } else {
            // No viewers - use virtual time
            const hasScheduleTime = await this.scheduleTimeService.hasScheduleTime(channelId);
            if (!hasScheduleTime) {
              nextIndex = (currentIndex + 1) % media.length;
              logger.info(
                {
                  channelId,
                  currentIndex,
                  nextIndex,
                  nextFile: media[nextIndex]?.filename,
                  fallback: 'sequential (no virtual time)',
                },
                'Early start: next file (EPG unavailable, no virtual time)'
              );
            } else {
              const position = await this.scheduleTimeService.getCurrentPosition(
                channelId,
                media
              );

              if (position && position.fileIndex === currentIndex) {
                nextIndex = (currentIndex + 1) % media.length;
              } else if (position) {
                nextIndex = position.fileIndex;
              } else {
                nextIndex = (currentIndex + 1) % media.length;
              }
              
              logger.info(
                {
                  channelId,
                  currentIndex,
                  nextIndex,
                  nextFile: media[nextIndex]?.filename,
                  fallback: 'virtual time',
                },
                'Early start: next file (EPG unavailable, using virtual time)'
              );
            }
          }
        }
      }

      // Validate nextIndex
      if (nextIndex < 0 || nextIndex >= media.length) {
        logger.warn({ channelId, nextIndex, mediaCount: media.length }, 'Next index out of bounds, resetting to 0');
        nextIndex = 0;
      }

      const nextFile = media[nextIndex];
      if (!nextFile) {
        logger.error({ channelId, nextIndex, mediaCount: media.length }, 'Next file not found, cannot start early');
        return;
      }

      logger.info(
        {
          channelId,
          currentIndex,
          nextIndex,
          nextFile: nextFile.filename,
          note: 'Starting next file 7 seconds early (6s target + 1s buffer) to ensure seamless transition',
        },
        'Early start: starting next file before current file ends'
      );

      // Start the next file with isTransition=true
      // This bypasses state checks and lets EPG determine the correct position
      // Note: This will kill the current FFmpeg process, which is intentional
      // The current file has ~7 seconds left, and the next file will start writing segments immediately
      await this.startChannel(channelId, undefined, true); // isTransition = true

      logger.info(
        { 
          channelId, 
          nextFile: nextFile.filename,
          note: 'Early start completed - next file is now streaming, current file will be cut short by ~16 seconds'
        }, 
        'Early start completed - next file is now streaming'
      );
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to start next file early (non-fatal, onFileEnd will handle transition)');
      // Don't throw - onFileEnd will handle the transition normally if early start fails
    }
  }

  /**
   * Cleanup all channels on shutdown
   */
  public async cleanup(): Promise<void> {
    logger.info('Cleaning up all channels');

    // Stop virtual time update loop

    // Clear all pending pause timers
    for (const [channelId, timer] of this.pauseTimers.entries()) {
      clearTimeout(timer);
      logger.debug({ channelId }, 'Cleared pending pause timer during cleanup');
    }
    this.pauseTimers.clear();

    // Clear all pending early-start timers
    for (const [channelId, timer] of this.earlyStartTimers.entries()) {
      clearTimeout(timer);
      logger.debug({ channelId }, 'Cleared pending early-start timer during cleanup');
    }
    this.earlyStartTimers.clear();

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
