import { MediaFile } from '../../domain/media/MediaFile';
import { MediaBucketService } from '../bucket/MediaBucketService';
import { MediaFileRepository } from '../../infrastructure/database/repositories/MediaFileRepository';
import { ScheduleRepository } from '../../infrastructure/database/repositories/ScheduleRepository';
import { createLogger } from '../../utils/logger';

const logger = createLogger('PlaylistResolver');

/**
 * Context for playlist resolution
 */
export interface PlaylistContext {
  /** Current virtual time (seconds) */
  virtualTime?: number;
  /** Current real-world time */
  currentTime?: Date;
  /** Current file index (for transition queries) */
  currentIndex?: number;
}

/**
 * PlaylistResolver - Resolves media files for channels dynamically
 * 
 * This is the foundation for dynamic playlist generation. Initially,
 * it provides a pass-through to bucket-based media (backward compatible),
 * but can be extended to support:
 * - Schedule-based content selection
 * - Time-based block resolution
 * - Bucket prioritization
 * - Override handling
 */
export interface IPlaylistResolver {
  /**
   * Resolve media files for a channel
   * 
   * @param channelId - Channel ID
   * @param context - Optional context (e.g., current time, virtual time)
   * @returns Array of media files that should be available for streaming
   */
  resolveMedia(channelId: string, context?: PlaylistContext): Promise<MediaFile[]>;
}

/**
 * Basic PlaylistResolver implementation
 * 
 * Integrates with schedule_blocks to provide time-based content selection.
 * Respects media buckets - schedules reference buckets, not individual files.
 */
export class PlaylistResolver implements IPlaylistResolver {
  private readonly mediaFileRepository: MediaFileRepository;
  private readonly scheduleRepository: ScheduleRepository;

  constructor(private readonly bucketService: MediaBucketService) {
    this.mediaFileRepository = new MediaFileRepository();
    this.scheduleRepository = new ScheduleRepository();
  }

  /**
   * Resolve media files for a channel
   * 
   * Priority:
   * 1. Check for active schedule block at current time
   * 2. If schedule block found, get media from that block's bucket
   * 3. Apply playback mode (sequential with progression, shuffle, random)
   * 4. If no schedule block, fall back to all buckets (backward compatible)
   * 5. Future: Check for content overrides
   * 6. Future: Apply bucket prioritization/mixing
   */
  async resolveMedia(channelId: string, context?: PlaylistContext): Promise<MediaFile[]> {
    logger.debug({ channelId, context }, 'Resolving media for channel');

    // Determine the time to use for schedule lookup
    const lookupTime = context?.currentTime || new Date();

    // Check for active schedule block
    const activeBlock = await this.scheduleRepository.getActiveBlock(channelId, lookupTime);
    
    // Log what we found for debugging
    if (activeBlock) {
      logger.info({
        channelId,
        activeBlockId: activeBlock.id,
        activeBlockName: activeBlock.name,
        activeBlockBucketId: activeBlock.bucket_id,
        activeBlockPlaybackMode: activeBlock.playback_mode,
        lookupTime: lookupTime.toISOString(),
        dayOfWeek: lookupTime.getDay(),
        timeStr: lookupTime.toTimeString().substring(0, 8),
      }, 'Found active schedule block');
    } else {
      logger.debug({
        channelId,
        lookupTime: lookupTime.toISOString(),
        dayOfWeek: lookupTime.getDay(),
        timeStr: lookupTime.toTimeString().substring(0, 8),
      }, 'No active schedule block found');
    }

    let mediaIds: string[];
    let playbackMode: 'sequential' | 'shuffle' | 'random' = 'sequential';

    if (activeBlock) {
      // Active schedule block found
      playbackMode = (activeBlock.playback_mode as 'sequential' | 'shuffle' | 'random') || 'sequential';
      
      if (activeBlock.bucket_id) {
        // Schedule block has a bucket - get media from the scheduled bucket
        logger.debug(
          { channelId, blockName: activeBlock.name, bucketId: activeBlock.bucket_id, playbackMode },
          'Found active schedule block with bucket, resolving media from scheduled bucket'
        );

        // Get media from the scheduled bucket
        logger.debug(
          { channelId, blockName: activeBlock.name, bucketId: activeBlock.bucket_id },
          'Attempting to get media from scheduled bucket'
        );
        
        mediaIds = await this.bucketService.getMediaInBucket(activeBlock.bucket_id);
        
        logger.info(
          { 
            channelId, 
            blockName: activeBlock.name, 
            bucketId: activeBlock.bucket_id, 
            mediaIdsCount: mediaIds.length,
            sampleMediaIds: mediaIds.slice(0, 3) // Log first 3 IDs for debugging
          },
          'Retrieved media IDs from scheduled bucket'
        );

        if (mediaIds.length === 0) {
          logger.warn(
            { channelId, blockName: activeBlock.name, bucketId: activeBlock.bucket_id },
            'Active schedule block bucket is empty, trying fallback buckets'
          );
          
          // Fallback: try to get media from all schedule block buckets
          const allBlocks = await this.scheduleRepository.getEnabledBlocksForChannel(channelId);
          const allMediaIds = new Set<string>();
          
          for (const block of allBlocks) {
            if (block.bucket_id && block.bucket_id !== activeBlock.bucket_id) {
              const blockMedia = await this.bucketService.getMediaInBucket(block.bucket_id);
              blockMedia.forEach(id => allMediaIds.add(id));
            }
          }
          
          mediaIds = Array.from(allMediaIds);
          
          if (mediaIds.length === 0) {
            // Still empty - final fallback to channel buckets
            logger.warn(
              { channelId, blockName: activeBlock.name },
              'All schedule block buckets are empty, falling back to channel buckets'
            );
            mediaIds = await this.bucketService.getMediaFromChannelBuckets(channelId);
          } else {
            logger.debug(
              { channelId, mediaCount: mediaIds.length },
              'Fallback: Using media from other schedule block buckets'
            );
          }
        } else {
          // Apply playback mode
          if (playbackMode === 'sequential') {
            // For sequential, check progression and start from saved position
            const progression = await this.bucketService.getProgression(channelId, activeBlock.bucket_id);
            if (progression && progression.currentPosition !== undefined && progression.currentPosition > 0) {
              // Start from saved position, but ensure we have media after it
              const startPosition = progression.currentPosition;
              if (startPosition < mediaIds.length) {
                // Rotate array to start from saved position
                const before = mediaIds.slice(0, startPosition);
                const after = mediaIds.slice(startPosition);
                mediaIds = [...after, ...before];
                logger.debug(
                  { channelId, bucketId: activeBlock.bucket_id, startPosition, totalMedia: mediaIds.length },
                  'Resuming sequential playback from saved position'
                );
              } else {
                // Invalid position - reset to beginning
                logger.warn(
                  { channelId, bucketId: activeBlock.bucket_id, startPosition, totalMedia: mediaIds.length },
                  'Progression position is out of bounds, starting from beginning'
                );
                // Reset progression to 0
                await this.bucketService.resetProgression(channelId, activeBlock.bucket_id);
              }
            } else {
              // No progression or position is 0 - start from beginning
              logger.debug(
                { channelId, bucketId: activeBlock.bucket_id, hasProgression: !!progression, position: progression?.currentPosition },
                'Starting sequential playback from beginning (no progression or position is 0)'
              );
            }
          } else if (playbackMode === 'shuffle') {
            // Shuffle: randomize order once, then play sequentially
            // Use a deterministic shuffle based on block ID to maintain consistency
            mediaIds = this.shuffleArray([...mediaIds], activeBlock.id);
            logger.debug({ channelId, bucketId: activeBlock.bucket_id }, 'Applied shuffle playback mode');
          } else if (playbackMode === 'random') {
            // Random: shuffle each time (no progression tracking)
            mediaIds = this.shuffleArray([...mediaIds]);
            logger.debug({ channelId, bucketId: activeBlock.bucket_id }, 'Applied random playback mode');
          }
        }
      } else {
        // Active block exists but has no bucket_id - fallback to all schedule block buckets or channel buckets
        logger.warn(
          { channelId, blockName: activeBlock.name },
          'Active schedule block has no bucket_id, falling back to all schedule block buckets'
        );
        
        const allBlocks = await this.scheduleRepository.getEnabledBlocksForChannel(channelId);
        const allMediaIds = new Set<string>();
        
        for (const block of allBlocks) {
          if (block.bucket_id) {
            const blockMedia = await this.bucketService.getMediaInBucket(block.bucket_id);
            blockMedia.forEach(id => allMediaIds.add(id));
          }
        }
        
        mediaIds = Array.from(allMediaIds);
        
        if (mediaIds.length === 0) {
          // Still empty - final fallback to channel buckets
          logger.warn(
            { channelId, blockName: activeBlock.name },
            'All schedule block buckets are empty, falling back to channel buckets'
          );
          mediaIds = await this.bucketService.getMediaFromChannelBuckets(channelId);
        }
      }
    } else {
      // No active schedule block - check if channel has any schedule blocks configured
      // If so, collect media from all buckets referenced by schedule blocks (fallback)
      // Otherwise, fall back to channel buckets directly assigned (backward compatible)
      const allBlocks = await this.scheduleRepository.getEnabledBlocksForChannel(channelId);
      
      if (allBlocks.length > 0) {
        // Channel has schedule blocks configured - collect media from all buckets in those blocks
        logger.debug(
          { channelId, lookupTime, blockCount: allBlocks.length },
          'No active schedule block, collecting media from all schedule block buckets'
        );
        
        const allMediaIds = new Set<string>();
        for (const block of allBlocks) {
          if (block.bucket_id) {
            const blockMedia = await this.bucketService.getMediaInBucket(block.bucket_id);
            blockMedia.forEach(id => allMediaIds.add(id));
          }
        }
        
        mediaIds = Array.from(allMediaIds);
        
        if (mediaIds.length === 0) {
          logger.warn(
            { channelId, blockCount: allBlocks.length },
            'All schedule block buckets are empty, falling back to channel buckets'
          );
          // Final fallback to channel buckets
          mediaIds = await this.bucketService.getMediaFromChannelBuckets(channelId);
        }
      } else {
        // No schedule blocks configured - use channel buckets (backward compatible)
        logger.debug({ channelId, lookupTime }, 'No schedule blocks configured, using all channel buckets');
        mediaIds = await this.bucketService.getMediaFromChannelBuckets(channelId);
      }
    }

    // TODO: Phase 3 - Check for content overrides
    // TODO: Phase 4 - Apply bucket prioritization/mixing

    // Fetch full MediaFile objects
    const mediaFiles = await Promise.all(
      mediaIds.map(async (id: string) => {
        const mfRow = await this.mediaFileRepository.findById(id);
        if (mfRow) {
          return MediaFileRepository.rowToMediaFile(mfRow);
        }
        return null;
      })
    );

    const validFiles = mediaFiles.filter((f): f is MediaFile => f !== null);
    const missingMediaIds = mediaIds.filter((_id, index) => mediaFiles[index] === null);

    if (validFiles.length === 0) {
      logger.warn(
        { 
          channelId, 
          activeBlock: activeBlock ? { name: activeBlock.name, bucketId: activeBlock.bucket_id } : null,
          mediaIdsCount: mediaIds.length,
          validFilesCount: validFiles.length,
          missingMediaIds: missingMediaIds.length > 0 ? missingMediaIds.slice(0, 5) : undefined, // Log first 5 missing IDs
          playbackMode,
        }, 
        'No valid media files found after resolution - channel will not be able to start streaming'
      );
      
      if (mediaIds.length > 0 && validFiles.length === 0) {
        logger.error(
          {
            channelId,
            bucketId: activeBlock?.bucket_id,
            mediaIdsCount: mediaIds.length,
            missingMediaIdsCount: missingMediaIds.length,
            sampleMissingIds: missingMediaIds.slice(0, 3),
          },
          'Bucket contains media IDs but media files do not exist in database - possible data inconsistency'
        );
      }
    } else {
      logger.debug(
        { 
          channelId, 
          mediaCount: validFiles.length,
          playbackMode,
          source: activeBlock ? `schedule:${activeBlock.name}` : 'all_buckets'
        }, 
        'Resolved media for channel'
      );
    }

    return validFiles;
  }

  /**
   * Shuffle array deterministically (for shuffle mode) or randomly (for random mode)
   * @param array - Array to shuffle
   * @param seed - Optional seed for deterministic shuffling (used for shuffle mode)
   */
  private shuffleArray<T>(array: T[], seed?: string): T[] {
    const shuffled = [...array];
    
    if (seed) {
      // Deterministic shuffle using seed (for shuffle mode - same block = same order)
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash) + seed.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
      }
      // Simple seeded random function
      let seedValue = Math.abs(hash);
      for (let i = shuffled.length - 1; i > 0; i--) {
        seedValue = (seedValue * 9301 + 49297) % 233280;
        const j = Math.floor((seedValue / 233280) * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    } else {
      // True random shuffle (for random mode)
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
    }
    
    return shuffled;
  }
}

