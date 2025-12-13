import { Database } from '../Database';
import { Channel, ChannelConfig, ChannelState } from '../../../domain/channel/Channel';

export interface ChannelRow {
  id: string;
  name: string;
  slug: string;
  output_dir: string;
  video_bitrate: number;
  audio_bitrate: number;
  resolution: string;
  fps: number;
  segment_duration: number;
  auto_start: boolean;
  use_dynamic_playlist: boolean | null;
  include_bumpers: boolean | null;
  watermark_image_base64: string | null;
  watermark_position: string | null;
  state: string;
  current_index: number;
  viewer_count: number;
  started_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  virtual_start_time: Date | null;
  virtual_paused_at: Date | null;
  total_virtual_seconds: number;
  virtual_current_index: number;
  virtual_position_in_file: number;
  created_at: Date;
  updated_at: Date;
}

export interface ChannelUpdateData {
  state?: ChannelState;
  current_index?: number;
  viewer_count?: number;
  started_at?: Date | null;
  last_error?: string | null;
  last_error_at?: Date | null;
  virtual_start_time?: Date | null;
  virtual_paused_at?: Date | null;
  total_virtual_seconds?: number;
  virtual_current_index?: number;
  virtual_position_in_file?: number;
  use_dynamic_playlist?: boolean;
  include_bumpers?: boolean;
  auto_start?: boolean;
  watermark_image_base64?: string | null;
  watermark_position?: string | null;
}

/**
 * Repository for channel database operations
 */
export class ChannelRepository {
  /**
   * Create a new channel
   */
  public async create(channel: Channel): Promise<void> {
    const config = channel.config;
    const now = new Date(); // Use current time for schedule_start_time when creating channel
    await Database.query(
      `INSERT INTO channels (
        id, name, slug, output_dir, video_bitrate, audio_bitrate,
        resolution, fps, segment_duration, auto_start, use_dynamic_playlist, include_bumpers, 
        watermark_image_base64, watermark_position, state,
        current_index, viewer_count, virtual_start_time,
        total_virtual_seconds, virtual_current_index, virtual_position_in_file, schedule_start_time
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )`,
      [
        channel.id,
        config.name,
        config.slug,
        config.outputDir,
        config.videoBitrate,
        config.audioBitrate,
        config.resolution,
        config.fps,
        config.segmentDuration,
        config.autoStart || false,
        config.useDynamicPlaylist || false,
        config.includeBumpers !== false, // Default to true for backward compatibility (undefined/null → true)
        config.watermarkImageBase64 || null,
        config.watermarkPosition || null,
        channel.getState(),
        channel.getMetadata().currentIndex,
        channel.getMetadata().viewerCount,
        null, // virtual_start_time (set on first stream start)
        channel.getMetadata().accumulatedTime || 0, // total_virtual_seconds
        0, // virtual_current_index
        0, // virtual_position_in_file
        now, // schedule_start_time - set to current time when channel is created
      ]
    );
  }

  /**
   * Find channel by ID
   */
  public async findById(id: string): Promise<ChannelRow | null> {
    const result = await Database.query<ChannelRow>(
      'SELECT * FROM channels WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find channel by slug
   */
  public async findBySlug(slug: string): Promise<ChannelRow | null> {
    const result = await Database.query<ChannelRow>(
      'SELECT * FROM channels WHERE slug = $1',
      [slug]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all channels
   */
  public async findAll(): Promise<ChannelRow[]> {
    const result = await Database.query<ChannelRow>('SELECT * FROM channels ORDER BY created_at');
    return result.rows;
  }

  /**
   * Update channel
   */
  public async update(id: string, data: ChannelUpdateData): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.state !== undefined) {
      updates.push(`state = $${paramIndex++}`);
      values.push(data.state);
    }
    if (data.current_index !== undefined) {
      updates.push(`current_index = $${paramIndex++}`);
      values.push(data.current_index);
    }
    if (data.viewer_count !== undefined) {
      updates.push(`viewer_count = $${paramIndex++}`);
      values.push(data.viewer_count);
    }
    if (data.started_at !== undefined) {
      updates.push(`started_at = $${paramIndex++}`);
      values.push(data.started_at);
    }
    if (data.last_error !== undefined) {
      updates.push(`last_error = $${paramIndex++}`);
      values.push(data.last_error);
    }
    if (data.last_error_at !== undefined) {
      updates.push(`last_error_at = $${paramIndex++}`);
      values.push(data.last_error_at);
    }
    if (data.virtual_start_time !== undefined) {
      updates.push(`virtual_start_time = $${paramIndex++}`);
      values.push(data.virtual_start_time);
    }
    if (data.virtual_paused_at !== undefined) {
      updates.push(`virtual_paused_at = $${paramIndex++}`);
      values.push(data.virtual_paused_at);
    }
    if (data.total_virtual_seconds !== undefined) {
      updates.push(`total_virtual_seconds = $${paramIndex++}`);
      values.push(data.total_virtual_seconds);
    }
    if (data.virtual_current_index !== undefined) {
      updates.push(`virtual_current_index = $${paramIndex++}`);
      values.push(data.virtual_current_index);
    }
    if (data.virtual_position_in_file !== undefined) {
      updates.push(`virtual_position_in_file = $${paramIndex++}`);
      values.push(data.virtual_position_in_file);
    }
    if (data.use_dynamic_playlist !== undefined) {
      updates.push(`use_dynamic_playlist = $${paramIndex++}`);
      values.push(data.use_dynamic_playlist);
    }
    if (data.include_bumpers !== undefined) {
      updates.push(`include_bumpers = $${paramIndex++}`);
      values.push(data.include_bumpers);
    }
    if (data.auto_start !== undefined) {
      updates.push(`auto_start = $${paramIndex++}`);
      values.push(data.auto_start);
    }
    if (data.watermark_image_base64 !== undefined) {
      updates.push(`watermark_image_base64 = $${paramIndex++}`);
      values.push(data.watermark_image_base64);
    }
    if (data.watermark_position !== undefined) {
      updates.push(`watermark_position = $${paramIndex++}`);
      values.push(data.watermark_position);
    }

    if (updates.length === 0) {
      return; // No updates
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    await Database.query(
      `UPDATE channels SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * Delete channel
   */
  public async delete(id: string): Promise<void> {
    await Database.query('DELETE FROM channels WHERE id = $1', [id]);
  }

  /**
   * Convert database row to Channel entity
   */
  public static rowToChannel(row: ChannelRow): Channel {
    const config: ChannelConfig = {
      name: row.name,
      slug: row.slug,
      outputDir: row.output_dir,
      videoBitrate: row.video_bitrate,
      audioBitrate: row.audio_bitrate,
      resolution: row.resolution,
      fps: row.fps,
      segmentDuration: row.segment_duration,
      autoStart: row.auto_start,
      useDynamicPlaylist: row.use_dynamic_playlist || false,
      includeBumpers: row.include_bumpers !== false, // Default to true if null for backward compatibility
      watermarkImageBase64: row.watermark_image_base64 || undefined,
      watermarkPosition: (row.watermark_position as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center') || undefined,
    };

    const channel = new Channel(config, row.id, row.state as ChannelState, {
      currentIndex: row.current_index,
      accumulatedTime: row.total_virtual_seconds, // Map to accumulated for backward compat
      viewerCount: row.viewer_count,
      startedAt: row.started_at || undefined,
      lastError: row.last_error || undefined,
      lastErrorAt: row.last_error_at || undefined,
    });

    return channel;
  }
}

