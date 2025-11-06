import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';
import { MediaFile, MediaFileInfo } from '../../domain/media/MediaFile';
import { MetadataExtractor } from '../../infrastructure/ffmpeg/MetadataExtractor';
import { ShowParser } from './ShowParser';

const logger = createLogger('MediaScanner');

export interface ScanOptions {
  recursive?: boolean;
  extensions?: string[];
  excludePatterns?: RegExp[];
}

export class MediaScanner {
  private readonly metadataExtractor: MetadataExtractor;
  private readonly showParser: ShowParser;
  private readonly defaultExtensions = [
    '.mp4',
    '.mkv',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.ts',
    '.mpg',
    '.mpeg',
  ];

  constructor(metadataExtractor: MetadataExtractor) {
    this.metadataExtractor = metadataExtractor;
    this.showParser = new ShowParser();
  }

  /**
   * Scan directories for media files
   */
  public async scan(directories: string[], options?: ScanOptions): Promise<MediaFile[]> {
    const startTime = Date.now();
    logger.info({ directories, options }, 'Starting media scan');

    const extensions = options?.extensions || this.defaultExtensions;
    const excludePatterns = options?.excludePatterns || [
      /\/\./,
      /@eaDir/,
      /\.tmp$/,
      /\.partial$/,
    ];

    const allFiles: MediaFile[] = [];

    for (const dir of directories) {
      try {
        const files = await this.scanDirectory(dir, extensions, excludePatterns, options?.recursive);
        allFiles.push(...files);
      } catch (error) {
        logger.error({ error, directory: dir }, 'Failed to scan directory');
      }
    }

    const duration = Date.now() - startTime;
    logger.info(
      { count: allFiles.length, duration },
      `Media scan completed: ${allFiles.length} files in ${duration}ms`
    );

    return allFiles;
  }

  /**
   * Scan a single directory
   */
  private async scanDirectory(
    directory: string,
    extensions: string[],
    excludePatterns: RegExp[],
    recursive = true
  ): Promise<MediaFile[]> {
    const mediaFiles: MediaFile[] = [];

    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) {
        logger.warn({ directory }, 'Path is not a directory');
        return mediaFiles;
      }

      const entries = await fs.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        // Check exclude patterns
        if (excludePatterns.some((pattern) => pattern.test(fullPath))) {
          continue;
        }

        if (entry.isDirectory() && recursive) {
          // Recursively scan subdirectory
          const subFiles = await this.scanDirectory(fullPath, extensions, excludePatterns, recursive);
          mediaFiles.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            try {
              const mediaFile = await this.processFile(fullPath);
              if (mediaFile) {
                mediaFiles.push(mediaFile);
              }
            } catch (error) {
              logger.warn({ error, file: fullPath }, 'Failed to process file');
            }
          }
        }
      }
    } catch (error) {
      logger.error({ error, directory }, 'Error scanning directory');
    }

    return mediaFiles;
  }

  /**
   * Process a single file and create MediaFile entity
   */
  private async processFile(filePath: string): Promise<MediaFile | null> {
    try {
      // Extract metadata using ffprobe
      const metadata = await this.metadataExtractor.extract(filePath);

      // Extract show info from path
      const info = this.extractShowInfo(filePath);

      return new MediaFile(filePath, metadata, info);
    } catch (error) {
      logger.debug({ error, file: filePath }, 'Could not process file');
      return null;
    }
  }

  /**
   * Extract show information from file path using enhanced ShowParser
   * Supports a wide variety of naming conventions:
   * - Standard: Breaking Bad - S01E01 - Pilot.mkv
   * - Dot notation: the.office.s02e03.1080p.web.h264.mkv
   * - NumxNum: Friends - 3x08.avi
   * - Date-based: The Daily Show - 2023-11-03.mp4
   * - Absolute episode: Seinfeld - 305.mp4
   * - Anime: [Group] Cowboy Bebop - 01 [1080p].mkv
   * - Directory structure: /Shows/Breaking Bad/Season 01/file.mkv
   */
  private extractShowInfo(filePath: string): MediaFileInfo {
    const parsed = this.showParser.parse(filePath);

    // Log low-confidence parses for monitoring
    if (parsed.confidence === 'low') {
      logger.debug(
        { filePath, parsed },
        'Low-confidence show info parse - may need manual correction'
      );
    }

    return {
      showName: parsed.showName,
      season: parsed.season,
      episode: parsed.episode,
      title: parsed.episodeTitle,
    };
  }

  /**
   * Watch directories for changes
   */
  public async watch(
    directories: string[],
    callback: (file: MediaFile) => void
  ): Promise<() => void> {
    const chokidar = await import('chokidar');

    const watcher = chokidar.watch(directories, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      depth: 99,
    });

    watcher
      .on('add', async (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (this.defaultExtensions.includes(ext)) {
          logger.info({ file: filePath }, 'New media file detected');
          const mediaFile = await this.processFile(filePath);
          if (mediaFile) {
            callback(mediaFile);
          }
        }
      })
      .on('error', (error) => {
        logger.error({ error }, 'Watcher error');
      });

    logger.info({ directories }, 'Started watching directories');

    // Return cleanup function
    return () => {
      watcher.close();
      logger.info('Stopped watching directories');
    };
  }
}
