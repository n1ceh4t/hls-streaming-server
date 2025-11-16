import { createLogger } from '../../utils/logger';

const logger = createLogger('PlaylistManipulator');

/**
 * PlaylistManipulator - HLS Playlist Enhancement Service
 * 
 * Handles manipulation of HLS playlists to ensure RFC 8216 compliance,
 * particularly for discontinuity tag management during file transitions.
 * 
 * RFC 8216 Section 6.3.3: "The EXT-X-DISCONTINUITY tag MUST be present if
 * any of the following characteristics change: file format, number and type
 * of tracks, encoding parameters, encoding sequence, or timestamp sequence."
 * 
 * In our case, every file transition changes encoding parameters (different
 * source files), so discontinuity tags are required at each transition.
 */
export class PlaylistManipulator {
  /**
   * Insert EXT-X-DISCONTINUITY tag before a specific segment
   * 
   * RFC 8216 compliant placement: immediately before the first segment
   * of the new media file.
   * 
   * @param playlistContent - Current playlist content
   * @param segmentNumber - Segment number where discontinuity should be inserted
   * @returns Modified playlist with discontinuity tag
   */
  public insertDiscontinuityBeforeSegment(
    playlistContent: string,
    segmentNumber: number
  ): string {
    const lines = playlistContent.split('\n');
    const newLines: string[] = [];
    let inserted = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this is the target segment
      const segmentMatch = line.match(/stream_(\d+).m4s/);
      if (segmentMatch && parseInt(segmentMatch[1], 10) === segmentNumber && !inserted) {
        // Find the EXTINF line immediately before this segment
        let extinfIndex = i - 1;
        while (extinfIndex >= 0 && lines[extinfIndex].trim() === '') {
          extinfIndex--; // Skip empty lines
        }

        if (extinfIndex >= 0 && lines[extinfIndex].startsWith('#EXTINF')) {
          // Insert discontinuity tag before the EXTINF
          const contentBeforeExtinf = newLines.slice(0, newLines.length - (i - extinfIndex - 1));
          contentBeforeExtinf.push('#EXT-X-DISCONTINUITY');
          const contentAfterExtinf = newLines.slice(newLines.length - (i - extinfIndex - 1));
          newLines.length = 0;
          newLines.push(...contentBeforeExtinf, ...contentAfterExtinf);
          inserted = true;

          logger.debug(
            { segmentNumber, lineNumber: extinfIndex },
            'Inserted EXT-X-DISCONTINUITY tag before segment'
          );
        } else {
          // If EXTINF not found, insert before segment line
          newLines.push('#EXT-X-DISCONTINUITY');
          inserted = true;

          logger.debug(
            { segmentNumber, lineNumber: i },
            'Inserted EXT-X-DISCONTINUITY tag (EXTINF not found)'
          );
        }
      }

      newLines.push(line);
    }

    if (!inserted) {
      logger.warn(
        { segmentNumber, lineCount: lines.length },
        'Failed to insert discontinuity tag - segment not found in playlist'
      );
    }

    return newLines.join('\n');
  }

  /**
   * Add EXT-X-DISCONTINUITY-SEQUENCE tag to playlist header
   * 
   * RFC 8216 Section 6.3.4: "The EXT-X-DISCONTINUITY-SEQUENCE tag allows
   * synchronization between different Renditions of the same Variant Stream."
   * 
   * This tag helps clients understand the stream structure and is essential
   * for DVR features and multi-bitrate streaming.
   * 
   * @param playlistContent - Current playlist content
   * @param sequenceNumber - Current discontinuity sequence number
   * @returns Modified playlist with discontinuity sequence tag
   */
  public addDiscontinuitySequence(
    playlistContent: string,
    sequenceNumber: number
  ): string {
    const lines = playlistContent.split('\n');
    let inserted = false;

    // Insert after #EXT-X-MEDIA-SEQUENCE (RFC 8216 recommended position)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        // Check if discontinuity sequence already exists
        if (i + 1 < lines.length && lines[i + 1].startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
          // Update existing tag
          lines[i + 1] = `#EXT-X-DISCONTINUITY-SEQUENCE:${sequenceNumber}`;
          inserted = true;
          logger.debug({ sequenceNumber }, 'Updated existing EXT-X-DISCONTINUITY-SEQUENCE tag');
        } else {
          // Insert new tag
          lines.splice(i + 1, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${sequenceNumber}`);
          inserted = true;
          logger.debug({ sequenceNumber }, 'Added new EXT-X-DISCONTINUITY-SEQUENCE tag');
        }
        break;
      }
    }

    if (!inserted) {
      logger.warn(
        { sequenceNumber },
        'Failed to add discontinuity sequence - #EXT-X-MEDIA-SEQUENCE not found'
      );
    }

    return lines.join('\n');
  }

  /**
   * Count existing discontinuity tags in playlist
   * Useful for tracking discontinuity sequence number
   * 
   * @param playlistContent - Playlist content to analyze
   * @returns Number of discontinuity tags found
   */
  public countDiscontinuities(playlistContent: string): number {
    const matches = playlistContent.match(/#EXT-X-DISCONTINUITY\n/g);
    return matches ? matches.length : 0;
  }

  /**
   * Get current discontinuity sequence from playlist
   * Returns 0 if tag not present
   * 
   * @param playlistContent - Playlist content to analyze
   * @returns Current discontinuity sequence number
   */
  public getDiscontinuitySequence(playlistContent: string): number {
    const match = playlistContent.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Validate playlist has discontinuity tags at appropriate locations
   * Returns validation result with details
   * 
   * @param playlistContent - Playlist content to validate
   * @returns Validation result
   */
  public validateDiscontinuityTags(playlistContent: string): {
    valid: boolean;
    issues: string[];
    suggestions: string[];
  } {
    const issues: string[] = [];
    const suggestions: string[] = [];

    const lines = playlistContent.split('\n');
    let hasDiscontinuities = false;
    let hasDiscontinuitySequence = false;

    for (const line of lines) {
      if (line === '#EXT-X-DISCONTINUITY') {
        hasDiscontinuities = true;
      }
      if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
        hasDiscontinuitySequence = true;
      }
    }

    // Check for discontinuity sequence tag if discontinuities exist
    if (hasDiscontinuities && !hasDiscontinuitySequence) {
      issues.push('Playlist has discontinuities but missing EXT-X-DISCONTINUITY-SEQUENCE tag');
      suggestions.push('Add EXT-X-DISCONTINUITY-SEQUENCE tag for better client compatibility');
    }

    return {
      valid: issues.length === 0,
      issues,
      suggestions,
    };
  }

  /**
   * Remove all discontinuity tags from playlist
   * Useful for cleanup or reset operations
   * 
   * @param playlistContent - Playlist content
   * @returns Playlist without discontinuity tags
   */
  public removeAllDiscontinuities(playlistContent: string): string {
    return playlistContent
      .replace(/#EXT-X-DISCONTINUITY\n/g, '')
      .replace(/#EXT-X-DISCONTINUITY-SEQUENCE:\d+\n/g, '');
  }

  /**
   * Get segment numbers from playlist
   * Useful for tracking which segments are currently in playlist
   * 
   * @param playlistContent - Playlist content to analyze
   * @returns Array of segment numbers
   */
  public getSegmentNumbers(playlistContent: string): number[] {
    const segments: number[] = [];
    const matches = playlistContent.matchAll(/stream_(\d+).m4s/g);

    for (const match of matches) {
      segments.push(parseInt(match[1], 10));
    }

    return segments.sort((a, b) => a - b);
  }
}

