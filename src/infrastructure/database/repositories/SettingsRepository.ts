import { Database } from '../Database';
import { logger } from '../../../utils/logger';

export interface SettingRow {
  id: string;
  key: string;
  value: string | null;
  description: string | null;
  updated_at: Date;
  created_at: Date;
}

/**
 * Repository for global settings database operations
 */
export class SettingsRepository {
  /**
   * Get a setting value by key
   * Returns null if table doesn't exist (migration not run yet) or key not found
   */
  public async get(key: string): Promise<string | null> {
    try {
      const result = await Database.query<SettingRow>(
        'SELECT value FROM global_settings WHERE key = $1',
        [key]
      );
      return result.rows[0]?.value || null;
    } catch (error: any) {
      // Handle case where table doesn't exist (migration not run yet)
      if (error?.code === '42P01') {
        // Table doesn't exist - migration not run yet
        return null;
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Set a setting value by key
   */
  public async set(key: string, value: string, description?: string): Promise<void> {
    await Database.query(
      `INSERT INTO global_settings (key, value, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) 
       DO UPDATE SET value = EXCLUDED.value, description = COALESCE(EXCLUDED.description, global_settings.description), updated_at = NOW()`,
      [key, value, description || null]
    );
    logger.debug({ key, value }, 'Setting updated');
  }

  /**
   * Get all settings
   * Returns empty object if table doesn't exist (migration not run yet)
   */
  public async getAll(): Promise<Record<string, string>> {
    try {
      const result = await Database.query<SettingRow>(
        'SELECT key, value FROM global_settings'
      );
      const settings: Record<string, string> = {};
      for (const row of result.rows) {
        if (row.value !== null) {
          settings[row.key] = row.value;
        }
      }
      return settings;
    } catch (error: any) {
      // Handle case where table doesn't exist (migration not run yet)
      if (error?.code === '42P01') {
        // Table doesn't exist - migration not run yet
        return {};
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get multiple settings by keys
   * Returns all null if table doesn't exist (migration not run yet)
   */
  public async getMultiple(keys: string[]): Promise<Record<string, string | null>> {
    if (keys.length === 0) {
      return {};
    }
    try {
      const result = await Database.query<SettingRow>(
        'SELECT key, value FROM global_settings WHERE key = ANY($1::varchar[])',
        [keys]
      );
      const settings: Record<string, string | null> = {};
      for (const key of keys) {
        settings[key] = null;
      }
      for (const row of result.rows) {
        settings[row.key] = row.value;
      }
      return settings;
    } catch (error: any) {
      // Handle case where table doesn't exist (migration not run yet)
      if (error?.code === '42P01') {
        // Table doesn't exist - return all null
        const settings: Record<string, string | null> = {};
        for (const key of keys) {
          settings[key] = null;
        }
        return settings;
      }
      // Re-throw other errors
      throw error;
    }
  }
}

