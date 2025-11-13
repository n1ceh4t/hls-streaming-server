import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';
import { ChannelConfig } from '../../domain/channel/Channel';

const logger = createLogger('StateStore');

export interface ChannelState {
  channelId: string;
  channelConfig?: ChannelConfig; // Optional for backward compatibility with old state files
  currentIndex: number;
  accumulatedTime: number;
  isStreaming: boolean;
  lastUpdated: string;
}

export interface ServerState {
  channels: ChannelState[];
  lastSaved: string;
  version: string;
}

/**
 * StateStore - Persist and restore server state
 */
export class StateStore {
  private readonly stateFilePath: string;
  private readonly backupFilePath: string;

  constructor(stateDir: string = './data') {
    this.stateFilePath = path.join(stateDir, 'state.json');
    this.backupFilePath = path.join(stateDir, 'state.backup.json');
  }

  /**
   * Save server state to disk (atomic write)
   */
  public async save(state: ServerState): Promise<void> {
    try {
      const stateWithTimestamp: ServerState = {
        ...state,
        lastSaved: new Date().toISOString(),
        version: '1.0.0',
      };

      const tempPath = `${this.stateFilePath}.tmp`;

      // Create directory if it doesn't exist
      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });

      // Backup existing state if it exists
      try {
        await fs.access(this.stateFilePath);
        await fs.copyFile(this.stateFilePath, this.backupFilePath);
      } catch {
        // File doesn't exist yet, that's okay
      }

      // Write to temp file
      await fs.writeFile(tempPath, JSON.stringify(stateWithTimestamp, null, 2), 'utf8');

      // Atomic rename
      await fs.rename(tempPath, this.stateFilePath);

      logger.debug(
        { channelCount: state.channels.length },
        'State saved successfully'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to save state');
      throw error;
    }
  }

  /**
   * Load server state from disk
   */
  public async load(): Promise<ServerState | null> {
    try {
      await fs.access(this.stateFilePath);
      const content = await fs.readFile(this.stateFilePath, 'utf8');
      const state = JSON.parse(content) as ServerState;

      logger.info(
        { channelCount: state.channels.length, lastSaved: state.lastSaved },
        'State loaded successfully'
      );

      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No state file found, starting fresh');
        return null;
      }

      // Try to restore from backup
      logger.warn({ error }, 'Failed to load state, trying backup');
      return await this.loadBackup();
    }
  }

  /**
   * Load from backup file
   */
  private async loadBackup(): Promise<ServerState | null> {
    try {
      await fs.access(this.backupFilePath);
      const content = await fs.readFile(this.backupFilePath, 'utf8');
      const state = JSON.parse(content) as ServerState;

      logger.info('State restored from backup');
      return state;
    } catch (error) {
      logger.error({ error }, 'Failed to load backup state');
      return null;
    }
  }

  /**
   * Delete state file
   */
  public async clear(): Promise<void> {
    try {
      await fs.unlink(this.stateFilePath);
      await fs.unlink(this.backupFilePath);
      logger.info('State cleared');
    } catch (error) {
      logger.warn({ error }, 'Failed to clear state');
    }
  }

  /**
   * Check if state file exists
   */
  public async exists(): Promise<boolean> {
    try {
      await fs.access(this.stateFilePath);
      return true;
    } catch {
      return false;
    }
  }
}
