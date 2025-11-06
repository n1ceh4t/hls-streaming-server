import { v4 as uuidv4 } from 'uuid';

export interface ProgramInfo {
  title: string;
  description?: string;
  category?: string;
  episodeNum?: string; // Format: "S01E05" or "1.5"
  icon?: string; // URL to program icon/thumbnail
}

/**
 * Program entity - represents a single program in the EPG
 */
export class Program {
  public readonly id: string;
  public readonly channelId: string;
  public readonly startTime: Date;
  public readonly endTime: Date;
  public readonly duration: number; // seconds
  public readonly info: ProgramInfo;

  constructor(
    channelId: string,
    startTime: Date,
    endTime: Date,
    info: ProgramInfo,
    id?: string
  ) {
    this.id = id || uuidv4();
    this.channelId = channelId;
    this.startTime = startTime;
    this.endTime = endTime;
    this.duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);
    this.info = info;
  }

  /**
   * Check if program is currently airing
   */
  public isAiring(now: Date = new Date()): boolean {
    return now >= this.startTime && now < this.endTime;
  }

  /**
   * Check if program has already aired
   */
  public hasAired(now: Date = new Date()): boolean {
    return now >= this.endTime;
  }

  /**
   * Check if program is upcoming
   */
  public isUpcoming(now: Date = new Date()): boolean {
    return now < this.startTime;
  }

  /**
   * Get progress percentage (0-100)
   */
  public getProgress(now: Date = new Date()): number {
    if (!this.isAiring(now)) {
      return this.hasAired(now) ? 100 : 0;
    }

    const elapsed = now.getTime() - this.startTime.getTime();
    const total = this.endTime.getTime() - this.startTime.getTime();
    return Math.min(100, Math.max(0, (elapsed / total) * 100));
  }

  /**
   * Serialize to JSON
   */
  public toJSON() {
    return {
      id: this.id,
      channelId: this.channelId,
      startTime: this.startTime.toISOString(),
      endTime: this.endTime.toISOString(),
      duration: this.duration,
      info: this.info,
    };
  }

  /**
   * Deserialize from JSON
   */
  public static fromJSON(data: ReturnType<Program['toJSON']>): Program {
    return new Program(
      data.channelId,
      new Date(data.startTime),
      new Date(data.endTime),
      data.info,
      data.id
    );
  }
}
