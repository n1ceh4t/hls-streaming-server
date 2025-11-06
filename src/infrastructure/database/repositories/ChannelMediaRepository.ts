import { PoolClient } from 'pg';
import { Database } from '../Database';

export interface ChannelMediaRow {
  id: string;
  channel_id: string;
  media_file_id: string;
  position: number;
  added_at: Date;
}

/**
 * Repository for channel-media relationships
 */
export class ChannelMediaRepository {
  /**
   * Set media files for a channel (replaces existing)
   */
  public async setChannelMedia(channelId: string, mediaFileIds: string[]): Promise<void> {
    await Database.transaction(async (client: PoolClient) => {
      // Delete existing relationships
      await client.query('DELETE FROM channel_media WHERE channel_id = $1', [channelId]);

      // Insert new relationships
      if (mediaFileIds.length > 0) {
        const values: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (let i = 0; i < mediaFileIds.length; i++) {
          values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
          params.push(channelId, mediaFileIds[i], i);
        }

        await client.query(
          `INSERT INTO channel_media (channel_id, media_file_id, position)
           VALUES ${values.join(', ')}`,
          params
        );
      }
    });
  }

  /**
   * Get media files for a channel (ordered by position)
   */
  public async getChannelMedia(channelId: string): Promise<ChannelMediaRow[]> {
    const result = await Database.query<ChannelMediaRow>(
      `SELECT cm.*, mf.id as media_file_id, mf.path, mf.filename, mf.duration
       FROM channel_media cm
       JOIN media_files mf ON cm.media_file_id = mf.id
       WHERE cm.channel_id = $1 AND mf.file_exists = true
       ORDER BY cm.position`,
      [channelId]
    );
    return result.rows;
  }

  /**
   * Add media file to channel at position
   */
  public async addMediaToChannel(
    channelId: string,
    mediaFileId: string,
    position: number
  ): Promise<void> {
    await Database.query(
      `INSERT INTO channel_media (channel_id, media_file_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, position) DO UPDATE SET
         media_file_id = EXCLUDED.media_file_id`,
      [channelId, mediaFileId, position]
    );
  }

  /**
   * Remove media file from channel
   */
  public async removeMediaFromChannel(
    channelId: string,
    mediaFileId: string
  ): Promise<void> {
    await Database.query(
      'DELETE FROM channel_media WHERE channel_id = $1 AND media_file_id = $2',
      [channelId, mediaFileId]
    );
  }

  /**
   * Reorder media files in channel
   */
  public async reorderMedia(channelId: string, mediaFileIds: string[]): Promise<void> {
    await Database.transaction(async (client: PoolClient) => {
      // Delete all existing
      await client.query('DELETE FROM channel_media WHERE channel_id = $1', [channelId]);

      // Insert in new order
      if (mediaFileIds.length > 0) {
        const values: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        for (let i = 0; i < mediaFileIds.length; i++) {
          values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
          params.push(channelId, mediaFileIds[i], i);
        }

        await client.query(
          `INSERT INTO channel_media (channel_id, media_file_id, position)
           VALUES ${values.join(', ')}`,
          params
        );
      }
    });
  }
}

