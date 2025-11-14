import { Database } from '../Database';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('ScheduleRepository');

export interface ScheduleBlockRow {
  id: string;
  channel_id: string;
  name: string;
  day_of_week: number[] | null; // Array of days (0=Sunday, 6=Saturday), NULL = all days
  start_time: string; // TIME format
  end_time: string; // TIME format
  bucket_id: string | null;
  playback_mode: string; // 'sequential', 'random', 'shuffle'
  priority: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository for schedule_blocks database operations
 */
export class ScheduleRepository {
  /**
   * Get active schedule block for a channel at a specific time
   * 
   * CRITICAL: Handles midnight wraparound (e.g., 23:00-01:00 blocks)
   * 
   * @param channelId - Channel ID
   * @param currentTime - Time to check (defaults to now)
   * @returns Active schedule block or null
   */
  public async getActiveBlock(
    channelId: string,
    currentTime: Date = new Date()
  ): Promise<ScheduleBlockRow | null> {
    const dayOfWeek = currentTime.getDay(); // 0 = Sunday, 6 = Saturday
    const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    const timeStr = currentTime.toTimeString().substring(0, 8);

    // Get all enabled blocks for this channel/day (filter by time in TypeScript to handle wraparound)
    // CRITICAL: Also check previous day's blocks (for blocks ending at 00:00:00) and next day's blocks (for blocks starting at 00:00:00)
    const previousDay = (dayOfWeek - 1 + 7) % 7; // Previous day (wraps around)
    const nextDay = (dayOfWeek + 1) % 7; // Next day (wraps around)
    const isAtMidnight = currentMinutes === 0; // Exactly at 00:00:00
    const isNearMidnight = currentMinutes >= 23 * 60; // After 23:00 (for blocks starting at 00:00 tomorrow)
    
    const result = await Database.query<ScheduleBlockRow>(
      `SELECT * FROM schedule_blocks
       WHERE channel_id = $1
         AND enabled = TRUE
         AND (
           day_of_week IS NULL
           OR $2 = ANY(day_of_week)
           OR ($3 = TRUE AND $4 = ANY(day_of_week))
           OR ($5 = TRUE AND $6 = ANY(day_of_week))
         )
       ORDER BY priority DESC, created_at ASC`,
      [channelId, dayOfWeek, isAtMidnight, previousDay, isNearMidnight, nextDay]
    );

    // Log all blocks found for debugging
    logger.debug(
      {
        channelId,
        currentTime: currentTime.toISOString(),
        dayOfWeek,
        currentMinutes,
        timeStr,
        blocksFound: result.rows.length,
        blockDetails: result.rows.map(b => ({
          id: b.id,
          name: b.name,
          dayOfWeek: b.day_of_week,
          startTime: b.start_time,
          endTime: b.end_time,
          priority: b.priority,
        })),
      },
      'Checking for active schedule block'
    );

    // Filter by time range (simple within-day check)
    for (const block of result.rows) {
      const startMinutes = this.timeToMinutes(block.start_time);
      const endMinutes = this.timeToMinutes(block.end_time);
      
      // Simple check: current time must be between start and end
      const isActive = currentMinutes >= startMinutes && currentMinutes < endMinutes;
      
      logger.debug(
        {
          channelId,
          blockId: block.id,
          blockName: block.name,
          startTime: block.start_time,
          endTime: block.end_time,
          startMinutes,
          endMinutes,
          currentMinutes,
          isActive,
          dayOfWeekMatch: block.day_of_week === null || block.day_of_week.includes(dayOfWeek),
        },
        `Checking block: ${isActive ? 'ACTIVE' : 'not active'}`
      );
      
      if (isActive) {
        logger.debug(
          {
            channelId,
            blockId: block.id,
            blockName: block.name,
            currentTime: currentTime.toISOString(),
            dayOfWeek,
            timeStr,
          },
          'Found active schedule block'
        );
        return block;
      }
    }
    
    logger.warn(
      {
        channelId,
        currentTime: currentTime.toISOString(),
        dayOfWeek,
        currentMinutes,
        timeStr,
        blocksChecked: result.rows.length,
      },
      'No active schedule block found'
    );
    
    return null;
  }

  /**
   * Convert time string (HH:MM:SS) to minutes since midnight
   * Matches EPGService.timeToMinutes logic exactly
   */
  private timeToMinutes(timeStr: string): number {
    const [h, m, s] = timeStr.split(':').map(Number);
    return h * 60 + m + (s || 0) / 60;
  }

  /**
   * Get all enabled blocks for a channel (for debugging/comparison with EPG)
   */
  public async getAllEnabledBlocks(channelId: string): Promise<ScheduleBlockRow[]> {
    const result = await Database.query<ScheduleBlockRow>(
      `SELECT * FROM schedule_blocks
       WHERE channel_id = $1
         AND enabled = TRUE
       ORDER BY priority DESC, created_at ASC`,
      [channelId]
    );
    return result.rows;
  }

  /**
   * Get all schedule blocks for a channel
   */
  public async getBlocksForChannel(channelId: string): Promise<ScheduleBlockRow[]> {
    const result = await Database.query<ScheduleBlockRow>(
      `SELECT * FROM schedule_blocks
       WHERE channel_id = $1
       ORDER BY priority DESC, start_time ASC`,
      [channelId]
    );

    return result.rows;
  }

  /**
   * Get schedule blocks for a channel that are active at any time
   * (useful for getting all buckets used in schedules)
   */
  public async getEnabledBlocksForChannel(channelId: string): Promise<ScheduleBlockRow[]> {
    const result = await Database.query<ScheduleBlockRow>(
      `SELECT * FROM schedule_blocks
       WHERE channel_id = $1
         AND enabled = TRUE
         AND bucket_id IS NOT NULL
       ORDER BY priority DESC, start_time ASC`,
      [channelId]
    );

    return result.rows;
  }

  /**
   * Get the next schedule block transition time after currentTime
   *
   * This is critical for EPG generation - ensures EPG checks at exact block boundaries
   * instead of using fixed intervals that might miss transitions.
   *
   * @param channelId - Channel ID
   * @param currentTime - Current time (defaults to now)
   * @returns Date of next transition, or null if no future transitions found
   */
  public async getNextTransitionTime(
    channelId: string,
    currentTime: Date = new Date()
  ): Promise<Date | null> {
    const blocks = await this.getEnabledBlocksForChannel(channelId);

    if (blocks.length === 0) {
      return null;
    }

    const currentDayOfWeek = currentTime.getDay();
    const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

    let nextTransition: Date | null = null;
    let minTimeDiff = Infinity;

    // Check all blocks to find the nearest future transition (start time)
    for (const block of blocks) {
      const startMinutes = this.timeToMinutes(block.start_time);

      // Determine which days this block applies to
      const applicableDays = block.day_of_week === null
        ? [0, 1, 2, 3, 4, 5, 6] // All days
        : block.day_of_week;

      // Check each applicable day to find nearest future occurrence
      for (const targetDay of applicableDays) {
        // Calculate days until this occurrence
        let daysUntil = (targetDay - currentDayOfWeek + 7) % 7;

        // If it's today, check if the time has passed
        if (daysUntil === 0) {
          if (startMinutes <= currentMinutes) {
            // Block starts today but time has passed - check next week
            daysUntil = 7;
          }
          // else: Block starts today in the future - use daysUntil = 0
        }

        // Calculate the actual transition time
        const transitionTime = new Date(currentTime);
        transitionTime.setDate(transitionTime.getDate() + daysUntil);

        // Set time to block's start time
        const [hours, minutes, seconds] = block.start_time.split(':').map(Number);
        transitionTime.setHours(hours, minutes, seconds || 0, 0);

        // Calculate time difference in milliseconds
        const timeDiff = transitionTime.getTime() - currentTime.getTime();

        // Only consider future transitions (timeDiff > 0) and find the minimum
        if (timeDiff > 0 && timeDiff < minTimeDiff) {
          minTimeDiff = timeDiff;
          nextTransition = transitionTime;
        }
      }
    }

    if (nextTransition) {
      logger.debug(
        {
          channelId,
          currentTime: currentTime.toISOString(),
          nextTransition: nextTransition.toISOString(),
          minutesUntil: Math.round(minTimeDiff / 1000 / 60),
        },
        'Found next schedule block transition'
      );
    } else {
      logger.debug(
        {
          channelId,
          currentTime: currentTime.toISOString(),
          blocksChecked: blocks.length,
        },
        'No future schedule block transitions found'
      );
    }

    return nextTransition;
  }
}

