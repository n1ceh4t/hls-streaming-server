import { ChannelService } from '../channel/ChannelService';
import { StateStore, ServerState, ChannelState as SavedChannelState } from '../../infrastructure/storage/StateStore';
import { ChannelState as ChannelStateEnum } from '../../domain/channel/Channel';
import { ChannelRepository } from '../../infrastructure/database/repositories/ChannelRepository';
import { createLogger } from '../../utils/logger';

const logger = createLogger('StatePersistence');

export interface PersistenceOptions {
  autoSaveInterval?: number; // Auto-save interval in ms (0 to disable)
  stateDir?: string;
}

export interface RestoreResult {
  restored: boolean;
  channelsToResume: string[]; // Channel IDs that were streaming and need to be resumed
}

/**
 * StatePersistence - Manage state persistence for the server
 */
export class StatePersistence {
  private readonly channelService: ChannelService;
  private readonly stateStore: StateStore;
  private readonly autoSaveInterval: number;
  private autoSaveTimer?: NodeJS.Timeout;

  constructor(
    channelService: ChannelService,
    options: PersistenceOptions = {}
  ) {
    this.channelService = channelService;
    this.stateStore = new StateStore(options.stateDir || './data');
    this.autoSaveInterval = options.autoSaveInterval || 60000; // Default: 1 minute
  }

  /**
   * Start auto-save timer
   */
  public startAutoSave(): void {
    if (this.autoSaveInterval <= 0) {
      logger.info('Auto-save disabled');
      return;
    }

    this.autoSaveTimer = setInterval(async () => {
      try {
        await this.save();
      } catch (error) {
        logger.error({ error }, 'Auto-save failed');
      }
    }, this.autoSaveInterval);

    logger.info(
      { intervalMs: this.autoSaveInterval },
      'Auto-save started'
    );
  }

  /**
   * Stop auto-save timer
   */
  public stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
      logger.info('Auto-save stopped');
    }
  }

  /**
   * Save current state
   */
  public async save(): Promise<void> {
    const channels = this.channelService.getAllChannels();
    const channelStates: SavedChannelState[] = channels.map((channel) => {
      const metadata = channel.getMetadata();
      return {
        channelId: channel.id,
        channelConfig: channel.config,
        currentIndex: metadata.currentIndex,
        accumulatedTime: metadata.accumulatedTime,
        isStreaming: channel.isStreaming(),
        lastUpdated: new Date().toISOString(),
      };
    });

    const state: ServerState = {
      channels: channelStates,
      lastSaved: new Date().toISOString(),
      version: '1.0.0',
    };

    await this.stateStore.save(state);
  }

  /**
   * Restore state from disk
   * @param autoStart - Whether to automatically start channels that were streaming.
   *                    Should be false during initial restore, then call resumeStreaming() after media is scanned.
   */
  public async restore(autoStart: boolean = false): Promise<RestoreResult> {
    const state = await this.stateStore.load();
    if (!state) {
      logger.info('No state to restore');
      return { restored: false, channelsToResume: [] };
    }

    logger.info(
      { channelCount: state.channels.length, autoStart },
      'Restoring state'
    );

    let restoredCount = 0;
    const channelsToResume: string[] = [];

    for (const channelState of state.channels) {
      try {
        // Check if channel already exists (e.g., from previous restore attempt)
        let channel;
        try {
          channel = await this.channelService.getChannel(channelState.channelId);
        } catch {
          // Support both old format (without channelConfig) and new format
          if (!channelState.channelConfig) {
            logger.warn(
              { channelId: channelState.channelId },
              'Channel config not found in saved state, skipping restoration'
            );
            continue;
          }

          // Channel doesn't exist, create it from saved config
          logger.info(
            { channelId: channelState.channelId, slug: channelState.channelConfig.slug },
            'Recreating channel from saved state'
          );

          // Create channel with saved ID and config
          const { Channel } = await import('../../domain/channel/Channel');
          channel = new Channel(
            channelState.channelConfig,
            channelState.channelId,
            undefined, // State will be restored after creation
            {
              currentIndex: channelState.currentIndex,
              accumulatedTime: channelState.accumulatedTime,
            }
          );

          // Restore channel to service (saves to database)
          await this.channelService.restoreChannel(channel);
        }

        // Restore metadata (channel should now exist in database)
        const restoredChannel = await this.channelService.getChannel(channelState.channelId);
        restoredChannel.updateCurrentIndex(channelState.currentIndex);
        restoredChannel.updateAccumulatedTime(channelState.accumulatedTime);

        // Track channels that need to be resumed
        // Resume if: (1) was streaming, OR (2) has autoStart enabled
        const shouldResume = (channelState.isStreaming || restoredChannel.config.autoStart) && !restoredChannel.isStreaming();
        
        if (shouldResume) {
          channelsToResume.push(channelState.channelId);

          // Only auto-start if explicitly requested AND media files are available
          if (autoStart) {
            logger.info(
              { channelId: channelState.channelId, reason: channelState.isStreaming ? 'was streaming' : 'autoStart enabled' },
              'Auto-starting channel from restored state'
            );

            try {
              const mediaFiles = await this.channelService.getChannelMedia(channelState.channelId);
              if (mediaFiles.length > 0) {
                await this.channelService.startChannel(
                  channelState.channelId,
                  channelState.currentIndex
                );
              } else {
                logger.warn(
                  { channelId: channelState.channelId },
                  'Channel marked for resume but has no media files yet'
                );
              }
            } catch (error) {
              logger.error(
                { error, channelId: channelState.channelId },
                'Failed to restore streaming state'
              );
            }
          } else {
            logger.info(
              { channelId: channelState.channelId, reason: channelState.isStreaming ? 'was streaming' : 'autoStart enabled' },
              'Channel marked for resume after media scan'
            );
          }
        }

        restoredCount++;
      } catch (error) {
        logger.warn(
          { error, channelId: channelState.channelId },
          'Failed to restore channel state'
        );
      }
    }

    logger.info(
      { restoredCount, totalChannels: state.channels.length, channelsToResume: channelsToResume.length },
      'State restoration complete'
    );

    return {
      restored: restoredCount > 0,
      channelsToResume,
    };
  }

  /**
   * Resume streaming for channels that were previously streaming.
   * Call this after media files have been scanned and assigned to channels.
   */
  public async resumeStreaming(channelIds: string[]): Promise<void> {
    if (channelIds.length === 0) {
      return;
    }

    logger.info(
      { count: channelIds.length },
      'Resuming streaming for restored channels'
    );

    for (const channelId of channelIds) {
      try {
        const channel = await this.channelService.getChannel(channelId);
        const media = await this.channelService.getChannelMedia(channelId);

        // Only resume if channel has media files
        if (media.length === 0) {
          logger.warn(
            { channelId },
            'Cannot resume streaming: channel has no media files'
          );
          continue;
        }

        // Use the channel's current index (restored from state)
        const currentIndex = channel.getMetadata().currentIndex;

        // Ensure channel is in IDLE state before starting
        // If channel is in STARTING, STOPPING or ERROR state, transition to IDLE first
        const channelState = channel.getState();
        if (channelState === ChannelStateEnum.STARTING ||
            channelState === ChannelStateEnum.STOPPING ||
            channelState === ChannelStateEnum.ERROR) {
          logger.info(
            { channelId, currentState: channelState },
            'Resetting channel state to IDLE before resuming'
          );
          // Use the Channel's transitionTo method if possible, otherwise force to IDLE
          try {
            // Try to transition through valid states
            if (channelState === ChannelStateEnum.STARTING) {
              channel.transitionTo(ChannelStateEnum.IDLE);
            } else if (channelState === ChannelStateEnum.STOPPING) {
              channel.transitionTo(ChannelStateEnum.IDLE);
            } else if (channelState === ChannelStateEnum.ERROR) {
              channel.transitionTo(ChannelStateEnum.IDLE);
            }
          } catch {
            // If transition fails, force to IDLE (safe after server restart)
            (channel as any).state = ChannelStateEnum.IDLE;
          }

          // Update database state
          const channelRepository = new ChannelRepository();
          await channelRepository.update(channelId, {
            state: ChannelStateEnum.IDLE,
          });
        }

        logger.info(
          { channelId, currentIndex, mediaCount: media.length, state: channel.getState() },
          'Resuming channel streaming'
        );

        // Check if FFmpeg is already running for this channel
        const isAlreadyActive = this.channelService['ffmpegEngine'].isActive(channelId);
        if (isAlreadyActive) {
          logger.warn({ channelId }, 'Channel already has active FFmpeg stream, skipping resume');
          continue;
        }

        await this.channelService.startChannel(channelId, currentIndex);
        
        // Verify the stream actually started
        const streamStarted = this.channelService['ffmpegEngine'].isActive(channelId);
        if (!streamStarted) {
          logger.error({ channelId }, 'Channel startChannel completed but FFmpeg stream is not active');
        } else {
          logger.info({ channelId }, 'Channel streaming resumed successfully');
        }
      } catch (error) {
        logger.error(
          { 
            error, 
            channelId,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
          },
          'Failed to resume streaming for channel'
        );
      }
    }
  }

  /**
   * Clear persisted state
   */
  public async clear(): Promise<void> {
    await this.stateStore.clear();
  }

  /**
   * Check if persisted state exists
   */
  public async exists(): Promise<boolean> {
    return await this.stateStore.exists();
  }

  /**
   * Cleanup (save state and stop auto-save)
   */
  public async cleanup(): Promise<void> {
    logger.info('Cleaning up state persistence');
    this.stopAutoSave();
    await this.save();
  }
}
