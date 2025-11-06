import { Database } from '../Database';

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

    // Get all enabled blocks for this channel/day (filter by time in TypeScript to handle wraparound)
    const result = await Database.query<ScheduleBlockRow>(
      `SELECT * FROM schedule_blocks
       WHERE channel_id = $1
         AND enabled = TRUE
         AND (
           day_of_week IS NULL
           OR $2 = ANY(day_of_week)
         )
       ORDER BY priority DESC, created_at ASC`,
      [channelId, dayOfWeek]
    );

    // Filter by time range (handles midnight wraparound)
    for (const block of result.rows) {
      const startMinutes = this.timeToMinutes(block.start_time);
      const endMinutes = this.timeToMinutes(block.end_time);
      
      let isActive = false;
      if (endMinutes > startMinutes) {
        // Normal case: 09:00-17:00
        isActive = currentMinutes >= startMinutes && currentMinutes < endMinutes;
      } else {
        // Wraparound case: 23:00-01:00 (spans midnight)
        isActive = currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }
      
      if (isActive) {
        return block;
      }
    }
    
    return null;
  }

  /**
   * Convert time string (HH:MM:SS) to minutes since midnight
   */
  private timeToMinutes(timeStr: string): number {
    const [h, m, s] = timeStr.split(':').map(Number);
    return h * 60 + m + (s || 0) / 60;
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
}

