import { Database } from '../Database';
import { randomUUID } from 'crypto';

export interface AdminSessionRow {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  last_used_at: Date;
}

export interface SessionData {
  id: string;
  userId: string;
  sessionToken: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * Repository for admin session database operations
 */
export class AdminSessionRepository {
  private readonly SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Create a new session
   */
  async create(data: {
    userId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<SessionData> {
    const sessionToken = randomUUID();
    const expiresAt = new Date(Date.now() + this.SESSION_DURATION_MS);

    const result = await Database.query<AdminSessionRow>(
      `INSERT INTO admin_sessions (user_id, session_token, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.userId, sessionToken, expiresAt, data.ipAddress || null, data.userAgent || null]
    );

    return this.rowToDomain(result.rows[0]);
  }

  /**
   * Find session by token
   */
  async findByToken(token: string): Promise<SessionData | null> {
    const result = await Database.query<AdminSessionRow>(
      `SELECT * FROM admin_sessions 
       WHERE session_token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToDomain(result.rows[0]);
  }

  /**
   * Update session last used timestamp
   */
  async updateLastUsed(token: string): Promise<void> {
    await Database.query(
      'UPDATE admin_sessions SET last_used_at = NOW() WHERE session_token = $1',
      [token]
    );
  }

  /**
   * Delete session by token
   */
  async deleteByToken(token: string): Promise<void> {
    await Database.query(
      'DELETE FROM admin_sessions WHERE session_token = $1',
      [token]
    );
  }

  /**
   * Delete all sessions for a user
   */
  async deleteByUserId(userId: string): Promise<void> {
    await Database.query(
      'DELETE FROM admin_sessions WHERE user_id = $1',
      [userId]
    );
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpired(): Promise<number> {
    const result = await Database.query<{ count: string }>(
      'DELETE FROM admin_sessions WHERE expires_at < NOW() RETURNING id'
    );

    return result.rows.length;
  }

  /**
   * Convert database row to domain model
   */
  private rowToDomain(row: AdminSessionRow): SessionData {
    return {
      id: row.id,
      userId: row.user_id,
      sessionToken: row.session_token,
      expiresAt: row.expires_at,
      ipAddress: row.ip_address || undefined,
      userAgent: row.user_agent || undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }
}
