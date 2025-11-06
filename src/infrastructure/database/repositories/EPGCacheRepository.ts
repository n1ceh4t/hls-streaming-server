import { Database } from '../Database';

export interface EPGCacheRow {
  id: string;
  channel_id: string;
  xml_content: string;
  json_content: any;
  generated_at: Date;
  expires_at: Date;
}

export interface EPGCacheData {
  xmlContent: string;
  jsonContent: any;
  generatedAt: Date;
  expiresAt: Date;
}

/**
 * Repository for EPG cache database operations
 */
export class EPGCacheRepository {
  /**
   * Get cached EPG for a channel (if not expired)
   */
  public async findByChannel(channelId: string): Promise<EPGCacheData | null> {
    const result = await Database.query<EPGCacheRow>(
      `SELECT * FROM epg_cache
       WHERE channel_id = $1 AND expires_at > NOW()`,
      [channelId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      xmlContent: row.xml_content,
      jsonContent: row.json_content,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Save or update EPG cache for a channel
   */
  public async upsert(
    channelId: string,
    xmlContent: string,
    jsonContent: any,
    ttlMinutes: number = 120 // 2 hours default
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    await Database.query(
      `INSERT INTO epg_cache (channel_id, xml_content, json_content, generated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_id)
       DO UPDATE SET
         xml_content = EXCLUDED.xml_content,
         json_content = EXCLUDED.json_content,
         generated_at = EXCLUDED.generated_at,
         expires_at = EXCLUDED.expires_at`,
      [channelId, xmlContent, JSON.stringify(jsonContent), now, expiresAt]
    );
  }

  /**
   * Invalidate cache for a channel
   */
  public async invalidate(channelId: string): Promise<void> {
    await Database.query(
      'DELETE FROM epg_cache WHERE channel_id = $1',
      [channelId]
    );
  }

  /**
   * Clean up expired cache entries
   */
  public async cleanExpired(): Promise<number> {
    const result = await Database.query(
      'DELETE FROM epg_cache WHERE expires_at < NOW()'
    );
    return result.rowCount || 0;
  }

  /**
   * Get cache stats
   */
  public async getStats(): Promise<{
    totalEntries: number;
    expiredEntries: number;
    validEntries: number;
  }> {
    const result = await Database.query<{
      total: string;
      expired: string;
      valid: string;
    }>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE expires_at < NOW()) as expired,
        COUNT(*) FILTER (WHERE expires_at >= NOW()) as valid
       FROM epg_cache`
    );

    const row = result.rows[0];
    return {
      totalEntries: parseInt(row.total),
      expiredEntries: parseInt(row.expired),
      validEntries: parseInt(row.valid),
    };
  }
}
