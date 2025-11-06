import { MediaBucket, BucketType } from '../../domain/bucket/MediaBucket';
import { MediaBucketRepository, CreateBucketData, UpdateBucketData, BucketProgressionData } from '../../infrastructure/database/repositories/MediaBucketRepository';
import { MediaFileRepository } from '../../infrastructure/database/repositories/MediaFileRepository';
import { createLogger } from '../../utils/logger';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';

const logger = createLogger('MediaBucketService');

/**
 * Service for managing media buckets and their associations
 */
export class MediaBucketService {
  private readonly bucketRepository: MediaBucketRepository;
  private readonly mediaFileRepository: MediaFileRepository;

  constructor() {
    this.bucketRepository = new MediaBucketRepository();
    this.mediaFileRepository = new MediaFileRepository();
  }

  // ===== Bucket Management =====

  /**
   * Create a new media bucket
   */
  public async createBucket(data: CreateBucketData): Promise<MediaBucket> {
    // Validate bucket name
    if (!data.name || data.name.trim().length === 0) {
      throw new ValidationError('Bucket name is required');
    }

    // Check if bucket with same name exists
    const existing = await this.bucketRepository.findByName(data.name);
    if (existing) {
      throw new ConflictError(`Bucket with name '${data.name}' already exists`);
    }

    logger.info({ name: data.name, type: data.bucketType }, 'Creating new media bucket');

    const bucketId = await this.bucketRepository.create(data);
    const bucket = await this.bucketRepository.findById(bucketId);

    if (!bucket) {
      throw new Error('Failed to create bucket');
    }

    logger.info({ bucketId, name: data.name }, 'Media bucket created successfully');

    return bucket;
  }

  /**
   * Get bucket by ID
   */
  public async getBucket(bucketId: string): Promise<MediaBucket> {
    const bucket = await this.bucketRepository.findById(bucketId);
    if (!bucket) {
      throw new NotFoundError(`Bucket '${bucketId}' not found`);
    }
    return bucket;
  }

  /**
   * Get all buckets
   */
  public async getAllBuckets(bucketType?: BucketType): Promise<MediaBucket[]> {
    return this.bucketRepository.findAll(bucketType);
  }

  /**
   * Update bucket
   */
  public async updateBucket(bucketId: string, data: UpdateBucketData): Promise<MediaBucket> {
    const bucket = await this.getBucket(bucketId);

    // If updating name, check for conflicts
    if (data.name && data.name !== bucket.getName()) {
      const existing = await this.bucketRepository.findByName(data.name);
      if (existing) {
        throw new ConflictError(`Bucket with name '${data.name}' already exists`);
      }
    }

    logger.info({ bucketId, updates: data }, 'Updating media bucket');

    await this.bucketRepository.update(bucketId, data);

    const updated = await this.bucketRepository.findById(bucketId);
    if (!updated) {
      throw new Error('Failed to update bucket');
    }

    logger.info({ bucketId }, 'Media bucket updated successfully');

    return updated;
  }

  /**
   * Delete bucket
   */
  public async deleteBucket(bucketId: string): Promise<void> {
    await this.getBucket(bucketId); // Verify exists

    logger.info({ bucketId }, 'Deleting media bucket');

    await this.bucketRepository.delete(bucketId);

    logger.info({ bucketId }, 'Media bucket deleted successfully');
  }

  // ===== Bucket-Media Management =====

  /**
   * Add media files to bucket
   */
  public async addMediaToBucket(bucketId: string, mediaFileIds: string[]): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists

    logger.info({ bucketId, count: mediaFileIds.length }, 'Adding media files to bucket');

    // Verify all media files exist
    for (const mediaFileId of mediaFileIds) {
      const mediaFile = await this.mediaFileRepository.findById(mediaFileId);
      if (!mediaFile) {
        throw new NotFoundError(`Media file '${mediaFileId}' not found`);
      }
    }

    // Get current max position in bucket
    const existingMedia = await this.bucketRepository.getMediaInBucket(bucketId);
    let nextPosition = existingMedia.length > 0
      ? Math.max(...existingMedia.map(m => m.position)) + 1
      : 0;

    // Add each media file
    for (const mediaFileId of mediaFileIds) {
      await this.bucketRepository.addMediaToBucket({
        bucketId,
        mediaFileId,
        position: nextPosition++,
      });
    }

    logger.info({ bucketId, count: mediaFileIds.length }, 'Media files added to bucket');
  }

  /**
   * Remove media file from bucket
   */
  public async removeMediaFromBucket(bucketId: string, mediaFileId: string): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists

    logger.info({ bucketId, mediaFileId }, 'Removing media file from bucket');

    await this.bucketRepository.removeMediaFromBucket(bucketId, mediaFileId);

    logger.info({ bucketId, mediaFileId }, 'Media file removed from bucket');
  }

  /**
   * Get all media files in bucket
   */
  public async getMediaInBucket(bucketId: string): Promise<string[]> {
    const { createLogger } = await import('../../utils/logger');
    const logger = createLogger('MediaBucketService');
    
    try {
      await this.getBucket(bucketId); // Verify bucket exists
    } catch (error) {
      logger.error({ bucketId, error }, 'Bucket not found when getting media');
      throw error;
    }

    const media = await this.bucketRepository.getMediaInBucket(bucketId);
    const mediaFileIds = media.map(m => m.mediaFileId);
    
    logger.debug(
      { bucketId, mediaCount: media.length, mediaFileIdsCount: mediaFileIds.length },
      'Retrieved media from bucket repository'
    );
    
    return mediaFileIds;
  }

  /**
   * Reorder media in bucket
   */
  public async reorderMedia(bucketId: string, mediaFileIds: string[]): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists

    logger.info({ bucketId, count: mediaFileIds.length }, 'Reordering media in bucket');

    await this.bucketRepository.reorderMedia(bucketId, mediaFileIds);

    logger.info({ bucketId }, 'Media reordered successfully');
  }

  // ===== Channel-Bucket Management =====

  /**
   * Associate bucket with channel
   */
  public async addBucketToChannel(channelId: string, bucketId: string, priority: number = 1): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists

    logger.info({ channelId, bucketId, priority }, 'Associating bucket with channel');

    await this.bucketRepository.addBucketToChannel({
      channelId,
      bucketId,
      priority,
    });

    logger.info({ channelId, bucketId }, 'Bucket associated with channel');
  }

  /**
   * Remove bucket from channel
   */
  public async removeBucketFromChannel(channelId: string, bucketId: string): Promise<void> {
    logger.info({ channelId, bucketId }, 'Removing bucket from channel');

    await this.bucketRepository.removeBucketFromChannel(channelId, bucketId);

    logger.info({ channelId, bucketId }, 'Bucket removed from channel');
  }

  /**
   * Get all buckets for a channel
   */
  public async getBucketsForChannel(channelId: string): Promise<MediaBucket[]> {
    return this.bucketRepository.getBucketsForChannel(channelId);
  }

  /**
   * Get all channels using a bucket
   */
  public async getChannelsForBucket(bucketId: string): Promise<string[]> {
    await this.getBucket(bucketId); // Verify bucket exists

    return this.bucketRepository.getChannelsForBucket(bucketId);
  }

  // ===== Progression Management =====

  /**
   * Get progression for channel-bucket
   */
  public async getProgression(channelId: string, bucketId: string): Promise<BucketProgressionData | null> {
    return this.bucketRepository.getProgression(channelId, bucketId);
  }

  /**
   * Update progression for channel-bucket
   */
  public async updateProgression(data: BucketProgressionData): Promise<void> {
    logger.debug({ ...data }, 'Updating bucket progression');

    await this.bucketRepository.updateProgression(data);
  }

  /**
   * Reset progression for channel-bucket
   */
  public async resetProgression(channelId: string, bucketId: string): Promise<void> {
    logger.info({ channelId, bucketId }, 'Resetting bucket progression');

    await this.bucketRepository.resetProgression(channelId, bucketId);

    logger.info({ channelId, bucketId }, 'Bucket progression reset');
  }

  /**
   * Get next media file for channel from bucket (considering progression)
   */
  public async getNextMedia(channelId: string, bucketId: string): Promise<string | null> {
    await this.getBucket(bucketId); // Verify bucket exists

    // Get current progression
    const progression = await this.bucketRepository.getProgression(channelId, bucketId);
    const currentPosition = progression?.currentPosition ?? 0;

    // Get all media in bucket
    const media = await this.bucketRepository.getMediaInBucket(bucketId);

    if (media.length === 0) {
      return null;
    }

    // Get next media file (wrap around if at end)
    const nextPosition = (currentPosition + 1) % media.length;
    const nextMediaFile = media.find(m => m.position === nextPosition);

    if (!nextMediaFile) {
      // Fallback to first file if position not found
      return media[0].mediaFileId;
    }

    // Update progression
    await this.bucketRepository.updateProgression({
      channelId,
      bucketId,
      lastPlayedMediaId: nextMediaFile.mediaFileId,
      currentPosition: nextPosition,
    });

    return nextMediaFile.mediaFileId;
  }

  /**
   * Get all media files from all buckets assigned to a channel
   */
  public async getMediaFromChannelBuckets(channelId: string): Promise<string[]> {
    const { createLogger } = await import('../../utils/logger');
    const logger = createLogger('MediaBucketService');
    
    logger.info({ channelId }, 'getMediaFromChannelBuckets: Starting');
    
    // Get all buckets for this channel
    const buckets = await this.bucketRepository.getBucketsForChannel(channelId);
    logger.info({ channelId, bucketCount: buckets.length, bucketIds: buckets.map(b => b.getId()) }, 'getMediaFromChannelBuckets: Got buckets for channel');
    
    if (buckets.length === 0) {
      logger.warn({ channelId }, 'getMediaFromChannelBuckets: No buckets found for channel');
      return [];
    }
    
    // Collect all unique media file IDs from all buckets
    const allMediaIds = new Set<string>();
    
    for (const bucket of buckets) {
      const bucketId = bucket.getId();
      logger.debug({ channelId, bucketId }, 'getMediaFromChannelBuckets: Getting media from bucket');
      const media = await this.bucketRepository.getMediaInBucket(bucketId);
      logger.debug({ channelId, bucketId, mediaCount: media.length }, 'getMediaFromChannelBuckets: Got media from bucket');
      media.forEach(m => allMediaIds.add(m.mediaFileId));
    }
    
    const result = Array.from(allMediaIds);
    logger.info({ channelId, totalMediaIds: result.length, sampleIds: result.slice(0, 5) }, 'getMediaFromChannelBuckets: Complete');
    return result;
  }

  /**
   * Get total media count from all buckets assigned to a channel
   */
  public async getChannelMediaCount(channelId: string): Promise<number> {
    const mediaIds = await this.getMediaFromChannelBuckets(channelId);
    return mediaIds.length;
  }

  // ===== Library Management =====

  /**
   * Assign a library to a bucket
   * Immediately adds all existing media files from the library to the bucket
   */
  public async assignLibraryToBucket(bucketId: string, libraryFolderId: string): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists
    
    // Assign the library
    await this.bucketRepository.assignLibraryToBucket(bucketId, libraryFolderId);
    
    // Get all media files from this library (no limit - get all)
    const libraryMedia = await this.mediaFileRepository.findByLibrary(libraryFolderId, { limit: 100000 });
    const mediaFileIds = libraryMedia.map(m => m.id);
    
    // Add all media files to the bucket
    if (mediaFileIds.length > 0) {
      await this.addMediaToBucket(bucketId, mediaFileIds);
      logger.info({ bucketId, libraryFolderId, mediaCount: mediaFileIds.length }, 'Library assigned to bucket and media added');
    } else {
      logger.info({ bucketId, libraryFolderId }, 'Library assigned to bucket (no media files found)');
    }
  }

  /**
   * Remove a library from a bucket
   */
  public async removeLibraryFromBucket(bucketId: string, libraryFolderId: string): Promise<void> {
    await this.getBucket(bucketId); // Verify bucket exists
    
    await this.bucketRepository.removeLibraryFromBucket(bucketId, libraryFolderId);
    
    logger.info({ bucketId, libraryFolderId }, 'Library removed from bucket');
  }

  /**
   * Get all libraries assigned to a bucket
   */
  public async getLibrariesForBucket(bucketId: string): Promise<Array<{ id: string; name: string; path: string; category: string }>> {
    await this.getBucket(bucketId); // Verify bucket exists
    
    return this.bucketRepository.getLibrariesForBucket(bucketId);
  }

  /**
   * Get all buckets assigned to a library
   */
  public async getBucketsForLibrary(libraryFolderId: string): Promise<string[]> {
    return this.bucketRepository.getBucketsForLibrary(libraryFolderId);
  }

  // ===== Statistics =====

  /**
   * Get bucket statistics
   */
  public async getStats(bucketId: string): Promise<{
    totalMedia: number;
    channelsUsing: number;
  }> {
    await this.getBucket(bucketId); // Verify bucket exists

    return this.bucketRepository.getStats(bucketId);
  }
}
