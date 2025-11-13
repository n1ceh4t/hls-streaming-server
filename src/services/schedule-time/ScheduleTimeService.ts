import { MediaFile } from '../../domain/media/MediaFile';
import { createLogger } from '../../utils/logger';
import { Database } from '../../infrastructure/database/Database';

const logger = createLogger('ScheduleTimeService');

export interface SchedulePosition {
  fileIndex: number;
  seekPosition: number; // Seconds into the current file
  elapsedSeconds: number; // Total seconds since schedule start
}

/**
 * Simplified time tracking service for channel schedules
 * Replaces complex VirtualTimeService with a single timestamp anchor
 *
 * Key insight: We don't need to track state updates!
 * - Set schedule_start_time once when channel first starts
 * - Calculate current position on-demand using elapsed time
 * - Playlist loops automatically using modulo arithmetic
 */
export class ScheduleTimeService {
  /**
   * Initialize schedule start time for a channel
   * Called once when channel starts streaming for the first time
   */
  public async initializeScheduleTime(channelId: string): Promise<void> {
    const now = new Date();

    await Database.query(
      `UPDATE channels
       SET schedule_start_time = $1
       WHERE id = $2 AND schedule_start_time IS NULL`,
      [now, channelId]
    );

    logger.info({ channelId, scheduleStartTime: now }, 'Schedule start time initialized');
  }

  /**
   * Get schedule start time for a channel
   */
  public async getScheduleStartTime(channelId: string): Promise<Date | null> {
    const result = await Database.query<{ schedule_start_time: Date }>(
      'SELECT schedule_start_time FROM channels WHERE id = $1',
      [channelId]
    );

    return result.rows[0]?.schedule_start_time || null;
  }

  /**
   * Calculate current playback position based on elapsed time since schedule start
   * This is the ONLY method needed - no state updates required!
   *
   * @param channelId - Channel ID
   * @param mediaFiles - Playlist media files
   * @param currentTime - Optional current time (defaults to now, useful for testing)
   * @returns Current file index and seek position
   */
  public async getCurrentPosition(
    channelId: string,
    mediaFiles: MediaFile[],
    currentTime: Date = new Date()
  ): Promise<SchedulePosition | null> {
    if (mediaFiles.length === 0) {
      logger.warn({ channelId }, 'Cannot calculate position: empty media list');
      return null;
    }

    // Get schedule start time
    const scheduleStartTime = await this.getScheduleStartTime(channelId);
    if (!scheduleStartTime) {
      logger.debug({ channelId }, 'No schedule start time - channel not initialized');
      return null;
    }

    // Calculate elapsed seconds since schedule started
    const elapsedMs = currentTime.getTime() - scheduleStartTime.getTime();
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds < 0) {
      logger.warn(
        {
          channelId,
          scheduleStartTime: scheduleStartTime.toISOString(),
          currentTime: currentTime.toISOString()
        },
        'Current time is before schedule start time'
      );
      return { fileIndex: 0, seekPosition: 0, elapsedSeconds: 0 };
    }

    // Calculate total playlist duration
    const totalPlaylistDuration = mediaFiles.reduce(
      (sum, file) => sum + (file.metadata?.duration || 0),
      0
    );

    if (totalPlaylistDuration === 0) {
      logger.warn({ channelId }, 'Total playlist duration is 0');
      return { fileIndex: 0, seekPosition: 0, elapsedSeconds: 0 };
    }

    // Handle playlist looping: normalize elapsed time to within one playlist cycle
    const normalizedSeconds = elapsedSeconds % totalPlaylistDuration;

    // Walk through playlist to find current file and position
    let accumulated = 0;
    for (let i = 0; i < mediaFiles.length; i++) {
      const fileDuration = mediaFiles[i].metadata?.duration || 0;

      if (accumulated + fileDuration > normalizedSeconds) {
        // Found the file
        const seekPosition = normalizedSeconds - accumulated;

        logger.debug(
          {
            channelId,
            fileIndex: i,
            seekPosition,
            elapsedSeconds,
            normalizedSeconds,
            fileName: mediaFiles[i].filename,
            playlistLoops: Math.floor(elapsedSeconds / totalPlaylistDuration)
          },
          'Calculated current position from schedule time'
        );

        return {
          fileIndex: i,
          seekPosition: Math.max(0, seekPosition),
          elapsedSeconds
        };
      }

      accumulated += fileDuration;
    }

    // Shouldn't reach here due to modulo, but safety fallback
    logger.warn(
      {
        channelId,
        elapsedSeconds,
        normalizedSeconds,
        totalPlaylistDuration
      },
      'Position calculation exceeded playlist - resetting to start'
    );
    return { fileIndex: 0, seekPosition: 0, elapsedSeconds };
  }

  /**
   * Update schedule start time for a channel
   * Allows manual adjustment of the schedule timeline
   * 
   * @param channelId - Channel ID
   * @param scheduleStartTime - New schedule start time
   */
  public async updateScheduleStartTime(channelId: string, scheduleStartTime: Date): Promise<void> {
    await Database.query(
      `UPDATE channels
       SET schedule_start_time = $1
       WHERE id = $2`,
      [scheduleStartTime, channelId]
    );

    logger.info({ channelId, scheduleStartTime }, 'Schedule start time updated');
  }

  /**
   * Check if channel has initialized schedule time
   */
  public async hasScheduleTime(channelId: string): Promise<boolean> {
    const startTime = await this.getScheduleStartTime(channelId);
    return startTime !== null;
  }
}
