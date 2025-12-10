import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ConcatFileManager');

/**
 * Manages FFmpeg concat files for seamless file transitions
 *
 * Concat file format (unquoted paths with -safe 0):
 * file /path/to/file1.mp4
 * file /path/to/bumper.mp4
 * file /path/to/file2.mp4
 * file /path/to/bumper.mp4
 * file /path/to/file3.mp4
 *
 * Note: Using unquoted paths avoids single quote escaping bugs in FFmpeg concat demuxer.
 * Paths are escaped for backslashes and single quotes using backslash escape sequences.
 */
export class ConcatFileManager {
  /**
   * Escape file paths for FFmpeg concat demuxer
   *
   * When using -safe 0 flag, FFmpeg concat demuxer can read unquoted paths.
   * This avoids issues with single quote escaping (which has known bugs in FFmpeg).
   *
   * For unquoted paths, we need to escape special characters:
   * - Backslashes: \ becomes \\
   * - Spaces: (space) becomes \(space)
   * - Single quotes: ' becomes \'
   * - Other special chars that might appear in filenames
   *
   * @param filePath - File path to escape
   * @returns Escaped file path
   */
  private escapePathForConcat(filePath: string): string {
    // For unquoted paths (with -safe 0), escape special characters
    return filePath
      .replace(/\\/g, '\\\\')    // Escape backslashes first (must be first!)
      .replace(/ /g, '\\ ')      // Escape spaces
      .replace(/'/g, "\\'")      // Escape single quotes
      .replace(/"/g, '\\"')      // Escape double quotes
      .replace(/\(/g, '\\(')     // Escape parentheses (common in filenames)
      .replace(/\)/g, '\\)')
      .replace(/\[/g, '\\[')     // Escape brackets
      .replace(/\]/g, '\\]')
      .replace(/!/g, '\\!');     // Escape exclamation marks
  }
  /**
   * Create or update a concat file for a channel
   *
   * The concat file structure stays the same - it always references the same bumper file path.
   * The bumper file itself gets regenerated/overwritten when each episode starts.
   *
   * @param channelId - Channel ID
   * @param outputDir - Output directory for the concat file
   * @param mediaFiles - Array of media file paths
   * @param bumperPath - Path to the single bumper file (same path, content gets overwritten)
   * @param startIndex - Optional: start from this file index (for seeking)
   * @param seekToSeconds - Optional: seek to this position within the first file (only used if startIndex is provided)
   * @param scheduleBlockId - Optional: ID of schedule block this concat file is for (used to detect schedule transitions)
   * @returns Path to the created concat file and the calculated startPosition for FFmpeg -ss
   */
  async createConcatFile(
    channelId: string,
    outputDir: string,
    mediaFiles: string[],
    bumperPath: string,
    startIndex: number = 0,
    seekToSeconds: number = 0,
    scheduleBlockId?: string
  ): Promise<{ concatFilePath: string; startPosition: number }> {
    const concatFilePath = path.join(outputDir, 'concat.txt');

    // Ensure output directory exists before writing concat file
    // This is a safety measure - ChannelService should create it, but we verify here
    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch (error) {
      logger.error(
        { channelId, outputDir, error },
        'Failed to create output directory for concat file'
      );
      throw error;
    }

    // Validate startIndex
    const validStartIndex = Math.max(0, Math.min(startIndex, mediaFiles.length - 1));
    const validSeekToSeconds = Math.max(0, seekToSeconds);
    
    // Build concat file content starting from startIndex
    // Format: file 'path' (one per line, with bumper between each show)
    // The bumper path stays the same - we just overwrite the file content when episodes start
    const lines: string[] = [];
    
    // If we need to seek within the first file, we'll use FFmpeg's -ss option
    // The concat file will include all files from startIndex onwards
    for (let i = validStartIndex; i < mediaFiles.length; i++) {
      // Add the media file
      // If this is the first file and we need to seek, we'll use inpoint in the concat file
      // OR we can use -ss on the input (simpler)
      if (i === validStartIndex && validSeekToSeconds > 0) {
        // Use inpoint to start from a specific time within the file
        // CRITICAL: inpoint must be on a SEPARATE LINE after 'file' directive
        // Format per FFmpeg docs:
        //   file 'path'
        //   inpoint timestamp
        //
        // WARNING: inpoint in concat demuxer has known limitations:
        // - Works best with intra-frame codecs (each frame independent)
        // - For non-intra frame codecs (H.264, H.265/HEVC), seeks to nearest keyframe
        // - May include extra packets/frames before the inpoint
        // - Decoded content may contain frames before the specified inpoint
        // - For frame-accurate seeking, pre-process file to create trimmed segment (requires re-encoding)
        const escapedPath = this.escapePathForConcat(mediaFiles[i]);
        // Use floating point for better precision (FFmpeg accepts both int and float)
        const inpointValue = validSeekToSeconds.toFixed(3);
        logger.warn(
          {
            channelId,
            filePath: mediaFiles[i],
            requestedSeek: validSeekToSeconds,
            inpointValue,
            note: 'Using inpoint in concat file - for non-intra frame codecs (H.264/H.265), seeking will be to nearest keyframe, not exact position'
          },
          'Creating concat file with inpoint (format: file on one line, inpoint on separate line)'
        );
        // CRITICAL: inpoint must be on separate line per FFmpeg documentation
        // Using unquoted paths (with -safe 0) to avoid single quote escaping bugs
        lines.push(`file ${escapedPath}`);
        lines.push(`inpoint ${inpointValue}`);
      } else {
        const escapedPath = this.escapePathForConcat(mediaFiles[i]);
        // Using unquoted paths (with -safe 0) to avoid single quote escaping bugs
        lines.push(`file ${escapedPath}`);
      }

      // Add bumper after each file (except the last one)
      // The bumper file will be regenerated with fresh content when each episode starts
      // Only include bumper if it exists and is valid (to prevent FFmpeg from crashing if generation fails)
      if (i < mediaFiles.length - 1) {
        try {
          // Verify file exists
          await fs.access(bumperPath);
          
          // Verify file is not empty and has reasonable size (at least 1KB)
          const stats = await fs.stat(bumperPath);
          const minSize = 1024; // 1KB minimum
          if (stats.size < minSize) {
            logger.warn(
              { channelId, bumperPath, fileIndex: i, size: stats.size },
              'Bumper file exists but is too small (possible corruption), skipping in concat file'
            );
          } else {
            // Check if temp file exists (indicates ongoing write)
            // Temp files have pattern: bumper.mp4.tmp.{timestamp}
            try {
              const dir = path.dirname(bumperPath);
              const bumperBasename = path.basename(bumperPath);
              const files = await fs.readdir(dir);
              const hasTempFile = files.some(f => f.startsWith(bumperBasename + '.tmp.'));
              if (hasTempFile) {
                logger.warn(
                  { channelId, bumperPath, fileIndex: i },
                  'Bumper file is being written (temp file exists), skipping in concat file to avoid corruption'
                );
              } else {
                const escapedBumperPath = this.escapePathForConcat(bumperPath);
                // Using unquoted paths (with -safe 0) to avoid single quote escaping bugs
                lines.push(`file ${escapedBumperPath}`);
              }
            } catch {
              // Can't check for temp files, but main file exists and is valid - include it
              const escapedBumperPath = this.escapePathForConcat(bumperPath);
              lines.push(`file ${escapedBumperPath}`);
            }
          }
        } catch {
          // Bumper doesn't exist yet - skip it (will be added when generated)
          logger.warn(
            { channelId, bumperPath, fileIndex: i },
            'Bumper file does not exist, skipping in concat file (will be added when generated)'
          );
        }
      }
    }
    
    const content = lines.join('\n') + '\n';

    // CRITICAL: Delete existing concat file first to ensure clean write
    // This prevents FFmpeg from reading a partially-written or stale file
    try {
      await fs.unlink(concatFilePath);
      logger.debug({ channelId, concatFilePath }, 'Deleted existing concat file before recreation');
    } catch (error) {
      // File might not exist yet - that's OK
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ channelId, concatFilePath, error }, 'Failed to delete existing concat file (non-fatal)');
      }
    }

    // Write concat file
    await fs.writeFile(concatFilePath, content, 'utf-8');

    // Write metadata file to track schedule block ID and creation time
    // This allows detection of schedule block transitions for dynamic playlists
    const metadataPath = path.join(outputDir, 'concat.metadata.json');
    const metadata = {
      scheduleBlockId: scheduleBlockId || null,
      createdAt: new Date().toISOString(),
      mediaCount: mediaFiles.length,
      startIndex: validStartIndex,
      seekToSeconds: validSeekToSeconds
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // Calculate total start position for FFmpeg -ss (if we're starting mid-concat)
    // Actually, with inpoint in the concat file, we don't need -ss on the input
    // But we'll return 0 since inpoint handles it
    const startPosition = 0; // inpoint in concat file handles seeking

    logger.info(
      {
        channelId,
        concatFilePath,
        mediaCount: mediaFiles.length,
        startIndex: validStartIndex,
        seekToSeconds: validSeekToSeconds,
        bumperPath,
        scheduleBlockId: scheduleBlockId || 'none',
        note: 'Concat file created with seeking support - bumper will be regenerated dynamically when episodes start'
      },
      'Created/updated concat file with seeking'
    );

    return { concatFilePath, startPosition };
  }

  /**
   * Update concat file when media list changes (e.g., schedule block transitions)
   *
   * @param channelId - Channel ID
   * @param outputDir - Output directory for the concat file
   * @param mediaFiles - Updated array of media file paths
   * @param bumperPath - Path to the single bumper file (same path, content gets overwritten)
   * @param scheduleBlockId - Optional: ID of schedule block for the new media list
   * @returns Path to the updated concat file
   */
  async updateConcatFile(
    channelId: string,
    outputDir: string,
    mediaFiles: string[],
    bumperPath: string,
    scheduleBlockId?: string
  ): Promise<string> {
    logger.info(
      { channelId, mediaCount: mediaFiles.length, scheduleBlockId: scheduleBlockId || 'none' },
      'Updating concat file for new media list (bumper path unchanged)'
    );
    const result = await this.createConcatFile(channelId, outputDir, mediaFiles, bumperPath, 0, 0, scheduleBlockId);
    return result.concatFilePath;
  }

  /**
   * Get the bumper file path for a channel
   * 
   * @param outputDir - Output directory
   * @returns Path to the bumper file
   */
  getBumperPath(outputDir: string): string {
    return path.join(outputDir, 'bumper.mp4');
  }

  /**
   * Check if concat file exists
   * 
   * @param outputDir - Output directory
   * @returns True if concat file exists
   */
  async concatFileExists(outputDir: string): Promise<boolean> {
    const concatFilePath = path.join(outputDir, 'concat.txt');
    try {
      await fs.access(concatFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read concat file metadata (schedule block ID, creation time, etc.)
   *
   * @param outputDir - Output directory
   * @returns Metadata object or null if not found
   */
  async getConcatMetadata(outputDir: string): Promise<{
    scheduleBlockId: string | null;
    createdAt: string;
    mediaCount: number;
    startIndex: number;
    seekToSeconds: number;
  } | null> {
    const metadataPath = path.join(outputDir, 'concat.metadata.json');
    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get the schedule block ID associated with the current concat file
   *
   * @param outputDir - Output directory
   * @returns Schedule block ID or null if not found/not set
   */
  async getCurrentScheduleBlockId(outputDir: string): Promise<string | null> {
    const metadata = await this.getConcatMetadata(outputDir);
    return metadata?.scheduleBlockId || null;
  }
}

