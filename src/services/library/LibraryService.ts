import { LibraryFolder, LibraryCategory } from '../../domain/library/LibraryFolder';
import { LibraryFolderRepository, CreateLibraryFolderData, UpdateLibraryFolderData } from '../../infrastructure/database/repositories/LibraryFolderRepository';
import { MediaFileRepository } from '../../infrastructure/database/repositories/MediaFileRepository';
import { MediaScanner } from '../media/MediaScanner';
import { createLogger } from '../../utils/logger';
import { ValidationError, NotFoundError, ConflictError } from '../../utils/errors';
import { MediaFile } from '../../domain/media/MediaFile';
import { validateLibraryPath } from '../../utils/pathSecurity';
import { config } from '../../config/env';
import fs from 'fs/promises';

const logger = createLogger('LibraryService');

/**
 * Service for managing media libraries (Jellyfin-style)
 */
export class LibraryService {
  private readonly libraryRepository: LibraryFolderRepository;
  private readonly mediaFileRepository: MediaFileRepository;
  private readonly mediaScanner: MediaScanner;

  constructor(mediaScanner: MediaScanner) {
    this.libraryRepository = new LibraryFolderRepository();
    this.mediaFileRepository = new MediaFileRepository();
    this.mediaScanner = mediaScanner;
  }

  // ===== Library Management =====

  /**
   * Create a new library folder
   */
  public async createLibrary(data: CreateLibraryFolderData): Promise<LibraryFolder> {
    logger.info({ name: data.name, path: data.path, category: data.category, enabled: data.enabled, recursive: data.recursive }, 'LibraryService.createLibrary: Starting');
    
    // Validate path
    if (!data.path || data.path.trim().length === 0) {
      logger.warn('LibraryService.createLibrary: Path is empty');
      throw new ValidationError('Library path is required');
    }

    logger.debug({ path: data.path, allowedPaths: config.security?.allowedLibraryPaths }, 'LibraryService.createLibrary: Validating path security');
    
    // Security: Validate path for traversal and allowed directories
    try {
      validateLibraryPath(data.path, config.security?.allowedLibraryPaths);
      logger.debug('LibraryService.createLibrary: Path security validation passed');
    } catch (error) {
      logger.warn({ path: data.path, error }, 'LibraryService.createLibrary: Path security validation failed');
      throw error;
    }

    // Validate path exists
    logger.debug({ path: data.path }, 'LibraryService.createLibrary: Checking if path exists');
    try {
      const stat = await fs.stat(data.path);
      if (!stat.isDirectory()) {
        logger.warn({ path: data.path }, 'LibraryService.createLibrary: Path is not a directory');
        throw new ValidationError('Path must be a directory');
      }
      logger.debug('LibraryService.createLibrary: Path exists and is a directory');
    } catch (error) {
      logger.warn({ path: data.path, error }, 'LibraryService.createLibrary: Path does not exist or is not accessible');
      // Don't expose full path in error message
      throw new ValidationError('Path does not exist or is not accessible');
    }

    // Check if path already exists
    logger.debug({ path: data.path }, 'LibraryService.createLibrary: Checking for existing library with same path');
    const existing = await this.libraryRepository.findByPath(data.path);
    if (existing) {
      logger.warn({ path: data.path, existingId: existing.getId() }, 'LibraryService.createLibrary: Library with path already exists');
      throw new ConflictError(`Library with path '${data.path}' already exists`);
    }

    logger.info({ name: data.name, path: data.path, category: data.category }, 'LibraryService.createLibrary: Creating library in database');

    const libraryId = await this.libraryRepository.create(data);
    logger.debug({ libraryId }, 'LibraryService.createLibrary: Library created in database, fetching full record');
    
    const library = await this.libraryRepository.findById(libraryId);

    if (!library) {
      logger.error({ libraryId }, 'LibraryService.createLibrary: Failed to retrieve created library');
      throw new Error('Failed to create library');
    }

    logger.info({ libraryId, name: data.name }, 'LibraryService.createLibrary: Library folder created successfully');

    return library;
  }

  /**
   * Get library by ID
   */
  public async getLibrary(libraryId: string): Promise<LibraryFolder> {
    const library = await this.libraryRepository.findById(libraryId);
    if (!library) {
      throw new NotFoundError(`Library '${libraryId}' not found`);
    }
    return library;
  }

  /**
   * Get all libraries
   */
  public async getAllLibraries(filters?: {
    enabled?: boolean;
    category?: LibraryCategory;
  }): Promise<LibraryFolder[]> {
    return this.libraryRepository.findAll(filters);
  }

  /**
   * Update library
   */
  public async updateLibrary(libraryId: string, data: UpdateLibraryFolderData): Promise<LibraryFolder> {
    const library = await this.getLibrary(libraryId);

    // If updating path, validate it
    if (data.path && data.path !== library.getPath()) {
      // Security: Validate path for traversal and allowed directories
      validateLibraryPath(data.path, config.security?.allowedLibraryPaths);

      try {
        const stat = await fs.stat(data.path);
        if (!stat.isDirectory()) {
          throw new ValidationError('Path must be a directory');
        }
      } catch (error) {
        // Don't expose full path in error message
        throw new ValidationError('Path does not exist or is not accessible');
      }

      // Check for conflicts
      const existing = await this.libraryRepository.findByPath(data.path);
      if (existing && existing.getId() !== libraryId) {
        throw new ConflictError(`Library with path '${data.path}' already exists`);
      }
    }

    logger.info({ libraryId, updates: data }, 'Updating library folder');

    await this.libraryRepository.update(libraryId, data);

    const updated = await this.libraryRepository.findById(libraryId);
    if (!updated) {
      throw new Error('Failed to update library');
    }

    logger.info({ libraryId }, 'Library folder updated successfully');

    return updated;
  }

  /**
   * Delete library
   */
  public async deleteLibrary(libraryId: string, deleteMedia: boolean = false): Promise<void> {
    await this.getLibrary(libraryId); // Verify exists

    logger.info({ libraryId, deleteMedia }, 'Deleting library folder');

    if (deleteMedia) {
      // Delete all media files associated with this library
      await this.mediaFileRepository.deleteByLibrary(libraryId);
      logger.info({ libraryId }, 'Deleted media files associated with library');
    }

    await this.libraryRepository.delete(libraryId);

    logger.info({ libraryId }, 'Library folder deleted successfully');
  }

  // ===== Scanning =====

  /**
   * Scan a specific library folder
   */
  public async scanLibrary(libraryId: string): Promise<{
    filesScanned: number;
    filesAdded: number;
    durationMs: number;
  }> {
    const library = await this.getLibrary(libraryId);

    if (!library.isEnabled()) {
      throw new ValidationError('Library is disabled');
    }

    logger.info(
      { libraryId, path: library.getPath(), category: library.getCategory() },
      'Starting library scan'
    );

    const startTime = Date.now();

    // Scan directory
    const scannedFiles = await this.mediaScanner.scan([library.getPath()], {
      recursive: library.isRecursive(),
    });

    const durationMs = Date.now() - startTime;

    // Upsert all scanned files to database first, then update library reference
    let filesAdded = 0;
    let filesSkipped = 0;
    
    for (const file of scannedFiles) {
      try {
        // First, upsert the media file to ensure it exists in database
        // This returns the actual ID (may differ if file already existed)
        const actualFileId = await this.mediaFileRepository.upsert(file);
        
        // Then update library reference and category using the actual ID
        await this.mediaFileRepository.updateLibraryReference(
          actualFileId,
          libraryId,
          library.getCategory() as string
        );
        
        filesAdded++;
      } catch (error) {
        logger.warn(
          { error, filePath: file.path, fileId: file.id, libraryId },
          'Failed to add file to library'
        );
        filesSkipped++;
      }
    }
    
    if (filesSkipped > 0) {
      logger.warn(
        { libraryId, filesSkipped, filesAdded },
        'Some files were skipped during library scan'
      );
    }

    // Record scan result
    await this.libraryRepository.recordScan(libraryId, {
      durationMs,
      fileCount: filesAdded,
    });

    logger.info(
      { libraryId, filesScanned: scannedFiles.length, filesAdded, durationMs },
      'Library scan complete'
    );

    return {
      filesScanned: scannedFiles.length,
      filesAdded,
      durationMs,
    };
  }

  /**
   * Scan all enabled libraries
   */
  public async scanAllLibraries(): Promise<{
    librariesScanned: number;
    totalFilesScanned: number;
    totalFilesAdded: number;
    totalDurationMs: number;
  }> {
    const libraries = await this.libraryRepository.findAll({ enabled: true });

    logger.info({ count: libraries.length }, 'Starting scan of all enabled libraries');

    let totalFilesScanned = 0;
    let totalFilesAdded = 0;
    let totalDurationMs = 0;

    for (const library of libraries) {
      try {
        const result = await this.scanLibrary(library.getId());
        totalFilesScanned += result.filesScanned;
        totalFilesAdded += result.filesAdded;
        totalDurationMs += result.durationMs;
      } catch (error) {
        logger.error(
          { error, libraryId: library.getId(), libraryName: library.getName() },
          'Failed to scan library'
        );
      }
    }

    logger.info(
      { librariesScanned: libraries.length, totalFilesScanned, totalFilesAdded, totalDurationMs },
      'All libraries scanned'
    );

    return {
      librariesScanned: libraries.length,
      totalFilesScanned,
      totalFilesAdded,
      totalDurationMs,
    };
  }

  // ===== Media Management =====

  /**
   * Get all media files in a library
   */
  public async getMediaInLibrary(
    libraryId: string,
    filters?: {
      limit?: number;
      offset?: number;
    }
  ): Promise<MediaFile[]> {
    await this.getLibrary(libraryId); // Verify exists

    return this.mediaFileRepository.findByLibrary(libraryId, filters);
  }

  /**
   * Search media files across all libraries
   */
  public async searchMedia(filters?: {
    category?: LibraryCategory;
    libraryId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<MediaFile[]> {
    return this.mediaFileRepository.search(filters);
  }

  // ===== Series Management =====

  /**
   * Get all unique series names
   */
  public async getAllSeries(): Promise<string[]> {
    return this.mediaFileRepository.getAllSeries();
  }

  /**
   * Get all media files for a series
   */
  public async getMediaBySeries(showName: string): Promise<MediaFile[]> {
    return this.mediaFileRepository.getMediaBySeries(showName);
  }

  /**
   * Get episodes for a specific season
   */
  public async getEpisodesForSeason(showName: string, season: number): Promise<MediaFile[]> {
    return this.mediaFileRepository.getEpisodesForSeason(showName, season);
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
    return this.mediaFileRepository.getSeriesStats(showName);
  }

  // ===== Statistics =====

  /**
   * Get library statistics
   */
  public async getLibraryStats(libraryId: string): Promise<{
    totalFiles: number;
    totalSize: number;
    lastScanAt: Date | null;
    lastScanFileCount: number;
  }> {
    await this.getLibrary(libraryId); // Verify exists

    return this.libraryRepository.getStats(libraryId);
  }
}
