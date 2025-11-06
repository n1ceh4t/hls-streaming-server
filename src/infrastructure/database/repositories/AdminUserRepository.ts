import { Database } from '../Database';
import { AdminUser } from '../../../domain/user/AdminUser';

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  email: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

/**
 * Repository for admin user database operations
 */
export class AdminUserRepository {
  /**
   * Create a new admin user
   */
  async create(data: {
    username: string;
    passwordHash: string;
    email?: string;
  }): Promise<AdminUser> {
    const result = await Database.query<AdminUserRow>(
      `INSERT INTO admin_users (username, password_hash, email)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.username, data.passwordHash, data.email || null]
    );

    return this.rowToDomain(result.rows[0]);
  }

  /**
   * Find user by username
   */
  async findByUsername(username: string): Promise<AdminUser | null> {
    const result = await Database.query<AdminUserRow>(
      'SELECT * FROM admin_users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToDomain(result.rows[0]);
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<AdminUser | null> {
    const result = await Database.query<AdminUserRow>(
      'SELECT * FROM admin_users WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToDomain(result.rows[0]);
  }

  /**
   * Check if any users exist
   */
  async hasUsers(): Promise<boolean> {
    const result = await Database.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM admin_users'
    );

    return parseInt(result.rows[0].count, 10) > 0;
  }

  /**
   * Update user last login
   */
  async updateLastLogin(userId: string): Promise<void> {
    await Database.query(
      'UPDATE admin_users SET last_login_at = NOW() WHERE id = $1',
      [userId]
    );
  }

  /**
   * Convert database row to domain model
   */
  private rowToDomain(row: AdminUserRow): AdminUser {
    return new AdminUser({
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      email: row.email || undefined,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at || undefined,
    });
  }
}

