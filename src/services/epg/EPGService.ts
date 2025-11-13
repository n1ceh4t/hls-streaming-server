import { Program } from '../../domain/epg/Program';
import { Channel } from '../../domain/channel/Channel';
import { MediaFile } from '../../domain/media/MediaFile';
import { createLogger } from '../../utils/logger';
import { EPGCacheRepository } from '../../infrastructure/database/repositories/EPGCacheRepository';
import { ScheduleTimeService } from '../schedule-time/ScheduleTimeService';
import { ScheduleRepository } from '../../infrastructure/database/repositories/ScheduleRepository';
import { MediaBucketService } from '../bucket/MediaBucketService';
import { MediaFileRepository } from '../../infrastructure/database/repositories/MediaFileRepository';
import { PlaylistResolver, PlaylistContext } from '../playlist/PlaylistResolver';
import { MetadataExtractor } from '../../infrastructure/ffmpeg/MetadataExtractor';

const logger = createLogger('EPGService');

export interface EPGOptions {
  lookaheadHours?: number; // How many hours to generate ahead (default: 48)
  cacheMinutes?: number; // How long to cache in-memory (default: 5) - DB cache is 2 hours
  enableDatabaseCache?: boolean; // Whether to use database caching (default: true)
  bucketService?: MediaBucketService; // Optional: for dynamic playlist EPG generation
  playlistResolver?: PlaylistResolver; // Optional: for dynamic playlist EPG generation (uses same logic as streaming)
  metadataExtractor?: MetadataExtractor; // Optional: for refreshing metadata during EPG generation
}

export class EPGService {
  private memoryCache: Map<string, { programs: Program[]; generatedAt: Date }> = new Map();
  private readonly lookaheadHours: number;
  private readonly cacheMinutes: number;
  private readonly enableDatabaseCache: boolean;
  private readonly epgCacheRepository: EPGCacheRepository;
  private readonly scheduleTimeService: ScheduleTimeService;
  private readonly scheduleRepository: ScheduleRepository;
  private readonly mediaFileRepository: MediaFileRepository;
  private readonly bucketService?: MediaBucketService;
  private readonly playlistResolver?: PlaylistResolver;
  // NOTE: metadataExtractor removed - we now rely on database-cached metadata only

  constructor(options: EPGOptions = {}) {
    this.lookaheadHours = options.lookaheadHours || 48;
    this.cacheMinutes = options.cacheMinutes || 5; // In-memory cache: 5 minutes
    this.enableDatabaseCache = options.enableDatabaseCache !== false; // Default: true
    this.epgCacheRepository = new EPGCacheRepository();
    this.scheduleTimeService = new ScheduleTimeService();
    this.scheduleRepository = new ScheduleRepository();
    this.mediaFileRepository = new MediaFileRepository();
    this.bucketService = options.bucketService;
    this.playlistResolver = options.playlistResolver;
    // NOTE: metadataExtractor no longer used - removed to rely on database-cached metadata
  }

  /**
   * Generate EPG programs for a channel
   * Projects the virtual timeline onto real-world time starting from 00:00 AM of the current day
   * (for completeness) and extending forward by lookaheadHours (default: 48 hours)
   */
  public async generatePrograms(
    channel: Channel,
    mediaFiles: MediaFile[],
    startTime: Date = new Date()
  ): Promise<Program[]> {
    // Use channel ID as cache key since EPG is always generated from "now" forward
    // Round startTime to nearest minute for consistency (programs start at minute boundaries)
    const roundedStartTime = this.roundToNearestMinute(startTime);
    
    // Generate EPG from 00:00 AM of the current day for completeness
    // Calculate midnight of the current day
    const now = new Date(roundedStartTime);
    const midnightToday = new Date(now);
    midnightToday.setHours(0, 0, 0, 0);
    
    // Use midnight as the actual start time for generation
    const epgStartTime = midnightToday;
    const cacheKey = channel.id;

    // 1. Check database cache first (2-hour TTL)
    if (this.enableDatabaseCache) {
      try {
        const dbCache = await this.epgCacheRepository.findByChannel(channel.id);
        if (dbCache) {
          logger.debug(
            {
              channelId: channel.id,
              generatedAt: dbCache.generatedAt,
              expiresAt: dbCache.expiresAt
            },
            'Returning EPG from database cache'
          );
          // Deserialize programs from JSON
          const programs = dbCache.jsonContent.map((p: any) =>
            Program.fromJSON(p)
          );
          // Also populate memory cache for faster subsequent access
          this.memoryCache.set(cacheKey, {
            programs,
            generatedAt: dbCache.generatedAt,
          });
          return programs;
        }
      } catch (error) {
        logger.warn({ error, channelId: channel.id }, 'Failed to load EPG from database cache (continuing with generation)');
      }
    }

    // 2. Check in-memory cache (5-minute TTL)
    const memCached = this.memoryCache.get(cacheKey);
    if (memCached && this.isCacheValid(memCached.generatedAt)) {
      logger.debug({ channelId: channel.id }, 'Returning EPG from memory cache');
      return memCached.programs;
    }

    logger.info({ channelId: channel.id, lookahead: this.lookaheadHours }, 'Generating EPG');

    // For dynamic playlists, don't exit early on empty media
    // The dynamic generator will query schedule blocks directly and handle empty media gracefully
    if (mediaFiles.length === 0 && !(channel.config.useDynamicPlaylist && this.bucketService)) {
      logger.warn({ channelId: channel.id }, 'No media files for EPG generation');
      return [];
    }
    
    if (mediaFiles.length === 0 && channel.config.useDynamicPlaylist && this.bucketService) {
      logger.debug({ channelId: channel.id }, 'No initial media for dynamic playlist, but will check schedule blocks during EPG generation');
    }

    // Get schedule time for the channel at the current time (roundedStartTime)
    // This gives us the current playback position
    const currentSchedulePosition = await this.scheduleTimeService.getCurrentPosition(
      channel.id,
      mediaFiles,
      roundedStartTime
    );

    // Calculate the position at midnight (epgStartTime) by working backwards from current position
    let fileIndex: number;
    let positionInFile: number;

    if (currentSchedulePosition) {
      // Channel has schedule time - calculate position at midnight by working backwards
      const hoursSinceMidnight = (roundedStartTime.getTime() - epgStartTime.getTime()) / (1000 * 60 * 60);
      const secondsSinceMidnight = hoursSinceMidnight * 3600;
      
      // Calculate how many seconds before current time we need to go back
      // This is the elapsed seconds from schedule_start_time to now
      const elapsedSecondsToNow = currentSchedulePosition.elapsedSeconds;
      const elapsedSecondsToMidnight = elapsedSecondsToNow - secondsSinceMidnight;
      
      // If midnight is before schedule_start_time, we need to calculate backwards from the start
      if (elapsedSecondsToMidnight < 0) {
        // Midnight is before schedule started - start from beginning of playlist
        fileIndex = 0;
        positionInFile = 0;
        logger.debug(
          {
            channelId: channel.id,
            midnightBeforeSchedule: true,
            elapsedSecondsToMidnight,
            elapsedSecondsToNow,
            secondsSinceMidnight
          },
          'Midnight is before schedule start - starting from beginning'
        );
      } else {
        // Calculate position at midnight by working backwards through the media
        // We'll approximate by using the schedule position calculation at midnight
        const midnightSchedulePosition = await this.scheduleTimeService.getCurrentPosition(
          channel.id,
          mediaFiles,
          epgStartTime
        );
        
        if (midnightSchedulePosition) {
          fileIndex = midnightSchedulePosition.fileIndex;
          positionInFile = midnightSchedulePosition.seekPosition;
          logger.debug(
            {
              channelId: channel.id,
              elapsedSecondsToMidnight,
              fileIndex,
              positionInFile
            },
            'Calculated position at midnight from schedule time'
          );
        } else {
          // Fallback: use current position and work backwards (simplified)
          fileIndex = currentSchedulePosition.fileIndex;
          positionInFile = currentSchedulePosition.seekPosition;
          logger.debug(
            {
              channelId: channel.id,
              usingCurrentPosition: true,
              fileIndex,
              positionInFile
            },
            'Using current position as fallback for midnight calculation'
          );
        }
      }
    } else {
      // No schedule time - use channel metadata position or start from beginning
      fileIndex = channel.getMetadata().currentIndex || 0;
      positionInFile = 0;

      logger.debug(
        { channelId: channel.id, fileIndex },
        'No schedule time - using channel index or starting from beginning'
      );
    }

    // End time is lookahead hours from NOW (not from midnight) to maintain 48-hour lookahead
    const endTime = new Date(roundedStartTime.getTime() + this.lookaheadHours * 60 * 60 * 1000);

    // Check if channel uses dynamic playlists - if so, use PlaylistResolver for consistency
    logger.debug(
      {
        channelId: channel.id,
        useDynamicPlaylist: channel.config.useDynamicPlaylist,
        hasPlaylistResolver: !!this.playlistResolver,
        hasBucketService: !!this.bucketService,
        mediaFilesCount: mediaFiles.length,
        startTime: epgStartTime.toISOString(),
        endTime: endTime.toISOString(),
        currentTime: roundedStartTime.toISOString(),
      },
      'EPG generatePrograms: Starting program generation (from midnight to lookahead)'
    );

    let programs: Program[];
    if (channel.config.useDynamicPlaylist && this.playlistResolver) {
      logger.debug(
        {
          channelId: channel.id,
          method: 'PlaylistResolver',
        },
        'EPG generatePrograms: Using PlaylistResolver for dynamic playlist (consistent with streaming)'
      );
      programs = await this.generateProgramsForDynamicPlaylistWithResolver(channel, epgStartTime, endTime, fileIndex, positionInFile);
      logger.debug(
        {
          channelId: channel.id,
          programCount: programs.length,
          method: 'PlaylistResolver',
        },
        'EPG generatePrograms: PlaylistResolver method completed'
      );
    } else if (channel.config.useDynamicPlaylist && this.bucketService) {
      // Fallback: use old implementation if resolver not available
      logger.warn(
        {
          channelId: channel.id,
          method: 'Legacy',
          reason: 'PlaylistResolver not available, using legacy method',
        },
        'EPG generatePrograms: Using legacy method for dynamic playlist'
      );
      programs = await this.generateProgramsForDynamicPlaylist(channel, mediaFiles, epgStartTime, endTime, fileIndex, positionInFile);
      logger.debug(
        {
          channelId: channel.id,
          programCount: programs.length,
          method: 'Legacy',
        },
        'EPG generatePrograms: Legacy method completed'
      );
    } else {
      // Static playlist generation (original logic)
      logger.debug(
        {
          channelId: channel.id,
          method: 'Static',
          mediaFilesCount: mediaFiles.length,
        },
        'EPG generatePrograms: Using static playlist generation'
      );
      programs = await this.generateProgramsForStaticPlaylist(channel, mediaFiles, epgStartTime, endTime, fileIndex, positionInFile);
      logger.debug(
        {
          channelId: channel.id,
          programCount: programs.length,
          method: 'Static',
        },
        'EPG generatePrograms: Static method completed'
      );
    }
    
    // Store in memory cache (5-minute TTL for fast access)
    this.memoryCache.set(cacheKey, {
      programs,
      generatedAt: new Date(),
    });

    // Store in database cache (2-hour TTL for persistence across restarts)
    if (this.enableDatabaseCache) {
      try {
        // Generate XML for external consumption
        const xmlContent = this.generateXML(programs, channel);
        // Convert programs to JSON for storage
        const jsonContent = programs.map(p => p.toJSON());

        await this.epgCacheRepository.upsert(
          channel.id,
          xmlContent,
          jsonContent,
          120 // 2 hours TTL
        );

        logger.debug({ channelId: channel.id }, 'EPG saved to database cache');
      } catch (error) {
        logger.warn({ error, channelId: channel.id }, 'Failed to save EPG to database cache (non-fatal)');
      }
    }

    logger.info(
      { channelId: channel.id, programCount: programs.length },
      'EPG generation complete'
    );

    return programs;
  }

  /**
   * Generate EPG programs for a static playlist channel
   * Original sequential generation logic
   */
  private async generateProgramsForStaticPlaylist(
    channel: Channel,
    mediaFiles: MediaFile[],
    startTime: Date,
    endTime: Date,
    fileIndex: number,
    positionInFile: number
  ): Promise<Program[]> {
    const programs: Program[] = [];

    let currentTime = new Date(startTime);
    let isFirstProgram = true;

    while (currentTime < endTime) {
      // Loop through playlist (handles both finite and infinite playlists)
      const mediaFile = mediaFiles[fileIndex % mediaFiles.length];
      const fileDuration = mediaFile.metadata.duration;

      let programDuration: number;
      let programTitle: string;
      let programDescription: string | undefined;

      if (isFirstProgram && positionInFile > 0) {
        // First program is partial - show remaining time
        programDuration = fileDuration - positionInFile;
        programTitle = mediaFile.getDisplayName();

        // Add "In Progress" indicator
        const remainingMinutes = Math.floor(programDuration / 60);
        programDescription = `In Progress (${remainingMinutes} min remaining) - ${this.generateDescription(mediaFile)}`;

        logger.debug(
          {
            channelId: channel.id,
            fileIndex,
            positionInFile,
            fileDuration,
            remainingDuration: programDuration
          },
          'First program is partial (joining in progress)'
        );

        isFirstProgram = false;
      } else {
        // Full program
        programDuration = fileDuration;
        programTitle = mediaFile.getDisplayName();
        programDescription = this.generateDescription(mediaFile);

        if (isFirstProgram) {
          isFirstProgram = false;
        }
      }

      const programStart = new Date(currentTime);
      const programEnd = new Date(currentTime.getTime() + programDuration * 1000);

      const program = new Program(
        channel.id,
        programStart,
        programEnd,
        {
          title: programTitle,
          description: programDescription,
          category: this.determineCategory(mediaFile),
          episodeNum: this.formatEpisodeNumber(mediaFile),
          icon: undefined, // Could be added later
        }
      );

      programs.push(program);

      currentTime = programEnd;
      fileIndex++;

      // Safety check to prevent infinite loops (10000 programs ? 69 days @ 10min/program)
      if (programs.length > 10000) {
        logger.warn({ channelId: channel.id }, 'EPG generation exceeded 10000 programs');
        break;
      }
    }

    return programs;
  }

  /**
   * Generate EPG programs for dynamic playlist using PlaylistResolver
   * This ensures EPG generation uses the EXACT same logic as streaming
   * Calls PlaylistResolver.resolveMedia() at each time point to get media
   */
  private async generateProgramsForDynamicPlaylistWithResolver(
    channel: Channel,
    startTime: Date,
    endTime: Date,
    initialFileIndex: number,
    initialPositionInFile: number
  ): Promise<Program[]> {
    const programs: Program[] = [];
    let currentTime = new Date(startTime);
    
    // For dynamic playlists, we need to get the ACTUAL media list at startTime
    // to calculate the correct starting position. The initialFileIndex/positionInFile
    // were calculated from static mediaFiles which might be empty or wrong for dynamic playlists.
    logger.info(
      {
        channelId: channel.id,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        lookaheadHours: this.lookaheadHours,
        initialFileIndex,
        initialPositionInFile,
      },
      'Generating EPG for dynamic playlist using PlaylistResolver (consistent with streaming)'
    );

    // Get the actual media list at startTime using PlaylistResolver
    const initialContext: PlaylistContext = {
      currentTime: new Date(startTime),
      currentIndex: initialFileIndex,
    };
    const initialMediaFiles = await this.playlistResolver!.resolveMedia(channel.id, initialContext);
    
    let fileIndex = initialFileIndex;
    let positionInFile = initialPositionInFile;
    
    // If we have initial media and schedule time, recalculate the correct starting position
    // based on elapsed time from schedule start, using the ACTUAL media list
    if (initialMediaFiles.length > 0) {
      const schedulePosition = await this.scheduleTimeService.getCurrentPosition(channel.id, initialMediaFiles, startTime);
      if (schedulePosition) {
        // Use schedule-based position directly (much simpler than old virtual time calculation!)
        fileIndex = schedulePosition.fileIndex;
        positionInFile = schedulePosition.seekPosition;

        logger.info(
          {
            channelId: channel.id,
            elapsedSeconds: schedulePosition.elapsedSeconds,
            initialMediaCount: initialMediaFiles.length,
            calculatedFileIndex: fileIndex,
            calculatedPositionInFile: positionInFile,
            calculatedFile: initialMediaFiles[fileIndex]?.filename || 'unknown',
          },
          'EPG generateProgramsForDynamicPlaylistWithResolver: Calculated starting position from schedule time using actual media list'
        );
      }
    }
    
    let isFirstProgram = true;

    // Track last media list to detect schedule block changes
    let lastMediaListHash = '';

    let loopIterations = 0;
    let totalMediaResolutions = 0;
    let emptyMediaResolutions = 0;

    while (currentTime < endTime) {
      loopIterations++;
      
      // Calculate elapsed time from start to determine correct file index
      // This ensures we progress through media even when PlaylistResolver falls back
      const elapsedSeconds = (currentTime.getTime() - startTime.getTime()) / 1000;
      
      // Calculate which file we should be on based on elapsed time
      // This is more reliable than passing fileIndex to PlaylistResolver
      // because PlaylistResolver might reset when falling back to channel buckets
      let calculatedFileIndex = fileIndex;
      
      // Use PlaylistResolver to get media at this time point (same logic as streaming)
      const context: PlaylistContext = {
        currentTime: new Date(currentTime),
        currentIndex: calculatedFileIndex, // Use calculated index
      };

      logger.debug(
        {
          channelId: channel.id,
          iteration: loopIterations,
          currentTime: currentTime.toISOString(),
          fileIndex,
          positionInFile,
          timeUntilEnd: Math.round((endTime.getTime() - currentTime.getTime()) / 1000 / 60) + ' minutes',
        },
        'EPG generateProgramsForDynamicPlaylistWithResolver: Resolving media at time point'
      );

      logger.debug(
        {
          channelId: channel.id,
          iteration: loopIterations,
          contextTime: context.currentTime?.toISOString() || 'undefined',
          contextIndex: context.currentIndex,
          hasPlaylistResolver: !!this.playlistResolver,
        },
        'EPG generateProgramsForDynamicPlaylistWithResolver: About to call PlaylistResolver.resolveMedia()'
      );

      const currentMediaFiles = await this.playlistResolver!.resolveMedia(channel.id, context);
      totalMediaResolutions++;

      logger.debug(
        {
          channelId: channel.id,
          iteration: loopIterations,
          currentTime: currentTime.toISOString(),
          contextTime: context.currentTime?.toISOString() || 'undefined',
          elapsedSeconds: Math.round(elapsedSeconds),
          mediaCount: currentMediaFiles.length,
          mediaIds: currentMediaFiles.slice(0, 5).map(m => m.id),
          mediaFilenames: currentMediaFiles.slice(0, 3).map(m => m.filename),
          mediaDurations: currentMediaFiles.slice(0, 3).map(m => m.metadata?.duration || 0),
          currentFileIndex: fileIndex,
          currentPositionInFile: positionInFile,
        },
        'EPG generateProgramsForDynamicPlaylistWithResolver: Media resolved from PlaylistResolver'
      );

      // Detect if media list changed (schedule block transition)
      const currentHash = currentMediaFiles.map(m => m.id).join(',');
      const mediaListChanged = currentHash !== lastMediaListHash;

      if (mediaListChanged) {
        logger.debug(
          {
            channelId: channel.id,
            currentTime: currentTime.toISOString(),
            elapsedSeconds: Math.round(elapsedSeconds),
            mediaCount: currentMediaFiles.length,
            previousHash: lastMediaListHash.substring(0, 50) + '...',
            currentHash: currentHash.substring(0, 50) + '...',
          },
          'Media list changed (schedule block transition detected)'
        );
        // Reset position when schedule block changes
        fileIndex = 0;
        positionInFile = 0;
        lastMediaListHash = currentHash;
      } else if (currentMediaFiles.length > 0) {
        // Media list unchanged - DON'T recalculate position from elapsed time here
        // We've already been generating programs and updating positionInFile correctly.
        // The elapsed-time recalculation should only happen at the start or when media list changes.
        // Recalculating here causes position to reset incorrectly when we break to check schedule changes.
        
        // Only recalculate if fileIndex is out of bounds or if we're way off (more than 1 file off)
        // This handles edge cases without interfering with normal progression
        if (fileIndex >= currentMediaFiles.length) {
          // File index is out of bounds - recalculate from elapsed time
          let accumulatedSeconds = 0;
          let targetFileIndex = 0;
          let targetPositionInFile = 0;
          
          for (let i = 0; i < currentMediaFiles.length; i++) {
            const fileDuration = currentMediaFiles[i].metadata.duration;
            if (elapsedSeconds < accumulatedSeconds + fileDuration) {
              targetFileIndex = i;
              targetPositionInFile = elapsedSeconds - accumulatedSeconds;
              break;
            }
            accumulatedSeconds += fileDuration;
            
            if (i === currentMediaFiles.length - 1) {
              const totalDuration = accumulatedSeconds;
              const remainingSeconds = elapsedSeconds % totalDuration;
              accumulatedSeconds = 0;
              for (let j = 0; j < currentMediaFiles.length; j++) {
                const fd = currentMediaFiles[j].metadata.duration;
                if (remainingSeconds < accumulatedSeconds + fd) {
                  targetFileIndex = j;
                  targetPositionInFile = remainingSeconds - accumulatedSeconds;
                  break;
                }
                accumulatedSeconds += fd;
              }
              break;
            }
          }
          
          logger.debug(
            {
              channelId: channel.id,
              currentTime: currentTime.toISOString(),
              elapsedSeconds: Math.round(elapsedSeconds),
              oldFileIndex: fileIndex,
              newFileIndex: targetFileIndex,
              oldPositionInFile: positionInFile,
              newPositionInFile: targetPositionInFile,
              reason: 'fileIndex out of bounds',
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Recalculating file index (out of bounds)'
          );
          fileIndex = targetFileIndex;
          positionInFile = targetPositionInFile;
        }
        // Otherwise, trust the current fileIndex and positionInFile - they're correct from program generation
      }

      if (currentMediaFiles.length === 0) {
        emptyMediaResolutions++;
        logger.warn(
          {
            channelId: channel.id,
            currentTime: currentTime.toISOString(),
            iteration: loopIterations,
            emptyResolutions: emptyMediaResolutions,
            totalResolutions: totalMediaResolutions,
            timeUntilEnd: Math.round((endTime.getTime() - currentTime.getTime()) / 1000 / 60) + ' minutes',
          },
          'EPG generateProgramsForDynamicPlaylistWithResolver: No media files available at this time, skipping ahead'
        );
        
        // Skip ahead by 1 hour and try again
        const previousTime = new Date(currentTime);
        currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);
        
        logger.debug(
          {
            channelId: channel.id,
            previousTime: previousTime.toISOString(),
            newTime: currentTime.toISOString(),
            skippedMinutes: 60,
          },
          'EPG generateProgramsForDynamicPlaylistWithResolver: Skipping ahead 1 hour'
        );
        
        if (currentTime >= endTime) {
          logger.info(
            {
              channelId: channel.id,
              currentTime: currentTime.toISOString(),
              endTime: endTime.toISOString(),
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Reached end time, breaking loop'
          );
          break;
        }
        continue;
      }

      // Generate programs from current media until we need to check again
      // Check every 5 minutes to catch schedule block transitions
      // BUT: Generate one program per file (full duration), don't split files into 5-minute chunks
      const checkInterval = 5 * 60 * 1000; // 5 minutes - only for checking schedule block changes
      // Calculate the next check time at the START of this interval, and don't recalculate it
      // This ensures we generate full-file programs even if they extend past the check interval
      const intervalStartTime = new Date(currentTime);
      const nextCheckTime = new Date(Math.min(
        intervalStartTime.getTime() + checkInterval,
        endTime.getTime()
      ));

      let programsGeneratedThisInterval = 0;
      // Generate programs - continue generating full-file programs until we've advanced past the check time
      // Then break to check for schedule changes. Don't break in the middle of a file!
      // The key is: generate the FULL file program, then check if we've passed nextCheckTime
      while (currentTime < endTime) {
        const mediaFile = currentMediaFiles[fileIndex % currentMediaFiles.length];
        
        if (!mediaFile) {
          logger.error(
            {
              channelId: channel.id,
              fileIndex,
              mediaFilesLength: currentMediaFiles.length,
              currentTime: currentTime.toISOString(),
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Media file is null/undefined at index'
          );
          break;
        }

        // Use duration from database (already cached from library scan)
        // If duration is inaccurate, it should be fixed during library scan, not here
        const fileDuration = mediaFile.metadata.duration;

        const remainingInFile = fileDuration - positionInFile;

        // Generate ONE program per file - use full file duration (or remaining in file)
        // Don't cap at check interval - that creates too many small programs
        // Only limit if we're about to exceed the end time
        const remainingUntilEnd = (endTime.getTime() - currentTime.getTime()) / 1000;
        let programDuration: number;
        
        if (isFirstProgram && positionInFile > 0) {
          // First program starts mid-file - use remaining in file
          programDuration = Math.min(remainingInFile, remainingUntilEnd);
        } else {
          // Full file - use full duration (or remaining until end)
          programDuration = Math.min(fileDuration, remainingUntilEnd);
        }

        if (programDuration < 1) {
          logger.debug(
            {
              channelId: channel.id,
              programDuration,
              remainingInFile,
              remainingUntilEnd,
              currentTime: currentTime.toISOString(),
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Program duration too small, breaking inner loop'
          );
          break; // Reached end
        }

        const programStart = new Date(currentTime);
        const programEnd = new Date(currentTime.getTime() + programDuration * 1000);

        const program = new Program(
          channel.id,
          programStart,
          programEnd,
          {
            title: mediaFile.getDisplayName(),
            description: this.generateDescription(mediaFile),
            category: this.determineCategory(mediaFile),
            episodeNum: this.formatEpisodeNumber(mediaFile),
            icon: undefined,
          }
        );

        programs.push(program);
        programsGeneratedThisInterval++;

        logger.debug(
          {
            channelId: channel.id,
            programTitle: mediaFile.getDisplayName(),
            programStart: programStart.toISOString(),
            programEnd: programEnd.toISOString(),
            programDuration: programDuration + ' seconds',
            fileDuration: fileDuration + ' seconds',
            totalPrograms: programs.length,
            fileIndex,
            positionInFile,
          },
          'EPG generateProgramsForDynamicPlaylistWithResolver: Generated program'
        );

        currentTime = programEnd;

        // Update position in file
        // Since we generate one program per file, we should always move to next file
        if (positionInFile + programDuration >= fileDuration) {
          fileIndex++;
          positionInFile = 0;
          logger.debug(
            {
              channelId: channel.id,
              newFileIndex: fileIndex,
              totalFiles: currentMediaFiles.length,
              programDuration: programDuration + ' seconds',
              fileDuration: fileDuration + ' seconds',
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Moved to next file'
          );
        } else {
          // This shouldn't happen often - means file was longer than remaining time
          positionInFile += programDuration;
          logger.debug(
            {
              channelId: channel.id,
              positionInFile,
              remainingInFile: fileDuration - positionInFile,
            },
            'EPG generateProgramsForDynamicPlaylistWithResolver: Partial file program (near end time)'
          );
        }

        isFirstProgram = false;
        
        // Only break to check for schedule changes AFTER we've generated a complete program
        // AND that program extends past the check time. This ensures we generate full-file programs.
        // The check interval is just for determining when to re-query PlaylistResolver, not for splitting programs.
        if (currentTime >= nextCheckTime) {
          // We've advanced past the check time - break to check for schedule block changes
          break;
        }

        // Safety check
        if (programs.length > 10000) {
          logger.warn({ channelId: channel.id }, 'EPG generation exceeded 10000 programs');
          return programs;
        }
      }

      logger.debug(
        {
          channelId: channel.id,
          iteration: loopIterations,
          programsGeneratedThisInterval,
          totalPrograms: programs.length,
          currentTime: currentTime.toISOString(),
          nextCheckTime: nextCheckTime.toISOString(),
        },
        'EPG generateProgramsForDynamicPlaylistWithResolver: Completed interval'
      );
    }

    logger.info(
      {
        channelId: channel.id,
        programCount: programs.length,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        loopIterations,
        totalMediaResolutions,
        emptyMediaResolutions,
        successRate: totalMediaResolutions > 0 ? ((totalMediaResolutions - emptyMediaResolutions) / totalMediaResolutions * 100).toFixed(1) + '%' : '0%',
        timeWindowHours: ((endTime.getTime() - startTime.getTime()) / 1000 / 60 / 60).toFixed(2),
      },
      'EPG generateProgramsForDynamicPlaylistWithResolver: EPG generation complete'
    );

    return programs;
  }

  /**
   * Generate EPG programs for a dynamic playlist channel (LEGACY METHOD)
   * Respects schedule block time windows and switches buckets at boundaries
   * This method is kept for backward compatibility but should use generateProgramsForDynamicPlaylistWithResolver instead
   */
  private async generateProgramsForDynamicPlaylist(
    channel: Channel,
    initialMediaFiles: MediaFile[],
    startTime: Date,
    endTime: Date,
    initialFileIndex: number,
    initialPositionInFile: number
  ): Promise<Program[]> {
    const programs: Program[] = [];
    let currentTime = new Date(startTime);
    let fileIndex = initialFileIndex;
    let positionInFile = initialPositionInFile;
    let isFirstProgram = true;

    // Get all enabled schedule blocks for this channel
    const allBlocks = await this.scheduleRepository.getEnabledBlocksForChannel(channel.id);
    
    logger.info(
      { 
        channelId: channel.id, 
        blockCount: allBlocks.length, 
        startTime: startTime.toISOString(), 
        endTime: endTime.toISOString(),
        blockNames: allBlocks.map(b => b.name).slice(0, 5) // Log first 5 block names
      },
      'Generating EPG for dynamic playlist with schedule blocks'
    );

    // If no schedule blocks exist, use fallback to channel buckets for entire time window
    if (allBlocks.length === 0) {
      logger.warn(
        { channelId: channel.id },
        'No schedule blocks configured for dynamic playlist channel, using channel buckets as fallback'
      );
      
      // Use channel buckets for entire EPG generation
      if (this.bucketService) {
        try {
          const mediaIds = await this.bucketService.getMediaFromChannelBuckets(channel.id);
          const mediaFilesWithNulls = await Promise.all(
            mediaIds.map(async (id: string) => {
              const mfRow = await this.mediaFileRepository.findById(id);
              if (mfRow) {
                return MediaFileRepository.rowToMediaFile(mfRow);
              }
              return null;
            })
          );
          const fallbackMedia = mediaFilesWithNulls.filter((f): f is MediaFile => f !== null);
          
          if (fallbackMedia.length > 0) {
            // Generate EPG using fallback media (treat as static playlist for this time window)
            logger.info({ channelId: channel.id, mediaCount: fallbackMedia.length }, 'Using channel buckets for EPG generation (no schedule blocks)');
            return await this.generateProgramsForStaticPlaylist(channel, fallbackMedia, startTime, endTime, fileIndex, positionInFile);
          }
        } catch (error) {
          logger.error({ error, channelId: channel.id }, 'Failed to get fallback media from channel buckets');
        }
      }
      
      // If still no media, return empty programs
      logger.warn({ channelId: channel.id }, 'No media available for EPG generation');
      return [];
    }

    while (currentTime < endTime) {
      // Find the active schedule block at current time
      const activeBlock = await this.getActiveBlockAtTime(channel.id, currentTime, allBlocks);
      
      logger.debug(
        {
          channelId: channel.id,
          currentTime: currentTime.toISOString(),
          hasActiveBlock: !!activeBlock,
          activeBlockName: activeBlock?.name,
          activeBlockBucketId: activeBlock?.bucket_id
        },
        'Checking for active schedule block'
      );
      
      let currentMediaFiles: MediaFile[];
      let playbackMode: 'sequential' | 'shuffle' | 'random' = 'sequential';
      
      if (activeBlock && activeBlock.bucket_id) {
        // Get media from the active block's bucket
        playbackMode = (activeBlock.playback_mode as 'sequential' | 'shuffle' | 'random') || 'sequential';
        
        try {
          const mediaIds = await this.bucketService!.getMediaInBucket(activeBlock.bucket_id);
          
          // Fetch full MediaFile objects
          const mediaFilesWithNulls = await Promise.all(
            mediaIds.map(async (id: string) => {
              const mfRow = await this.mediaFileRepository.findById(id);
              if (mfRow) {
                return MediaFileRepository.rowToMediaFile(mfRow);
              }
              return null;
            })
          );
          
          currentMediaFiles = mediaFilesWithNulls.filter((f): f is MediaFile => f !== null);
          
          // Apply playback mode (for EPG, we just use sequential order)
          if (playbackMode === 'shuffle' || playbackMode === 'random') {
            // For shuffle/random, we still show sequential EPG (actual playback will be shuffled)
            // This is acceptable - EPG shows what COULD play, not necessarily the exact order
          }
          
          // Reset file index when switching blocks (unless it's the first program)
          if (!isFirstProgram) {
            fileIndex = 0;
            positionInFile = 0;
          }
          
          logger.debug(
            {
              channelId: channel.id,
              blockName: activeBlock.name,
              bucketId: activeBlock.bucket_id,
              mediaCount: currentMediaFiles.length,
              currentTime: currentTime.toISOString(),
            },
            'Using active schedule block for EPG generation'
          );
        } catch (error) {
          logger.warn({ error, channelId: channel.id, bucketId: activeBlock.bucket_id }, 'Failed to get media from block bucket, using fallback');
          currentMediaFiles = initialMediaFiles;
        }
      } else {
        // No active block - use fallback to all channel buckets or initial media
        if (this.bucketService) {
          try {
            const mediaIds = await this.bucketService.getMediaFromChannelBuckets(channel.id);
            const mediaFilesWithNulls = await Promise.all(
              mediaIds.map(async (id: string) => {
                const mfRow = await this.mediaFileRepository.findById(id);
                if (mfRow) {
                  return MediaFileRepository.rowToMediaFile(mfRow);
                }
                return null;
              })
            );
            currentMediaFiles = mediaFilesWithNulls.filter((f): f is MediaFile => f !== null);
            
            if (currentMediaFiles.length === 0) {
              currentMediaFiles = initialMediaFiles;
            }
          } catch (error) {
            logger.warn({ error, channelId: channel.id }, 'Failed to get fallback media, using initial media');
            currentMediaFiles = initialMediaFiles;
          }
        } else {
          currentMediaFiles = initialMediaFiles;
        }
        
        // Reset file index when no active block (unless first program)
        if (!isFirstProgram && currentMediaFiles !== initialMediaFiles) {
          fileIndex = 0;
          positionInFile = 0;
        }
        
        logger.debug(
          { channelId: channel.id, currentTime: currentTime.toISOString(), mediaCount: currentMediaFiles.length },
          'No active schedule block, using fallback media'
        );
      }

      if (currentMediaFiles.length === 0) {
        logger.warn(
          { 
            channelId: channel.id, 
            currentTime: currentTime.toISOString(),
            hasActiveBlock: !!activeBlock,
            activeBlockName: activeBlock?.name,
            activeBlockBucketId: activeBlock?.bucket_id,
            blockCount: allBlocks.length,
            allBlockNames: allBlocks.map(b => b.name).slice(0, 5)
          }, 
          'No media files available for EPG generation at this time'
        );
        
        // For dynamic playlists, don't break immediately - check if there are future schedule blocks
        // Only break if we've exhausted all time slots or if we're past the end time
        // Skip to next block start time instead of breaking
        const nextBlockTime = this.findNextBlockStartTime(channel.id, currentTime, allBlocks);
        if (nextBlockTime && nextBlockTime < endTime && nextBlockTime > currentTime) {
          logger.info(
            { 
              channelId: channel.id, 
              currentTime: currentTime.toISOString(), 
              nextBlockTime: nextBlockTime.toISOString(),
              timeUntilNext: Math.round((nextBlockTime.getTime() - currentTime.getTime()) / 1000 / 60) + ' minutes'
            },
            'No media at current time, skipping to next schedule block'
          );
          currentTime = nextBlockTime;
          continue; // Continue loop to check next block
        } else {
          // No more schedule blocks in the future, break
          logger.info(
            { 
              channelId: channel.id, 
              currentTime: currentTime.toISOString(), 
              endTime: endTime.toISOString(),
              nextBlockTime: nextBlockTime?.toISOString(),
              reason: nextBlockTime ? 'next block is after endTime' : 'no next block found'
            },
            'No more schedule blocks found in time window, ending EPG generation'
          );
          break;
        }
      }

      // Determine block end time (when to switch to next block)
      let blockEndTime: Date;
      if (activeBlock) {
        // Calculate the actual end time for this block (considering day of week)
        blockEndTime = this.calculateBlockEndTime(currentTime, activeBlock);
      } else {
        // No active block - check when next block starts
        const nextBlockTime = this.findNextBlockStartTime(channel.id, currentTime, allBlocks);
        if (nextBlockTime && nextBlockTime < endTime) {
          blockEndTime = nextBlockTime;
        } else {
          blockEndTime = endTime;
        }
      }

      // Generate programs until block ends or we reach endTime
      while (currentTime < blockEndTime && currentTime < endTime) {
        const mediaFile = currentMediaFiles[fileIndex % currentMediaFiles.length];
        const fileDuration = mediaFile.metadata.duration;

        let programDuration: number;
        let programTitle: string;
        let programDescription: string | undefined;

        if (isFirstProgram && positionInFile > 0) {
          programDuration = Math.min(fileDuration - positionInFile, (blockEndTime.getTime() - currentTime.getTime()) / 1000);
          programTitle = mediaFile.getDisplayName();
          const remainingMinutes = Math.floor(programDuration / 60);
          programDescription = `In Progress (${remainingMinutes} min remaining) - ${this.generateDescription(mediaFile)}`;
          isFirstProgram = false;
        } else {
          // Limit program duration to not exceed block end time
          const maxDuration = (blockEndTime.getTime() - currentTime.getTime()) / 1000;
          programDuration = Math.min(fileDuration, maxDuration);
          programTitle = mediaFile.getDisplayName();
          programDescription = this.generateDescription(mediaFile);
          
          if (isFirstProgram) {
            isFirstProgram = false;
          }
        }

        // If program would be too short (less than 1 second), skip to next block
        if (programDuration < 1) {
          break;
        }

        const programStart = new Date(currentTime);
        const programEnd = new Date(currentTime.getTime() + programDuration * 1000);

        const program = new Program(
          channel.id,
          programStart,
          programEnd,
          {
            title: programTitle,
            description: programDescription,
            category: this.determineCategory(mediaFile),
            episodeNum: this.formatEpisodeNumber(mediaFile),
            icon: undefined,
          }
        );

        programs.push(program);

        currentTime = programEnd;
        
        // If we finished the file, move to next
        if (positionInFile + programDuration >= fileDuration) {
          fileIndex++;
          positionInFile = 0;
        } else {
          positionInFile += programDuration;
        }

        // Safety check
        if (programs.length > 10000) {
          logger.warn({ channelId: channel.id }, 'EPG generation exceeded 10000 programs');
          return programs;
        }
      }
    }

    return programs;
  }

  /**
   * Get active schedule block at a specific time
   * CRITICAL: Handles midnight wraparound (e.g., 23:00-01:00 blocks)
   */
  private async getActiveBlockAtTime(
    _channelId: string,
    time: Date,
    allBlocks: any[]
  ): Promise<any | null> {
    const dayOfWeek = time.getDay();
    const timeMinutes = time.getHours() * 60 + time.getMinutes();

    // Find blocks that match this time (handles midnight wraparound)
    // CRITICAL: Also check blocks for the previous day (for blocks ending at 00:00:00)
    // and next day (for blocks starting at 00:00:00)
    const previousDay = (dayOfWeek - 1 + 7) % 7; // Previous day (wraps around)
    const nextDay = (dayOfWeek + 1) % 7; // Next day (wraps around)
    
    const matchingBlocks = allBlocks.filter(block => {
      // Check day of week - need to check current day, previous day (for blocks ending at 00:00),
      // and next day (for blocks starting at 00:00)
      let dayMatches = false;
      if (block.day_of_week === null) {
        // Block applies to all days
        dayMatches = true;
      } else {
        // Check if block applies to current day
        if (block.day_of_week.includes(dayOfWeek)) {
          dayMatches = true;
        }
        // Also check previous day if we're at 00:00:00 (block might have started yesterday)
        if (timeMinutes === 0 && block.day_of_week.includes(previousDay)) {
          dayMatches = true;
        }
        // Also check next day if we're close to midnight (block might start at 00:00:00 tomorrow)
        // Actually, if we're checking at 23:59, we should check tomorrow's blocks that start at 00:00
        if (timeMinutes >= 23 * 60 && block.day_of_week.includes(nextDay)) {
          dayMatches = true;
        }
      }
      
      if (!dayMatches) {
        return false;
      }
      
      // Check time range (handles wraparound)
      const startMinutes = this.timeToMinutes(block.start_time);
      const endMinutes = this.timeToMinutes(block.end_time);
      
      let isActive = false;
      if (endMinutes > startMinutes) {
        // Normal case: 09:00-17:00
        isActive = timeMinutes >= startMinutes && timeMinutes < endMinutes;
      } else {
        // Wraparound case: 23:00-01:00 (spans midnight)
        isActive = timeMinutes >= startMinutes || timeMinutes < endMinutes;
      }
      
      return isActive;
    });

    if (matchingBlocks.length === 0) {
      return null;
    }

    // Sort by priority (highest first), then by creation time
    matchingBlocks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    return matchingBlocks[0];
  }

  /**
   * Calculate when a schedule block ends
   */
  /**
   * Convert time string (HH:MM:SS) to minutes since midnight
   */
  private timeToMinutes(timeStr: string): number {
    const [h, m, s] = timeStr.split(':').map(Number);
    return h * 60 + m + (s || 0) / 60;
  }

  private calculateBlockEndTime(currentTime: Date, block: any): Date {
    const blockEndTimeStr = block.end_time; // HH:MM:SS
    
    // Parse the time
    const [hours, minutes, seconds] = blockEndTimeStr.split(':').map(Number);
    
    // Create a date for today with the block's end time
    const blockEndToday = new Date(currentTime);
    blockEndToday.setHours(hours, minutes, seconds || 0, 0);
    
    // If block end time is before current time, it's tomorrow
    if (blockEndToday <= currentTime) {
      blockEndToday.setDate(blockEndToday.getDate() + 1);
    }
    
    return blockEndToday;
  }

  /**
   * Find when the next schedule block starts
   */
  private findNextBlockStartTime(_channelId: string, currentTime: Date, allBlocks: any[]): Date | null {
    const dayOfWeek = currentTime.getDay();
    const timeStr = currentTime.toTimeString().substring(0, 8);
    
    let nextStart: Date | null = null;
    
    // Check blocks for today
    for (const block of allBlocks) {
      if (block.day_of_week === null || block.day_of_week.includes(dayOfWeek)) {
        if (block.start_time > timeStr) {
          const [hours, minutes, seconds] = block.start_time.split(':').map(Number);
          const blockStart = new Date(currentTime);
          blockStart.setHours(hours, minutes, seconds || 0, 0);
          
          if (!nextStart || blockStart < nextStart) {
            nextStart = blockStart;
          }
        }
      }
    }
    
    // Also check tomorrow's blocks
    const tomorrow = new Date(currentTime);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowDayOfWeek = tomorrow.getDay();
    
    for (const block of allBlocks) {
      if (block.day_of_week === null || block.day_of_week.includes(tomorrowDayOfWeek)) {
        const [hours, minutes, seconds] = block.start_time.split(':').map(Number);
        const blockStart = new Date(tomorrow);
        blockStart.setHours(hours, minutes, seconds || 0, 0);
        
        if (!nextStart || blockStart < nextStart) {
          nextStart = blockStart;
        }
      }
    }
    
    return nextStart;
  }

  /**
   * Get current and next programs for a channel
   */
  public async getCurrentAndNext(
    channel: Channel,
    mediaFiles: MediaFile[]
  ): Promise<{ current: Program | null; next: Program | null }> {
    const programs = await this.generatePrograms(channel, mediaFiles);
    const now = new Date();

    const current = programs.find((p) => p.isAiring(now)) || null;
    const next = programs.find((p) => p.isUpcoming(now)) || null;

    return { current, next };
  }

  /**
   * Get file index that should be playing NOW according to EPG schedule (single source of truth)
   * Returns the file index that EPG says should be streaming at this moment
   * Returns null if EPG cannot determine (fallback to existing logic)
   */
  public async getCurrentFileIndexFromEPG(
    channel: Channel,
    mediaFiles: MediaFile[]
  ): Promise<number | null> {
    try {
      const programs = await this.generatePrograms(channel, mediaFiles);
      if (programs.length === 0) {
        logger.debug({ channelId: channel.id }, 'No EPG programs available');
        return null;
      }

      const now = new Date();

      // Find the currently airing program (what EPG says should be playing NOW)
      const currentProgram = programs.find((p) => p.isAiring(now));
      
      if (!currentProgram) {
        // No program currently airing - find next upcoming
        const nextProgram = programs.find((p) => p.isUpcoming(now));
        if (!nextProgram) {
          logger.debug({ channelId: channel.id }, 'No current or upcoming program in EPG');
          return null;
        }
        // Use next upcoming program's file
        const programIndex = programs.indexOf(nextProgram);
        return await this.mapProgramIndexToFileIndex(programIndex, programs, mediaFiles, channel);
      }

      // Found current program - map it to file index
      const programIndex = programs.indexOf(currentProgram);
      if (programIndex === -1) {
        logger.warn({ channelId: channel.id }, 'Program not found in programs array');
        return null;
      }

      // Check if current program is about to end (within last 5 seconds)
      // If so, use the next program's file instead
      const timeUntilEnd = currentProgram.endTime.getTime() - now.getTime();
      const secondsUntilEnd = Math.floor(timeUntilEnd / 1000);
      
      let targetProgramIndex = programIndex;
      if (secondsUntilEnd <= 5 && programIndex + 1 < programs.length) {
        // Current program ending soon - use next program
        targetProgramIndex = programIndex + 1;
        logger.debug(
          {
            channelId: channel.id,
            currentProgramIndex: programIndex,
            nextProgramIndex: targetProgramIndex,
            secondsUntilEnd,
          },
          'Current program ending soon, using next program from EPG'
        );
      }

      const fileIndex = await this.mapProgramIndexToFileIndex(targetProgramIndex, programs, mediaFiles, channel);
      
      logger.debug(
        {
          channelId: channel.id,
          programIndex: targetProgramIndex,
          fileIndex,
          programTitle: programs[targetProgramIndex].info.title,
        },
        'Determined current file index from EPG'
      );

      return fileIndex;
    } catch (error) {
      logger.warn(
        { error, channelId: channel.id },
        'Failed to get current file from EPG, will fall back to existing logic'
      );
      return null;
    }
  }

  /**
   * Map program index to file index
   * Programs map 1:1 to files (except first partial program)
   * Uses the same starting position logic as EPG generation
   */
  private async mapProgramIndexToFileIndex(
    programIndex: number,
    programs: Program[],
    mediaFiles: MediaFile[],
    channel: Channel
  ): Promise<number> {
    // Get the starting position used for EPG generation (same logic as generatePrograms)
    let startFileIndex: number;

    const schedulePosition = await this.scheduleTimeService.getCurrentPosition(
      channel.id,
      mediaFiles,
      programs[0]?.startTime || new Date()
    );

    if (schedulePosition) {
      // Use the same calculation as EPG generation
      startFileIndex = schedulePosition.fileIndex;
    } else {
      // No schedule time - use channel's current index (same as EPG generation fallback)
      startFileIndex = channel.getMetadata().currentIndex || 0;
    }
    
    // Calculate file index: programs map 1:1 to files (except first partial)
    // Program[0] = startFileIndex (possibly partial)
    // Program[1] = startFileIndex + 1
    // Program[N] = (startFileIndex + N) % mediaFiles.length
    if (programIndex === 0) {
      // First program - check if it's partial
      const firstProgramDuration = programs[0].duration;
      const startFile = mediaFiles[startFileIndex];
      const firstFileDuration = startFile?.metadata?.duration || 0;
      
      if (firstFileDuration > 0 && firstProgramDuration < firstFileDuration) {
        // First program is partial - we're still in the same file
        return startFileIndex;
      } else {
        // First program is full - we're in the next file
        return (startFileIndex + 1) % mediaFiles.length;
      }
    } else {
      // Later program - each program after the first corresponds to one file
      return (startFileIndex + programIndex) % mediaFiles.length;
    }
  }

  /**
   * Get what should be playing NOW based on EPG schedule (single source of truth)
   * Returns the file index and seek position that should be streaming at this moment
   */
  public async getCurrentPlaybackPosition(
    channel: Channel,
    mediaFiles: MediaFile[]
  ): Promise<{ fileIndex: number; seekPosition: number } | null> {
    const programs = await this.generatePrograms(channel, mediaFiles);
    const now = new Date();

    // Find the currently airing program
    const currentProgram = programs.find((p) => p.isAiring(now));
    if (!currentProgram) {
      return null; // No program currently airing
    }

    // CRITICAL: For dynamic playlists, we need to use the program's schedule block's media
    // Even if there's no active block at the current time, if the program is airing,
    // we should use the media from the program's original schedule block
    if (channel.config.useDynamicPlaylist && this.playlistResolver) {
      try {
        // Get the schedule block that was active when this program started
        // This is the block whose media we should use
        const programStartBlock = await this.scheduleRepository.getActiveBlock(channel.id, currentProgram.startTime);
        
        // Check what schedule block is active NOW (for logging only)
        const currentActiveBlock = await this.scheduleRepository.getActiveBlock(channel.id, now);
        
        const currentBlockId = currentActiveBlock?.id || null;
        const programBlockId = programStartBlock?.id || null;
        
        // If the program's block doesn't exist, we can't determine the correct media
        if (!programStartBlock) {
          logger.warn(
            {
              channelId: channel.id,
              currentTime: now.toISOString(),
              programStartTime: currentProgram.startTime.toISOString(),
              programTitle: currentProgram.info.title,
            },
            'Program\'s original schedule block not found - cannot determine correct media list'
          );
          // Don't return null here - let it continue and use the mediaFiles parameter
          // This handles edge cases where schedule blocks were deleted
        } else if (currentBlockId !== programBlockId) {
          // Blocks don't match - this is expected when a program spans across schedule block boundaries
          // or when there's no active block at the current time but the program is still airing
          logger.info(
            {
              channelId: channel.id,
              currentTime: now.toISOString(),
              programStartTime: currentProgram.startTime.toISOString(),
              currentActiveBlockId: currentBlockId,
              programBlockId: programBlockId,
              programTitle: currentProgram.info.title,
            },
            'Program is from a different schedule block than currently active (or no active block) - will use program\'s original block media'
          );
          // Continue - we'll use the program's original block media below
        } else {
          logger.debug(
            {
              channelId: channel.id,
              currentBlockId,
              programBlockId,
              programTitle: currentProgram.info.title,
            },
            'Program matches currently active schedule block'
          );
        }
      } catch (error) {
        logger.warn(
          { error, channelId: channel.id },
          'Failed to validate schedule block for current program, continuing anyway'
        );
        // Continue - better to play something than nothing if validation fails
      }
    }

    // Calculate how far into the current program we are (in seconds)
    const elapsedInProgram = Math.floor((now.getTime() - currentProgram.startTime.getTime()) / 1000);
    const elapsedInProgramSeconds = Math.max(0, elapsedInProgram);

    // Check if channel has schedule time initialized
    const hasScheduleTime = await this.scheduleTimeService.hasScheduleTime(channel.id);
    if (!hasScheduleTime) {
      // No schedule time - can't determine position from EPG accurately
      logger.debug({ channelId: channel.id }, 'No schedule time initialized for channel');
      return null;
    }

    // CRITICAL: For dynamic playlists, EPG uses PlaylistResolver which may return different media
    // than the mediaFiles parameter. We need to get the actual media list that EPG used for
    // the current program. For static playlists, use the mediaFiles parameter as-is.
    let actualMediaFiles: MediaFile[] = mediaFiles;
    
    if (channel.config.useDynamicPlaylist && this.playlistResolver) {
      // Get the media list that EPG actually used for the current program
      // Use the program's start time to get the correct schedule block's media
      const programStartTime = currentProgram.startTime;
      const context: PlaylistContext = {
        currentTime: programStartTime,
        currentIndex: 0, // Don't use currentIndex for media resolution
      };
      
      try {
        const epgMediaFiles = await this.playlistResolver.resolveMedia(channel.id, context);
        if (epgMediaFiles.length > 0) {
          actualMediaFiles = epgMediaFiles;
          logger.debug(
            {
              channelId: channel.id,
              programStartTime: programStartTime.toISOString(),
              epgMediaCount: epgMediaFiles.length,
              parameterMediaCount: mediaFiles.length,
            },
            'Using media list from PlaylistResolver that EPG actually used (dynamic playlist)'
          );
        } else {
          logger.warn(
            {
              channelId: channel.id,
              programStartTime: programStartTime.toISOString(),
            },
            'PlaylistResolver returned empty media for EPG program start time, using parameter mediaFiles'
          );
        }
      } catch (error) {
        logger.warn(
          { error, channelId: channel.id },
          'Failed to get EPG media list from PlaylistResolver, using parameter mediaFiles'
        );
      }
    }

    // CRITICAL: Use the same mapping logic that EPG uses to ensure consistency
    // This ensures the file index matches what EPG actually generated
    const currentProgramIndex = programs.indexOf(currentProgram);
    if (currentProgramIndex === -1) {
      logger.warn({ channelId: channel.id }, 'Current program not found in programs array');
      return null;
    }

    // Use the same mapProgramIndexToFileIndex method that getCurrentFileIndexFromEPG uses
    // This ensures consistency between EPG display and actual playback
    const fileIndex = await this.mapProgramIndexToFileIndex(
      currentProgramIndex,
      programs,
      actualMediaFiles,
      channel
    );

    logger.info(
      {
        channelId: channel.id,
        currentProgramIndex,
        fileIndex,
        programTitle: currentProgram.info.title,
        programStartTime: currentProgram.startTime.toISOString(),
        programEndTime: currentProgram.endTime.toISOString(),
        elapsedInProgramSeconds,
        actualMediaFilesCount: actualMediaFiles.length,
        fileAtIndex: actualMediaFiles[fileIndex]?.filename,
      },
      'EPG getCurrentPlaybackPosition: Mapped program to file index using same logic as EPG generation'
    );

    // Calculate seek position within the current file
    // For the first program, if it's partial, we need to account for the initial position
    let seekPosition: number;
    
    if (currentProgramIndex === 0) {
      // First program - check if it's partial
      const firstProgramDuration = programs[0].duration;
      const startFile = actualMediaFiles[fileIndex];
      const firstFileDuration = startFile?.metadata?.duration || 0;
      
      if (firstFileDuration > 0 && firstProgramDuration < firstFileDuration) {
        // First program is partial - we need to calculate the initial position
        // Get schedule position at EPG start time to find where we started in the file
        const epgStartTime = programs[0]?.startTime || now;
        const schedulePosition = await this.scheduleTimeService.getCurrentPosition(
          channel.id,
          actualMediaFiles,
          epgStartTime
        );
        const initialPositionInFile = schedulePosition?.seekPosition || 0;
        // Add elapsed time to initial position
        seekPosition = initialPositionInFile + elapsedInProgramSeconds;
      } else {
        // First program is full - elapsed time is the seek position
        seekPosition = elapsedInProgramSeconds;
      }
    } else {
      // Later program - elapsed time is the seek position (programs start at beginning of file)
      seekPosition = elapsedInProgramSeconds;
    }

    // Validate seek position doesn't exceed file duration
    const fileDuration = actualMediaFiles[fileIndex]?.metadata?.duration || 0;
    if (seekPosition >= fileDuration && fileDuration > 0) {
      // Moved to next file - this shouldn't happen if calculation is correct, but handle it
      logger.warn(
        {
          channelId: channel.id,
          fileIndex,
          seekPosition,
          fileDuration,
          programIndex: currentProgramIndex,
        },
        'Seek position exceeds file duration, adjusting to next file'
      );
      // Use next program's file instead
      if (currentProgramIndex + 1 < programs.length) {
        const nextFileIndex = await this.mapProgramIndexToFileIndex(
          currentProgramIndex + 1,
          programs,
          actualMediaFiles,
          channel
        );
        return {
          fileIndex: nextFileIndex,
          seekPosition: 0,
        };
      } else {
        // Wrap around
        return {
          fileIndex: (fileIndex + 1) % actualMediaFiles.length,
          seekPosition: 0,
        };
      }
    }

    return {
      fileIndex,
      seekPosition: Math.max(0, seekPosition),
    };
  }

  /**
   * Extract unique media files from EPG programs in schedule order
   * Used for concat file generation to ensure concat matches EPG
   *
   * @param programs - EPG programs (in chronological order)
   * @param mediaFiles - Available media files to map from
   * @returns Array of MediaFile objects in EPG order
   */
  public extractMediaFromPrograms(
    programs: Program[],
    mediaFiles: MediaFile[]
  ): MediaFile[] {
    const orderedMedia: MediaFile[] = [];
    const seen = new Set<string>();

    logger.debug(
      { programCount: programs.length, mediaFileCount: mediaFiles.length },
      'Extracting media from EPG programs for concat generation'
    );

    for (const program of programs) {
      // Find media file matching program title
      // Use multiple matching strategies to handle edge cases
      const mediaFile = mediaFiles.find(m => {
        const displayName = m.getDisplayName();
        const title = m.info?.title || '';
        const filename = m.filename;

        // Try exact match on display name
        if (displayName === program.info.title) return true;

        // Try exact match on title
        if (title === program.info.title) return true;

        // Try partial match on filename (case insensitive)
        if (filename.toLowerCase().includes(program.info.title.toLowerCase())) return true;

        return false;
      });

      // Add media file if found and not already added
      if (mediaFile && !seen.has(mediaFile.id)) {
        orderedMedia.push(mediaFile);
        seen.add(mediaFile.id);
      } else if (!mediaFile) {
        logger.warn(
          { programTitle: program.info.title, programStart: program.startTime },
          'No media file found matching EPG program'
        );
      }
    }

    logger.info(
      {
        programCount: programs.length,
        extractedCount: orderedMedia.length,
        uniqueFiles: seen.size
      },
      'Extracted media files from EPG programs'
    );

    return orderedMedia;
  }

  /**
   * Invalidate EPG cache for a channel
   * Call this when playlist/schedule changes
   */
  public async invalidateCache(channelId: string): Promise<void> {
    // Clear memory cache
    this.memoryCache.delete(channelId);

    // Clear database cache
    if (this.enableDatabaseCache) {
      try {
        await this.epgCacheRepository.invalidate(channelId);
        logger.info({ channelId }, 'EPG cache invalidated');
      } catch (error) {
        logger.warn({ error, channelId }, 'Failed to invalidate EPG database cache');
      }
    }
  }

  /**
   * Generate XML content for a single channel (for database storage)
   */
  private generateXML(programs: Program[], channel: Channel): string {
    const xmlLines: string[] = [];

    // XML header
    xmlLines.push('<?xml version="1.0" encoding="UTF-8"?>');
    xmlLines.push('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    xmlLines.push('<tv generator-info-name="HLS/IPTV Server">');

    // Channel definition
    xmlLines.push(`  <channel id="${this.escapeXml(channel.id)}">`);
    xmlLines.push(`    <display-name>${this.escapeXml(channel.config.name)}</display-name>`);
    xmlLines.push('  </channel>');

    // Programs
    for (const program of programs) {
      xmlLines.push(
        `  <programme start="${this.formatXMLTVTime(program.startTime)}" stop="${this.formatXMLTVTime(program.endTime)}" channel="${this.escapeXml(channel.id)}">`
      );
      xmlLines.push(`    <title>${this.escapeXml(program.info.title)}</title>`);
      if (program.info.description) {
        xmlLines.push(`    <desc>${this.escapeXml(program.info.description)}</desc>`);
      }
      if (program.info.category) {
        xmlLines.push(`    <category>${this.escapeXml(program.info.category)}</category>`);
      }
      if (program.info.episodeNum) {
        xmlLines.push(`    <episode-num system="onscreen">${this.escapeXml(program.info.episodeNum)}</episode-num>`);
      }
      xmlLines.push('  </programme>');
    }

    xmlLines.push('</tv>');
    return xmlLines.join('\n');
  }

  /**
   * Generate XMLTV format EPG for multiple channels
   */
  public async generateXMLTV(channels: Map<string, { channel: Channel; mediaFiles: MediaFile[] }>): Promise<string> {
    const now = new Date();
    const xmlLines: string[] = [];

    // XML header
    xmlLines.push('<?xml version="1.0" encoding="UTF-8"?>');
    xmlLines.push(
      '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
      '',
      `<tv generator-info-name="HLS/IPTV Server" generator-info-url="https://github.com/yourusername/hls-server">`
    );

    // Channel definitions
    for (const [channelId, data] of channels) {
      xmlLines.push(`  <channel id="${this.escapeXml(channelId)}">`);
      xmlLines.push(`    <display-name>${this.escapeXml(data.channel.config.name)}</display-name>`);
      xmlLines.push('  </channel>');
    }

    // Programs
    for (const [channelId, data] of channels) {
      logger.debug(
        {
          channelId,
          channelName: data.channel.config.name,
          useDynamic: data.channel.config.useDynamicPlaylist,
          mediaFilesCount: data.mediaFiles.length,
        },
        'EPG generateXMLTV: Generating programs for channel'
      );

      let programs: Program[];
      try {
        programs = await this.generatePrograms(data.channel, data.mediaFiles, now);
        logger.debug(
          {
            channelId,
            channelName: data.channel.config.name,
            programCount: programs.length,
          },
          'EPG generateXMLTV: Generated programs for channel'
        );
      } catch (error) {
        logger.error(
          {
            error,
            channelId,
            channelName: data.channel.config.name,
          },
          'EPG generateXMLTV: Failed to generate programs for channel, skipping'
        );
        continue; // Skip this channel if generation fails
      }

      for (const program of programs) {
        xmlLines.push(
          `  <programme start="${this.formatXMLTVTime(program.startTime)}" stop="${this.formatXMLTVTime(program.endTime)}" channel="${this.escapeXml(channelId)}">`
        );
        xmlLines.push(`    <title>${this.escapeXml(program.info.title)}</title>`);

        if (program.info.description) {
          xmlLines.push(`    <desc>${this.escapeXml(program.info.description)}</desc>`);
        }

        if (program.info.category) {
          xmlLines.push(`    <category>${this.escapeXml(program.info.category)}</category>`);
        }

        if (program.info.episodeNum) {
          xmlLines.push(`    <episode-num system="onscreen">${this.escapeXml(program.info.episodeNum)}</episode-num>`);
        }

        if (program.info.icon) {
          xmlLines.push(`    <icon src="${this.escapeXml(program.info.icon)}" />`);
        }

        xmlLines.push('  </programme>');
      }
    }

    xmlLines.push('</tv>');

    return xmlLines.join('\n');
  }

  /**
   * Clear EPG cache
   */
  public async clearCache(): Promise<void> {
    this.memoryCache.clear();
    
    // Also clear database cache
    if (this.enableDatabaseCache) {
      try {
        // Get all channels and invalidate their cache
        const allChannels = Array.from(this.memoryCache.keys());
        for (const channelId of allChannels) {
          await this.epgCacheRepository.invalidate(channelId);
        }
        logger.debug({ invalidatedChannels: allChannels.length }, 'Invalidated database cache for channels');
      } catch (error) {
        logger.warn({ error }, 'Failed to clear EPG database cache (non-fatal)');
      }
    }
    
    logger.info('EPG cache cleared (memory and database)');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return {
      entries: this.memoryCache.size,
      cacheMinutes: this.cacheMinutes,
      lookaheadHours: this.lookaheadHours,
    };
  }

  // Private helper methods

  /**
   * Round a date to the nearest minute to ensure cache key consistency
   */
  private roundToNearestMinute(date: Date): Date {
    const rounded = new Date(date);
    rounded.setSeconds(0, 0);
    return rounded;
  }

  private isCacheValid(generatedAt: Date): boolean {
    const age = Date.now() - generatedAt.getTime();
    const maxAge = this.cacheMinutes * 60 * 1000;
    return age < maxAge;
  }

  private generateDescription(mediaFile: MediaFile): string | undefined {
    const info = mediaFile.info;

    if (!info.season && !info.episode) {
      // Movie or special
      return `${mediaFile.getDurationFormatted()} - ${mediaFile.getFileSizeFormatted()}`;
    }

    // TV episode
    let desc = info.showName;
    if (info.season && info.episode) {
      desc += ` - Season ${info.season}, Episode ${info.episode}`;
    }
    desc += ` (${mediaFile.getDurationFormatted()})`;

    return desc;
  }

  private determineCategory(mediaFile: MediaFile): string {
    const showName = mediaFile.info.showName.toLowerCase();

    // Simple categorization based on keywords
    if (showName.includes('movie')) return 'Movie';
    if (mediaFile.info.season || mediaFile.info.episode) return 'Series';

    // Could be enhanced with genre detection
    return 'Video';
  }

  private formatEpisodeNumber(mediaFile: MediaFile): string | undefined {
    const { season, episode } = mediaFile.info;

    if (season && episode) {
      return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    }

    if (episode) {
      return `E${String(episode).padStart(2, '0')}`;
    }

    return undefined;
  }

  private formatXMLTVTime(date: Date): string {
    // Format: YYYYMMDDHHmmss +0000
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');

    return `${year}${month}${day}${hours}${minutes}${seconds} +0000`;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
