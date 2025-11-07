import { MediaFile } from '../../domain/media/MediaFile';
import { createLogger } from '../../utils/logger';
import { Database } from '../../infrastructure/database/Database';

const logger = createLogger('VirtualTimeService');

export interface VirtualPosition {
  totalVirtualSeconds: number;
  currentIndex: number;
  positionInFile: number;
  virtualStartTime: Date | null;
  isPaused: boolean;
  pausedAt: Date | null;
}

export interface ChannelVirtualTime {
  channelId: string;
  virtualStartTime: Date | null;
  virtualPausedAt: Date | null;
  totalVirtualSeconds: number;
  virtualCurrentIndex: number;
  virtualPositionInFile: number;
  updatedAt: Date;
}

// Database row interface (snake_case from PostgreSQL)
interface ChannelVirtualTimeRow {
  virtual_start_time: Date | null;
  virtual_paused_at: Date | null;
  total_virtual_seconds: number;
  virtual_current_index: number;
  virtual_position_in_file: number;
  updated_at: Date;
}

/**
 * Service for managing virtual time progression
 * Enables "perceived continuous streaming" where channels maintain timeline
 * even when no viewers are present
 */
export class VirtualTimeService {
  /**
   * Calculate current virtual position for a channel
   * Returns where the channel "would be" in its timeline right now
   */
  public calculateCurrentVirtualPosition(
    channel: ChannelVirtualTime,
    mediaFiles: MediaFile[],
    now: Date = new Date()
  ): VirtualPosition {
    // If no virtual start time, timeline hasn't been initialized
    if (!channel.virtualStartTime) {
      return {
        totalVirtualSeconds: 0,
        currentIndex: 0,
        positionInFile: 0,
        virtualStartTime: null,
        isPaused: !!channel.virtualPausedAt,
        pausedAt: channel.virtualPausedAt,
      };
    }

    if (mediaFiles.length === 0) {
      return {
        totalVirtualSeconds: channel.totalVirtualSeconds,
        currentIndex: channel.virtualCurrentIndex,
        positionInFile: channel.virtualPositionInFile,
        virtualStartTime: channel.virtualStartTime,
        isPaused: !!channel.virtualPausedAt,
        pausedAt: channel.virtualPausedAt,
      };
    }

    // Start from the stored index and position (last known position)
    let currentIndex = channel.virtualCurrentIndex;
    let positionInFile = channel.virtualPositionInFile;

    // Calculate elapsed time since last update
    let elapsedSeconds = 0;
    if (channel.virtualPausedAt) {
      // Currently paused - time doesn't advance
      elapsedSeconds = 0;
    } else {
      // Currently streaming - add elapsed time since last update
      // CRITICAL: Use updatedAt if available, otherwise use virtualStartTime
      // But if updatedAt is missing, we should use the most recent timestamp available
      const lastUpdate = channel.updatedAt || channel.virtualStartTime;
      if (lastUpdate) {
        elapsedSeconds = Math.floor((now.getTime() - lastUpdate.getTime()) / 1000);
        elapsedSeconds = Math.max(0, elapsedSeconds);
        
        // Safety check: If elapsed time is unreasonably large (more than 24 hours),
        // it likely means updatedAt is stale or missing. In this case, don't advance
        // to prevent position jumps. This can happen if the update loop hasn't run
        // or if there was a database issue.
        const MAX_REASONABLE_ELAPSED = 24 * 60 * 60; // 24 hours in seconds
        if (elapsedSeconds > MAX_REASONABLE_ELAPSED) {
          logger.warn(
            {
              channelId: channel.channelId,
              elapsedSeconds,
              lastUpdate: lastUpdate.toISOString(),
              now: now.toISOString(),
              hasUpdatedAt: !!channel.updatedAt,
            },
            'Elapsed time is unreasonably large - likely stale updatedAt. Not advancing virtual time.'
          );
          elapsedSeconds = 0;
        }
      }
    }

    // Advance position based on elapsed time
    if (elapsedSeconds > 0) {
      positionInFile += elapsedSeconds;

      // Advance through files if we've exceeded the current file's duration
      while (currentIndex < mediaFiles.length && positionInFile >= (mediaFiles[currentIndex].metadata?.duration || 0)) {
        const currentFileDuration = mediaFiles[currentIndex].metadata?.duration || 0;
        positionInFile -= currentFileDuration;
        currentIndex++;

        // Handle playlist looping
        if (currentIndex >= mediaFiles.length) {
          currentIndex = 0;
        }
      }
    }

    // Calculate total virtual seconds for reporting
    // This is the sum of all previous files + position in current file
    let totalVirtualSeconds = 0;
    for (let i = 0; i < currentIndex && i < mediaFiles.length; i++) {
      totalVirtualSeconds += mediaFiles[i].metadata?.duration || 0;
    }
    totalVirtualSeconds += positionInFile;

    // Handle looping - if we've gone through the entire playlist, normalize
    const totalPlaylistDuration = mediaFiles.reduce(
      (sum, file) => sum + (file.metadata?.duration || 0),
      0
    );
    if (totalPlaylistDuration > 0) {
      totalVirtualSeconds = totalVirtualSeconds % totalPlaylistDuration;
    }

    return {
      totalVirtualSeconds,
      currentIndex,
      positionInFile: Math.max(0, positionInFile),
      virtualStartTime: channel.virtualStartTime,
      isPaused: !!channel.virtualPausedAt,
      pausedAt: channel.virtualPausedAt,
    };
  }

  /**
   * Calculate which file and position in file for given virtual seconds
   */
  public calculateFilePosition(
    totalVirtualSeconds: number,
    mediaFiles: MediaFile[]
  ): { index: number; positionInFile: number } {
    if (mediaFiles.length === 0) {
      return { index: 0, positionInFile: 0 };
    }

    if (totalVirtualSeconds <= 0) {
      return { index: 0, positionInFile: 0 };
    }

    // Calculate total playlist duration
    const totalPlaylistDuration = mediaFiles.reduce(
      (sum, file) => sum + (file.metadata?.duration || 0),
      0
    );

    if (totalPlaylistDuration === 0) {
      logger.warn(
        { totalVirtualSeconds, mediaFilesCount: mediaFiles.length },
        'Total playlist duration is 0 - cannot calculate file position'
      );
      return { index: 0, positionInFile: 0 };
    }

    // Normalize to playlist duration (handle looping)
    const normalizedSeconds = totalVirtualSeconds % totalPlaylistDuration;

    // Find which file contains this position
    let accumulated = 0;
    let currentIndex = 0;
    let positionInFile = 0;

    for (let i = 0; i < mediaFiles.length; i++) {
      const fileDuration = mediaFiles[i].metadata?.duration || 0;

      if (accumulated + fileDuration > normalizedSeconds) {
        // Found the file containing this position
        currentIndex = i;
        positionInFile = Math.floor(normalizedSeconds - accumulated);
        
        logger.debug(
          {
            totalVirtualSeconds,
            normalizedSeconds,
            fileIndex: i,
            fileDuration,
            accumulated,
            positionInFile,
          },
          'Calculated file position from virtual time'
        );
        
        break;
      }

      accumulated += fileDuration;
    }

    // If we've gone through all files (shouldn't happen due to modulo, but safety check)
    if (accumulated < normalizedSeconds) {
      logger.warn(
        {
          totalVirtualSeconds,
          normalizedSeconds,
          accumulated,
          totalPlaylistDuration,
        },
        'Virtual seconds exceeds playlist duration - wrapping to beginning'
      );
      // Wrap around to beginning
      currentIndex = 0;
      positionInFile = 0;
    }

    return { index: currentIndex, positionInFile: Math.max(0, positionInFile) };
  }

  /**
   * Initialize virtual timeline for a channel
   * Called when channel starts streaming for the first time
   */
  public async initializeVirtualTimeline(channelId: string): Promise<void> {
    const now = new Date();

    await Database.query(
      `UPDATE channels 
       SET 
         virtual_start_time = $1,
         virtual_paused_at = NULL,
         total_virtual_seconds = 0,
         virtual_current_index = 0,
         virtual_position_in_file = 0,
         updated_at = $1
       WHERE id = $2`,
      [now, channelId]
    );

    logger.info({ channelId, virtualStartTime: now }, 'Virtual timeline initialized');
  }

  /**
   * Advance virtual time (called periodically while streaming)
   * Updates the channel's virtual time metrics in the database
   */
  public async advanceVirtualTime(
    channelId: string,
    totalVirtualSeconds: number,
    currentIndex: number,
    positionInFile: number
  ): Promise<void> {
    await Database.query(
      `UPDATE channels 
       SET 
         total_virtual_seconds = $1,
         virtual_current_index = $2,
         virtual_position_in_file = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [totalVirtualSeconds, currentIndex, positionInFile, channelId]
    );
  }

  /**
   * Pause virtual time (when last viewer disconnects)
   * Note: This should be called with the current media files to calculate accurate index/position
   */
  public async pauseVirtualTime(channelId: string, mediaFiles?: MediaFile[]): Promise<void> {
    const now = new Date();

    // Get current virtual position before pausing
    const result = await Database.query<ChannelVirtualTimeRow>(
      `SELECT 
         virtual_start_time,
         virtual_paused_at,
         total_virtual_seconds,
         virtual_current_index,
         virtual_position_in_file,
         updated_at
       FROM channels
       WHERE id = $1`,
      [channelId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const row = result.rows[0];
    
    // If media files are provided, calculate current index and position accurately
    let finalIndex = row.virtual_current_index;
    let finalPositionInFile = row.virtual_position_in_file;
    let finalTotalSeconds = row.total_virtual_seconds;

    if (mediaFiles && mediaFiles.length > 0 && !row.virtual_paused_at && row.virtual_start_time && row.updated_at) {
      // Calculate current position with elapsed time
      const elapsed = Math.floor((now.getTime() - row.updated_at.getTime()) / 1000);
      const elapsedSeconds = Math.max(0, elapsed);
      
      // Start from stored position
      let currentIndex = row.virtual_current_index;
      let positionInFile = row.virtual_position_in_file;
      
      // Add elapsed time
      positionInFile += elapsedSeconds;
      
      // Advance through files if needed
      while (currentIndex < mediaFiles.length && positionInFile >= (mediaFiles[currentIndex].metadata?.duration || 0)) {
        const currentFileDuration = mediaFiles[currentIndex].metadata?.duration || 0;
        positionInFile -= currentFileDuration;
        currentIndex++;
        
        // Handle looping
        if (currentIndex >= mediaFiles.length) {
          currentIndex = 0;
        }
      }
      
      finalIndex = currentIndex;
      finalPositionInFile = Math.max(0, positionInFile);
      
      // Calculate total seconds for backwards compatibility
      let totalSeconds = 0;
      for (let i = 0; i < finalIndex && i < mediaFiles.length; i++) {
        totalSeconds += mediaFiles[i].metadata?.duration || 0;
      }
      totalSeconds += finalPositionInFile;
      
      const totalPlaylistDuration = mediaFiles.reduce(
        (sum, file) => sum + (file.metadata?.duration || 0),
        0
      );
      if (totalPlaylistDuration > 0) {
        totalSeconds = totalSeconds % totalPlaylistDuration;
      }
      
      finalTotalSeconds = totalSeconds;
    } else if (!row.virtual_paused_at && row.virtual_start_time && row.updated_at) {
      // Fallback: just calculate elapsed time without media files
      const elapsed = Math.floor((now.getTime() - row.updated_at.getTime()) / 1000);
      finalTotalSeconds = row.total_virtual_seconds + Math.max(0, elapsed);
    }

    await Database.query(
      `UPDATE channels 
       SET 
         virtual_paused_at = $1,
         total_virtual_seconds = $2,
         virtual_current_index = $3,
         virtual_position_in_file = $4,
         updated_at = $1
       WHERE id = $5`,
      [now, finalTotalSeconds, finalIndex, finalPositionInFile, channelId]
    );

    logger.info(
      {
        channelId,
        totalVirtualSeconds: finalTotalSeconds,
        currentIndex: finalIndex,
        positionInFile: finalPositionInFile,
        pausedAt: now,
      },
      'Virtual time paused'
    );
  }

  /**
   * Resume virtual time (when first viewer connects)
   * Calculates current virtual position and resumes from there
   */
  public async resumeVirtualTime(
    channelId: string,
    mediaFiles: MediaFile[]
  ): Promise<VirtualPosition> {
    // Get current channel state
    const result = await Database.query<ChannelVirtualTimeRow>(
      `SELECT 
         virtual_start_time,
         virtual_paused_at,
         total_virtual_seconds,
         virtual_current_index,
         virtual_position_in_file,
         updated_at
       FROM channels
       WHERE id = $1`,
      [channelId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Channel ${channelId} not found`);
    }

    const row = result.rows[0];
    const channel: ChannelVirtualTime = {
      channelId,
      virtualStartTime: row.virtual_start_time,
      virtualPausedAt: row.virtual_paused_at,
      totalVirtualSeconds: row.total_virtual_seconds,
      virtualCurrentIndex: row.virtual_current_index,
      virtualPositionInFile: row.virtual_position_in_file,
      updatedAt: row.updated_at,
    };

    // Calculate current virtual position (using paused time if was paused)
    const currentPosition = this.calculateCurrentVirtualPosition(channel, mediaFiles);

    // Clear pause status
    await Database.query(
      `UPDATE channels 
       SET 
         virtual_paused_at = NULL,
         total_virtual_seconds = $1,
         virtual_current_index = $2,
         virtual_position_in_file = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [
        currentPosition.totalVirtualSeconds,
        currentPosition.currentIndex,
        currentPosition.positionInFile,
        channelId,
      ]
    );

    logger.info(
      {
        channelId,
        totalVirtualSeconds: currentPosition.totalVirtualSeconds,
        currentIndex: currentPosition.currentIndex,
        positionInFile: currentPosition.positionInFile,
      },
      'Virtual time resumed'
    );

    return currentPosition;
  }

  /**
   * Get current virtual time state for a channel
   */
  public async getChannelVirtualTime(channelId: string): Promise<ChannelVirtualTime | null> {
    const result = await Database.query<ChannelVirtualTimeRow>(
      `SELECT 
         virtual_start_time,
         virtual_paused_at,
         total_virtual_seconds,
         virtual_current_index,
         virtual_position_in_file,
         updated_at
       FROM channels
       WHERE id = $1`,
      [channelId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      channelId,
      virtualStartTime: row.virtual_start_time,
      virtualPausedAt: row.virtual_paused_at,
      totalVirtualSeconds: row.total_virtual_seconds,
      virtualCurrentIndex: row.virtual_current_index,
      virtualPositionInFile: row.virtual_position_in_file,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Reset virtual timeline (start from beginning)
   */
  public async resetVirtualTimeline(channelId: string): Promise<void> {
    await Database.query(
      `UPDATE channels 
       SET 
         virtual_start_time = NULL,
         virtual_paused_at = NULL,
         total_virtual_seconds = 0,
         virtual_current_index = 0,
         virtual_position_in_file = 0,
         updated_at = NOW()
       WHERE id = $1`,
      [channelId]
    );

    logger.info({ channelId }, 'Virtual timeline reset');
  }
}

