import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';

const logger = createLogger('PlaylistService');

/**
 * Simplified PlaylistService for the new playback pipeline
 * 
 * New Pipeline (Beta Approach - Sequential Streaming):
 * ========================================================
 * File1 ends → Bumper streams (separate FFmpeg) → File2 starts
 * 
 * Key Changes:
 * - Each media file is a separate FFmpeg process
 * - Bumpers stream independently between files (no playlist merging)
 * - PlaylistService just serves FFmpeg's playlist directly
 * - FFmpeg is the source of truth for segments and MEDIA-SEQUENCE
 * - Inject EXT-X-DISCONTINUITY tags on-read for Roku compatibility
 * 
 * What We Do:
 * - Read FFmpeg's playlist and return it as-is (with discontinuity tags injected)
 * - Handle missing/empty playlist gracefully (return minimal valid playlist)
 * - Inject discontinuity tags at file transition points (modify on-read, not file)
 * - Track transition points in-memory (no file operations)
 * 
 * What We DON'T Do Anymore:
 * - ❌ Merge bumper segments into playlists
 * - ❌ Scan disk for all segments
 * - ❌ Manage MEDIA-SEQUENCE manually
 * - ❌ Write to playlist files (modify on-read only)
 */
export class PlaylistService {
  // Track pending transition points per channel
  // Key: channelId, Value: Set of segment numbers needing discontinuity tags
  private pendingTransitions: Map<string, Set<number>> = new Map();

  /**
   * Get playlist content for a channel
   * 
   * Reads FFmpeg's playlist file and injects discontinuity tags at transition points.
   * Tags are injected in-memory (file is never modified) to avoid race conditions.
   * 
   * @param playlistPath - Path to FFmpeg's playlist file (stream.m3u8)
   * @param channelId - Channel ID for transition tracking (optional, extracted from path if not provided)
   * @returns Playlist content with discontinuity tags injected, or minimal valid fallback
   */
  async getPlaylist(playlistPath: string, channelId?: string): Promise<string> {
    try {
      // Try to read FFmpeg's playlist
      const content = await fs.readFile(playlistPath, 'utf-8');
      
      // Validate it's a valid M3U8 file
      if (!content.includes('#EXTM3U')) {
        logger.warn(
          { playlistPath, contentPreview: content.substring(0, 200) },
          'Invalid M3U8 file - missing #EXTM3U header, returning minimal playlist'
        );
        return this.buildMinimalPlaylist();
      }
      
      // Extract channelId from path if not provided
      const actualChannelId = channelId || this.extractChannelIdFromPath(playlistPath);
      
      // Check for pending transition points and inject discontinuity tags
      // Only inject if we have a valid channelId
      let modifiedContent = content;
      if (actualChannelId) {
        const pendingTransitions = this.pendingTransitions.get(actualChannelId);
        
        if (pendingTransitions && pendingTransitions.size > 0) {
          modifiedContent = this.injectDiscontinuityTags(content, pendingTransitions, actualChannelId);
        }
      }
      
      logger.debug(
        {
          playlistPath,
          contentLength: content.length,
          segmentCount: (content.match(/\.ts/g) || []).length,
          transitionsInjected: actualChannelId ? (this.pendingTransitions.get(actualChannelId)?.size || 0) : 0,
          channelId: actualChannelId || 'unknown'
        },
        'Served FFmpeg playlist'
      );
      
      return modifiedContent;
      
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      
      // Playlist doesn't exist yet (normal during initialization)
      if (fsError.code === 'ENOENT') {
        logger.debug(
          { playlistPath },
          'Playlist file not found (FFmpeg still initializing), returning minimal playlist'
        );
        return this.buildMinimalPlaylist();
      }
      
      // Other errors
      logger.error(
        { error, playlistPath, errorCode: fsError.code },
        'Error reading playlist file, returning minimal playlist'
      );
      
      return this.buildMinimalPlaylist();
    }
  }

  /**
   * Build minimal valid EVENT playlist for error/initialization cases
   * 
   * This prevents player errors when FFmpeg hasn't created the playlist yet.
   * Players will retry and eventually get the real playlist once FFmpeg starts.
   */
  private buildMinimalPlaylist(): string {
    return `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-ALLOW-CACHE:NO
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-PLAYLIST-TYPE:EVENT
`;
  }

  /**
   * Record transition point for discontinuity tag injection
   * 
   * Called when a file transition is confirmed (after first new segment is written).
   * The segment number represents where the discontinuity tag should be inserted.
   * 
   * @param channelId - Channel ID
   * @param segmentNumber - Segment number where discontinuity should be inserted
   */
  recordTransitionPoint(channelId: string, segmentNumber: number): void {
    if (!this.pendingTransitions.has(channelId)) {
      this.pendingTransitions.set(channelId, new Set());
    }
    this.pendingTransitions.get(channelId)!.add(segmentNumber);
    logger.debug(
      { channelId, segmentNumber, totalTransitions: this.pendingTransitions.get(channelId)!.size },
      'Recorded transition point for discontinuity tag'
    );
  }

  /**
   * Clear a processed transition point
   * 
   * Called after a discontinuity tag has been injected and served to clients.
   * 
   * @param channelId - Channel ID
   * @param segmentNumber - Segment number that was processed
   */
  clearTransitionPoint(channelId: string, segmentNumber: number): void {
    const transitions = this.pendingTransitions.get(channelId);
    if (transitions) {
      transitions.delete(segmentNumber);
      if (transitions.size === 0) {
        this.pendingTransitions.delete(channelId);
      }
      logger.debug(
        { channelId, segmentNumber, remainingTransitions: transitions.size },
        'Cleared processed transition point'
      );
    }
  }

  /**
   * Extract channel ID from playlist path
   * 
   * Attempts to extract channelId from the playlist path structure.
   * Falls back to using the directory name as channelId.
   * 
   * @param playlistPath - Full path to playlist file
   * @returns Extracted channel ID or undefined
   */
  private extractChannelIdFromPath(playlistPath: string): string | undefined {
    try {
      // Playlist path structure: .../hls_output/{channelId}/stream.m3u8
      // or: .../{channelId}/stream.m3u8
      const dir = path.dirname(playlistPath);
      const channelId = path.basename(dir);
      return channelId || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Inject EXT-X-DISCONTINUITY tags before segments at transition points
   * 
   * Modifies playlist content in-memory (does not write to file).
   * Inserts discontinuity tags immediately before segments that match
   * recorded transition points. Only clears transition points after the segment
   * has actually appeared in the playlist to handle timing issues.
   * 
   * @param content - Original playlist content
   * @param transitions - Set of segment numbers needing discontinuity tags
   * @param channelId - Channel ID for logging
   * @returns Modified playlist content with discontinuity tags
   */
  private injectDiscontinuityTags(
    content: string,
    transitions: Set<number>,
    channelId: string
  ): string {
    const lines = content.split('\n');
    const newLines: string[] = [];
    const processedTransitions = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line contains a segment that needs a discontinuity tag
      const segmentMatch = line.match(/stream_(\d+)\.ts/);
      if (segmentMatch) {
        const segmentNumber = parseInt(segmentMatch[1], 10);

        if (transitions.has(segmentNumber)) {
          // Insert discontinuity tag before this segment
          // Check previous line isn't already a discontinuity tag
          const prevLine = newLines[newLines.length - 1];
          if (prevLine !== '#EXT-X-DISCONTINUITY') {
            newLines.push('#EXT-X-DISCONTINUITY');
            logger.debug(
              { channelId, segmentNumber },
              'Injected EXT-X-DISCONTINUITY tag before segment'
            );
          } else {
            logger.debug(
              { channelId, segmentNumber },
              'Skipped duplicate discontinuity tag (already present)'
            );
          }
          // Only mark as processed if the segment actually appears in the playlist
          // This ensures we don't clear the transition point before it's used
          processedTransitions.add(segmentNumber);
        }
      }

      newLines.push(line);
    }

    // Clean up processed transitions only after they've been injected
    // This prevents clearing transition points before segments appear in the playlist
    processedTransitions.forEach(segNum => {
      this.clearTransitionPoint(channelId, segNum);
      logger.debug(
        { channelId, segmentNumber: segNum },
        'Cleared transition point after successful injection'
      );
    });

    return newLines.join('\n');
  }
}

