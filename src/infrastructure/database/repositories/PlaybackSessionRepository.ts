import { Database } from '../Database';

export type SessionType = 'started' | 'resumed' | 'viewer_reconnect' | 'manual';

export interface PlaybackSessionRow {
  id: string;
  channel_id: string;
  session_start: Date;
  session_end: Date | null;
  duration_seconds: number | null;
  virtual_time_at_start: number;
  virtual_time_at_end: number | null;
  session_type: SessionType;
  triggered_by: string | null;
  created_at: Date;
}

export interface CreateSessionData {
  channelId: string;
  sessionStart: Date;
  virtualTimeAtStart?: number; // Optional - for backward compatibility during migration
  sessionType: SessionType;
  triggeredBy?: string;
}

export interface EndSessionData {
  sessionEnd: Date;
  virtualTimeAtEnd?: number; // Optional - for backward compatibility during migration
}

/**
 * Repository for playback session tracking
 */
export class PlaybackSessionRepository {
  /**
   * Create a new playback session
   */
  public async create(data: CreateSessionData): Promise<string> {
    const result = await Database.query<{ id: string }>(
      `INSERT INTO playback_sessions (
        channel_id,
        session_start,
        virtual_time_at_start,
        session_type,
        triggered_by
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id`,
      [
        data.channelId,
        data.sessionStart,
        data.virtualTimeAtStart || 0, // Default to 0 if not provided
        data.sessionType,
        data.triggeredBy || null,
      ]
    );

    return result.rows[0].id;
  }

  /**
   * End an active session
   */
  public async endSession(sessionId: string, data: EndSessionData): Promise<void> {
    await Database.query(
      `UPDATE playback_sessions
       SET session_end = $1,
           virtual_time_at_end = $2,
           duration_seconds = EXTRACT(EPOCH FROM ($1 - session_start))::INTEGER
       WHERE id = $3`,
      [data.sessionEnd, data.virtualTimeAtEnd || 0, sessionId] // Default to 0 if not provided
    );
  }

  /**
   * Get active session for a channel (session without end time)
   */
  public async getActiveSession(channelId: string): Promise<PlaybackSessionRow | null> {
    const result = await Database.query<PlaybackSessionRow>(
      `SELECT * FROM playback_sessions
       WHERE channel_id = $1 AND session_end IS NULL
       ORDER BY session_start DESC
       LIMIT 1`,
      [channelId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get all sessions for a channel
   */
  public async findByChannel(channelId: string, limit: number = 100): Promise<PlaybackSessionRow[]> {
    const result = await Database.query<PlaybackSessionRow>(
      `SELECT * FROM playback_sessions
       WHERE channel_id = $1
       ORDER BY session_start DESC
       LIMIT $2`,
      [channelId, limit]
    );

    return result.rows;
  }

  /**
   * Get session statistics for a channel
   */
  public async getStats(channelId: string): Promise<{
    totalSessions: number;
    totalUptime: number; // seconds
    averageSessionLength: number; // seconds
    lastSession: Date | null;
  }> {
    const result = await Database.query<{
      total_sessions: string;
      total_uptime: string;
      avg_session_length: string;
      last_session: Date | null;
    }>(
      `SELECT
        COUNT(*) as total_sessions,
        COALESCE(SUM(duration_seconds), 0) as total_uptime,
        COALESCE(AVG(duration_seconds), 0) as avg_session_length,
        MAX(session_start) as last_session
       FROM playback_sessions
       WHERE channel_id = $1 AND session_end IS NOT NULL`,
      [channelId]
    );

    const row = result.rows[0];
    return {
      totalSessions: parseInt(row.total_sessions),
      totalUptime: parseInt(row.total_uptime),
      averageSessionLength: Math.round(parseFloat(row.avg_session_length)),
      lastSession: row.last_session,
    };
  }

  /**
   * Clean up old sessions (older than specified days)
   */
  public async cleanOldSessions(olderThanDays: number = 90): Promise<number> {
    const result = await Database.query(
      `DELETE FROM playback_sessions
       WHERE session_start < NOW() - INTERVAL '${olderThanDays} days'`,
      []
    );

    return result.rowCount || 0;
  }
}
