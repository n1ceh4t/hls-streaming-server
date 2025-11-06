import { Database } from '../Database';
import { MediaBucket, BucketType } from '../../../domain/bucket/MediaBucket';

export interface CreateBucketData {
  name: string;
  bucketType: BucketType;
  description?: string;
}

export interface UpdateBucketData {
  name?: string;
  description?: string;
}

export interface BucketMediaData {
  bucketId: string;
  mediaFileId: string;
  position?: number;
}

export interface ChannelBucketData {
  channelId: string;
  bucketId: string;
  priority?: number;
}

export interface BucketProgressionData {
  channelId: string;
  bucketId: string;
  lastPlayedMediaId?: string;
  currentPosition?: number;
  currentSeason?: number;
  currentEpisode?: number;
}

/**
 * Repository for media bucket operations
 */
export class MediaBucketRepository {
  // ===== Media Bucket CRUD =====

  /**
   * Create a new media bucket
   */
  public async create(data: CreateBucketData): Promise<string> {
    const result = await Database.query<{ id: string }>(
      `INSERT INTO media_buckets (name, bucket_type, description)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [data.name, data.bucketType, data.description || null]
    );
    return result.rows[0].id;
  }

  /**
   * Find bucket by ID
   */
  public async findById(id: string): Promise<MediaBucket | null> {
    const result = await Database.query(
      'SELECT * FROM media_buckets WHERE id = $1',
      [id]
    );

    return result.rows[0] ? MediaBucket.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Find bucket by name
   */
  public async findByName(name: string): Promise<MediaBucket | null> {
    const result = await Database.query(
      'SELECT * FROM media_buckets WHERE name = $1',
      [name]
    );

    return result.rows[0] ? MediaBucket.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Get all buckets
   */
  public async findAll(bucketType?: BucketType): Promise<MediaBucket[]> {
    const query = bucketType
      ? 'SELECT * FROM media_buckets WHERE bucket_type = $1 ORDER BY name'
      : 'SELECT * FROM media_buckets ORDER BY name';

    const params = bucketType ? [bucketType] : [];
    const result = await Database.query(query, params);

    return result.rows.map((row) => MediaBucket.fromDatabase(row));
  }

  /**
   * Update a bucket
   */
  public async update(id: string, data: UpdateBucketData): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }

    if (data.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }

    if (updates.length === 0) {
      return;
    }

    values.push(id);
    await Database.query(
      `UPDATE media_buckets SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * Delete a bucket
   */
  public async delete(id: string): Promise<void> {
    await Database.query('DELETE FROM media_buckets WHERE id = $1', [id]);
  }

  // ===== Bucket-Media Associations =====

  /**
   * Add media file to bucket
   */
  public async addMediaToBucket(data: BucketMediaData): Promise<void> {
    const position = data.position ?? 0;

    await Database.query(
      `INSERT INTO bucket_media (bucket_id, media_file_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (bucket_id, media_file_id) DO UPDATE SET position = EXCLUDED.position`,
      [data.bucketId, data.mediaFileId, position]
    );
  }

  /**
   * Remove media file from bucket
   */
  public async removeMediaFromBucket(bucketId: string, mediaFileId: string): Promise<void> {
    await Database.query(
      'DELETE FROM bucket_media WHERE bucket_id = $1 AND media_file_id = $2',
      [bucketId, mediaFileId]
    );
  }

  /**
   * Get all media files in a bucket (ordered by position)
   */
  public async getMediaInBucket(bucketId: string): Promise<Array<{ mediaFileId: string; position: number }>> {
    const result = await Database.query<{ media_file_id: string; position: number }>(
      `SELECT media_file_id, position
       FROM bucket_media
       WHERE bucket_id = $1
       ORDER BY position ASC`,
      [bucketId]
    );

    return result.rows.map((row) => ({
      mediaFileId: row.media_file_id,
      position: row.position,
    }));
  }

  /**
   * Reorder media in bucket
   */
  public async reorderMedia(bucketId: string, mediaFileIds: string[]): Promise<void> {
    // Update positions for all media files in the bucket
    for (let i = 0; i < mediaFileIds.length; i++) {
      await Database.query(
        `UPDATE bucket_media
         SET position = $1
         WHERE bucket_id = $2 AND media_file_id = $3`,
        [i, bucketId, mediaFileIds[i]]
      );
    }
  }

  // ===== Channel-Bucket Associations =====

  /**
   * Associate bucket with channel
   */
  public async addBucketToChannel(data: ChannelBucketData): Promise<void> {
    const priority = data.priority ?? 1;

    await Database.query(
      `INSERT INTO channel_buckets (channel_id, bucket_id, priority)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, bucket_id) DO UPDATE SET priority = EXCLUDED.priority`,
      [data.channelId, data.bucketId, priority]
    );
  }

  /**
   * Remove bucket from channel
   */
  public async removeBucketFromChannel(channelId: string, bucketId: string): Promise<void> {
    await Database.query(
      'DELETE FROM channel_buckets WHERE channel_id = $1 AND bucket_id = $2',
      [channelId, bucketId]
    );
  }

  /**
   * Get all buckets for a channel
   */
  public async getBucketsForChannel(channelId: string): Promise<MediaBucket[]> {
    const result = await Database.query(
      `SELECT mb.*
       FROM media_buckets mb
       INNER JOIN channel_buckets cb ON mb.id = cb.bucket_id
       WHERE cb.channel_id = $1
       ORDER BY cb.priority DESC, mb.name`,
      [channelId]
    );

    return result.rows.map((row) => MediaBucket.fromDatabase(row));
  }

  /**
   * Get all channels using a bucket
   */
  public async getChannelsForBucket(bucketId: string): Promise<string[]> {
    const result = await Database.query<{ channel_id: string }>(
      'SELECT channel_id FROM channel_buckets WHERE bucket_id = $1',
      [bucketId]
    );

    return result.rows.map((row) => row.channel_id);
  }

  // ===== Bucket Progression =====

  /**
   * Get or create progression for channel-bucket
   */
  public async getProgression(channelId: string, bucketId: string): Promise<BucketProgressionData | null> {
    const result = await Database.query<{
      channel_id: string;
      bucket_id: string;
      last_played_media_id: string | null;
      current_position: number;
      current_season: number | null;
      current_episode: number | null;
      last_played_at: Date | null;
    }>(
      `SELECT * FROM channel_bucket_progression
       WHERE channel_id = $1 AND bucket_id = $2`,
      [channelId, bucketId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      channelId: row.channel_id,
      bucketId: row.bucket_id,
      lastPlayedMediaId: row.last_played_media_id || undefined,
      currentPosition: row.current_position,
      currentSeason: row.current_season || undefined,
      currentEpisode: row.current_episode || undefined,
    };
  }

  /**
   * Update progression for channel-bucket
   */
  public async updateProgression(data: BucketProgressionData): Promise<void> {
    await Database.query(
      `INSERT INTO channel_bucket_progression
        (channel_id, bucket_id, last_played_media_id, current_position, current_season, current_episode, last_played_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (channel_id, bucket_id)
       DO UPDATE SET
         last_played_media_id = EXCLUDED.last_played_media_id,
         current_position = EXCLUDED.current_position,
         current_season = EXCLUDED.current_season,
         current_episode = EXCLUDED.current_episode,
         last_played_at = NOW()`,
      [
        data.channelId,
        data.bucketId,
        data.lastPlayedMediaId || null,
        data.currentPosition ?? 0,
        data.currentSeason || null,
        data.currentEpisode || null,
      ]
    );
  }

  /**
   * Reset progression for channel-bucket
   */
  public async resetProgression(channelId: string, bucketId: string): Promise<void> {
    await Database.query(
      `UPDATE channel_bucket_progression
       SET current_position = 0,
           current_season = NULL,
           current_episode = NULL,
           last_played_media_id = NULL,
           last_played_at = NULL
       WHERE channel_id = $1 AND bucket_id = $2`,
      [channelId, bucketId]
    );
  }

  // ===== Statistics =====

  /**
   * Get bucket statistics
   */
  public async getStats(bucketId: string): Promise<{
    totalMedia: number;
    channelsUsing: number;
  }> {
    // Get media count - COUNT(*) always returns a value, even if 0
    const mediaResult = await Database.query<{ count: number | string }>(
      'SELECT COUNT(*) as count FROM bucket_media WHERE bucket_id = $1',
      [bucketId]
    );

    // Get channel count
    const channelsResult = await Database.query<{ count: number | string }>(
      'SELECT COUNT(*) as count FROM channel_buckets WHERE bucket_id = $1',
      [bucketId]
    );

    // Convert to number (PostgreSQL COUNT returns as string in some cases)
    const mediaCount = mediaResult.rows[0]?.count 
      ? Number(mediaResult.rows[0].count)
      : 0;
    
    const channelCount = channelsResult.rows[0]?.count 
      ? Number(channelsResult.rows[0].count)
      : 0;

    return {
      totalMedia: Number.isNaN(mediaCount) ? 0 : mediaCount,
      channelsUsing: Number.isNaN(channelCount) ? 0 : channelCount,
    };
  }

  // ===== Bucket Libraries =====

  /**
   * Assign library to bucket
   */
  public async assignLibraryToBucket(bucketId: string, libraryFolderId: string): Promise<void> {
    // Check if already assigned
    const existing = await Database.query<{ id: string }>(
      'SELECT id FROM bucket_libraries WHERE bucket_id = $1 AND library_folder_id = $2',
      [bucketId, libraryFolderId]
    );

    if (existing.rows.length > 0) {
      return; // Already assigned
    }

    await Database.query(
      'INSERT INTO bucket_libraries (bucket_id, library_folder_id) VALUES ($1, $2)',
      [bucketId, libraryFolderId]
    );
  }

  /**
   * Remove library from bucket
   */
  public async removeLibraryFromBucket(bucketId: string, libraryFolderId: string): Promise<void> {
    await Database.query(
      'DELETE FROM bucket_libraries WHERE bucket_id = $1 AND library_folder_id = $2',
      [bucketId, libraryFolderId]
    );
  }

  /**
   * Get all libraries assigned to a bucket
   */
  public async getLibrariesForBucket(bucketId: string): Promise<Array<{ id: string; name: string; path: string; category: string }>> {
    const result = await Database.query<{ id: string; name: string; path: string; category: string }>(
      `SELECT lf.id, lf.name, lf.path, lf.category
       FROM library_folders lf
       INNER JOIN bucket_libraries bl ON lf.id = bl.library_folder_id
       WHERE bl.bucket_id = $1
       ORDER BY lf.name`,
      [bucketId]
    );

    return result.rows;
  }

  /**
   * Get all buckets assigned to a library
   */
  public async getBucketsForLibrary(libraryFolderId: string): Promise<string[]> {
    const result = await Database.query<{ bucket_id: string }>(
      'SELECT bucket_id FROM bucket_libraries WHERE library_folder_id = $1',
      [libraryFolderId]
    );

    return result.rows.map((row) => row.bucket_id);
  }
}
