import { Database } from '../Database';
import { LibraryFolder, LibraryCategory } from '../../../domain/library/LibraryFolder';

export interface CreateLibraryFolderData {
  name: string;
  path: string;
  category: LibraryCategory;
  enabled?: boolean;
  recursive?: boolean;
}

export interface UpdateLibraryFolderData {
  name?: string;
  path?: string;
  category?: LibraryCategory;
  enabled?: boolean;
  recursive?: boolean;
}

export interface ScanResultData {
  durationMs: number;
  fileCount: number;
}

/**
 * Repository for library folder operations
 */
export class LibraryFolderRepository {
  /**
   * Create a new library folder
   */
  public async create(data: CreateLibraryFolderData): Promise<string> {
    const result = await Database.query<{ id: string }>(
      `INSERT INTO library_folders (name, path, category, enabled, recursive)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        data.name,
        data.path,
        data.category,
        data.enabled !== false,
        data.recursive !== false,
      ]
    );
    return result.rows[0].id;
  }

  /**
   * Find library folder by ID
   */
  public async findById(id: string): Promise<LibraryFolder | null> {
    const result = await Database.query(
      'SELECT * FROM library_folders WHERE id = $1',
      [id]
    );

    return result.rows[0] ? LibraryFolder.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Find library folder by path
   */
  public async findByPath(path: string): Promise<LibraryFolder | null> {
    const result = await Database.query(
      'SELECT * FROM library_folders WHERE path = $1',
      [path]
    );

    return result.rows[0] ? LibraryFolder.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Get all library folders
   */
  public async findAll(filters?: {
    enabled?: boolean;
    category?: LibraryCategory;
  }): Promise<LibraryFolder[]> {
    let query = 'SELECT * FROM library_folders WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.enabled !== undefined) {
      query += ` AND enabled = $${paramIndex++}`;
      params.push(filters.enabled);
    }

    if (filters?.category) {
      query += ` AND category = $${paramIndex++}`;
      params.push(filters.category);
    }

    query += ' ORDER BY name';

    const result = await Database.query(query, params);
    return result.rows.map((row) => LibraryFolder.fromDatabase(row));
  }

  /**
   * Update a library folder
   */
  public async update(id: string, data: UpdateLibraryFolderData): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(data.name);
    }

    if (data.path !== undefined) {
      updates.push(`path = $${paramIndex++}`);
      values.push(data.path);
    }

    if (data.category !== undefined) {
      updates.push(`category = $${paramIndex++}`);
      values.push(data.category);
    }

    if (data.enabled !== undefined) {
      updates.push(`enabled = $${paramIndex++}`);
      values.push(data.enabled);
    }

    if (data.recursive !== undefined) {
      updates.push(`recursive = $${paramIndex++}`);
      values.push(data.recursive);
    }

    if (updates.length === 0) {
      return;
    }

    values.push(id);
    await Database.query(
      `UPDATE library_folders SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * Record scan result
   */
  public async recordScan(id: string, data: ScanResultData): Promise<void> {
    await Database.query(
      `UPDATE library_folders
       SET last_scan_at = NOW(),
           last_scan_duration_ms = $1,
           last_scan_file_count = $2
       WHERE id = $3`,
      [data.durationMs, data.fileCount, id]
    );
  }

  /**
   * Delete a library folder
   */
  public async delete(id: string): Promise<void> {
    await Database.query('DELETE FROM library_folders WHERE id = $1', [id]);
  }

  /**
   * Get statistics for a library folder
   */
  public async getStats(id: string): Promise<{
    totalFiles: number;
    totalSize: number;
    lastScanAt: Date | null;
    lastScanFileCount: number;
  }> {
    const result = await Database.query<{
      total_files: string;
      total_size: string;
      last_scan_at: Date | null;
      last_scan_file_count: number;
    }>(
      `SELECT
        COUNT(mf.id) as total_files,
        COALESCE(SUM(mf.file_size), 0) as total_size,
        lf.last_scan_at,
        lf.last_scan_file_count
       FROM library_folders lf
       LEFT JOIN media_files mf ON mf.library_folder_id = lf.id
       WHERE lf.id = $1
       GROUP BY lf.id, lf.last_scan_at, lf.last_scan_file_count`,
      [id]
    );

    if (result.rows.length === 0) {
      return {
        totalFiles: 0,
        totalSize: 0,
        lastScanAt: null,
        lastScanFileCount: 0,
      };
    }

    const row = result.rows[0];
    return {
      totalFiles: parseInt(row.total_files),
      totalSize: parseInt(row.total_size),
      lastScanAt: row.last_scan_at,
      lastScanFileCount: row.last_scan_file_count,
    };
  }
}
