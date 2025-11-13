import { Database } from '../Database';
import { MediaFile, MediaFileMetadata, MediaFileInfo } from '../../../domain/media/MediaFile';

export interface MediaFileRow {
  id: string;
  path: string;
  filename: string;
  duration: number;
  file_size: number;
  resolution: string | null;
  codec: string | null;
  bitrate: number | null;
  fps: number | null;
  show_name: string | null;
  season: number | null;
  episode: number | null;
  title: string | null;
  file_exists: boolean;
  last_scanned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository for media file database operations
 */
export class MediaFileRepository {
  /**
   * Create or update media file (upsert)
   * Returns the actual ID from the database (may differ if file already existed)
   */
  public async upsert(mediaFile: MediaFile): Promise<string> {
    // First try to insert, but on conflict get the existing ID
    const result = await Database.query<{ id: string }>(
      `INSERT INTO media_files (
        id, path, filename, duration, file_size, resolution,
        codec, bitrate, fps, show_name, season, episode, title,
        file_exists, last_scanned_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (path) DO UPDATE SET
        filename = EXCLUDED.filename,
        duration = EXCLUDED.duration,
        file_size = EXCLUDED.file_size,
        resolution = EXCLUDED.resolution,
        codec = EXCLUDED.codec,
        bitrate = EXCLUDED.bitrate,
        fps = EXCLUDED.fps,
        show_name = EXCLUDED.show_name,
        season = EXCLUDED.season,
        episode = EXCLUDED.episode,
        title = EXCLUDED.title,
        file_exists = EXCLUDED.file_exists,
        last_scanned_at = EXCLUDED.last_scanned_at,
        updated_at = NOW()
      RETURNING id`,
      [
        mediaFile.id,
        mediaFile.path,
        mediaFile.filename,
        Math.round(mediaFile.metadata.duration), // Round to integer for INTEGER column
        mediaFile.metadata.fileSize,
        mediaFile.metadata.resolution || null,
        mediaFile.metadata.codec || null,
        mediaFile.metadata.bitrate || null,
        mediaFile.metadata.fps || null,
        mediaFile.info.showName || null,
        mediaFile.info.season || null,
        mediaFile.info.episode || null,
        mediaFile.info.title || null,
        true, // file_exists
        new Date(), // last_scanned_at
      ]
    );
    
    // Return the actual ID from database (may be existing ID if conflict occurred)
    return result.rows[0].id;
  }

  /**
   * Find by ID
   */
  public async findById(id: string): Promise<MediaFileRow | null> {
    const result = await Database.query<MediaFileRow>(
      'SELECT * FROM media_files WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find by path
   */
  public async findByPath(filePath: string): Promise<MediaFileRow | null> {
    const result = await Database.query<MediaFileRow>(
      'SELECT * FROM media_files WHERE path = $1',
      [filePath]
    );
    return result.rows[0] || null;
  }

  /**
   * Find all media files
   */
  public async findAll(includeDeleted: boolean = false): Promise<MediaFileRow[]> {
    const query = includeDeleted
      ? 'SELECT * FROM media_files ORDER BY created_at'
      : 'SELECT * FROM media_files WHERE file_exists = true ORDER BY created_at';
    
    const result = await Database.query<MediaFileRow>(query);
    return result.rows;
  }

  /**
   * Mark file as deleted (soft delete)
   */
  public async markAsDeleted(path: string): Promise<void> {
    await Database.query(
      'UPDATE media_files SET file_exists = false, updated_at = NOW() WHERE path = $1',
      [path]
    );
  }

  /**
   * Update library reference for a media file
   */
  public async updateLibraryReference(
    mediaFileId: string,
    libraryFolderId: string,
    category: string
  ): Promise<void> {
    const result = await Database.query(
      `UPDATE media_files
       SET library_folder_id = $1, category = $2, updated_at = NOW()
       WHERE id = $3`,
      [libraryFolderId, category, mediaFileId]
    );
    
    // If no rows were updated, the file might not exist - this shouldn't happen if upsert is called first
    if (result.rowCount === 0) {
      throw new Error(`Media file ${mediaFileId} not found in database. Ensure upsert is called first.`);
    }
  }

  /**
   * Delete all media files in a library
   */
  public async deleteByLibrary(libraryFolderId: string): Promise<number> {
    const result = await Database.query(
      'DELETE FROM media_files WHERE library_folder_id = $1',
      [libraryFolderId]
    );
    return result.rowCount || 0;
  }

  /**
   * Find media files by library
   */
  public async findByLibrary(
    libraryFolderId: string,
    filters?: { limit?: number; offset?: number }
  ): Promise<MediaFile[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    const result = await Database.query<MediaFileRow>(
      `SELECT * FROM media_files
       WHERE library_folder_id = $1 AND file_exists = true
       ORDER BY filename
       LIMIT $2 OFFSET $3`,
      [libraryFolderId, limit, offset]
    );

    return result.rows.map((row) => MediaFileRepository.rowToMediaFile(row));
  }

  /**
   * Search media files with filters
   */
  public async search(filters?: {
    category?: string;
    libraryId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<MediaFile[]> {
    let query = 'SELECT * FROM media_files WHERE file_exists = true';
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.libraryId) {
      query += ` AND library_folder_id = $${paramIndex++}`;
      params.push(filters.libraryId);
    }

    if (filters?.category) {
      query += ` AND category = $${paramIndex++}`;
      params.push(filters.category);
    }

    if (filters?.search) {
      query += ` AND (filename ILIKE $${paramIndex++} OR show_name ILIKE $${paramIndex} OR title ILIKE $${paramIndex})`;
      params.push(`%${filters.search}%`);
      paramIndex++;
    }

    query += ' ORDER BY filename';

    if (filters?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }

    if (filters?.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(filters.offset);
    }

    const result = await Database.query<MediaFileRow>(query, params);
    return result.rows.map((row) => MediaFileRepository.rowToMediaFile(row));
  }

  /**
   * Get all unique series names
   */
  public async getAllSeries(): Promise<string[]> {
    const result = await Database.query<{ show_name: string }>(
      `SELECT DISTINCT show_name 
       FROM media_files 
       WHERE file_exists = true AND show_name IS NOT NULL AND show_name != ''
       ORDER BY show_name`
    );
    return result.rows.map(row => row.show_name);
  }

  /**
   * Get all seasons for a series
   */
  public async getSeasonsForSeries(showName: string): Promise<number[]> {
    const result = await Database.query<{ season: number }>(
      `SELECT DISTINCT season 
       FROM media_files 
       WHERE file_exists = true AND show_name = $1 AND season IS NOT NULL
       ORDER BY season`,
      [showName]
    );
    return result.rows.map(row => row.season);
  }

  /**
   * Get all episodes for a series and season
   */
  public async getEpisodesForSeason(showName: string, season: number): Promise<MediaFile[]> {
    const result = await Database.query<MediaFileRow>(
      `SELECT * FROM media_files
       WHERE file_exists = true AND show_name = $1 AND season = $2
       ORDER BY episode NULLS LAST, filename`,
      [showName, season]
    );
    return result.rows.map((row) => MediaFileRepository.rowToMediaFile(row));
  }

  /**
   * Get all media files for a series (all seasons)
   */
  public async getMediaBySeries(showName: string): Promise<MediaFile[]> {
    const result = await Database.query<MediaFileRow>(
      `SELECT * FROM media_files
       WHERE file_exists = true AND show_name = $1
       ORDER BY season NULLS LAST, episode NULLS LAST, filename`,
      [showName]
    );
    return result.rows.map((row) => MediaFileRepository.rowToMediaFile(row));
  }

  /**
   * Get series statistics
   */
  public async getSeriesStats(showName: string): Promise<{
    totalEpisodes: number;
    totalSeasons: number;
    totalDuration: number;
    totalFileSize: number;
  }> {
    const result = await Database.query<{
      total_episodes: number;
      total_seasons: number;
      total_duration: number;
      total_file_size: number;
    }>(
      `SELECT 
         COUNT(*) as total_episodes,
         COUNT(DISTINCT season) as total_seasons,
         SUM(duration) as total_duration,
         SUM(file_size) as total_file_size
       FROM media_files
       WHERE file_exists = true AND show_name = $1`,
      [showName]
    );

    const row = result.rows[0];
    return {
      totalEpisodes: Number(row.total_episodes) || 0,
      totalSeasons: Number(row.total_seasons) || 0,
      totalDuration: Number(row.total_duration) || 0,
      totalFileSize: Number(row.total_file_size) || 0,
    };
  }

  /**
   * Get total count of all media files
   */
  public async getTotalCount(): Promise<number> {
    const result = await Database.query<{ count: string | number }>(
      'SELECT COUNT(*) as count FROM media_files WHERE file_exists = true'
    );
    const count = result.rows[0]?.count;
    return count ? Number(count) : 0;
  }

  /**
   * Convert database row to MediaFile entity
   */
  public static rowToMediaFile(row: MediaFileRow): MediaFile {
    const metadata: MediaFileMetadata = {
      duration: row.duration,
      fileSize: row.file_size,
      resolution: row.resolution || undefined,
      codec: row.codec || undefined,
      bitrate: row.bitrate || undefined,
      fps: row.fps || undefined,
    };

    const info: MediaFileInfo = {
      showName: row.show_name || '',
      season: row.season || undefined,
      episode: row.episode || undefined,
      title: row.title || undefined,
    };

    return new MediaFile(row.path, metadata, info, row.id, row.created_at);
  }
}

