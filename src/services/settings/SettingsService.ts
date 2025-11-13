import { SettingsRepository } from '../../infrastructure/database/repositories/SettingsRepository';
import { logger } from '../../utils/logger';

/**
 * Valid FFmpeg preset values (whitelist for security)
 */
export const VALID_FFMPEG_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

export type FFmpegPreset = typeof VALID_FFMPEG_PRESETS[number];

/**
 * Service for managing global server settings
 */
export class SettingsService {
  private settingsRepository: SettingsRepository;

  constructor() {
    this.settingsRepository = new SettingsRepository();
  }

  /**
   * Get a setting value
   */
  public async getSetting(key: string): Promise<string | null> {
    return this.settingsRepository.get(key);
  }

  /**
   * Set a setting value
   */
  public async setSetting(key: string, value: string, description?: string): Promise<void> {
    await this.settingsRepository.set(key, value, description);
    logger.info({ key, value }, 'Global setting updated');
  }

  /**
   * Get all settings
   */
  public async getAllSettings(): Promise<Record<string, string>> {
    return this.settingsRepository.getAll();
  }

  /**
   * Get FFmpeg preset setting (with fallback to env var)
   */
  public async getFFmpegPreset(): Promise<string> {
    const preset = await this.settingsRepository.get('ffmpeg_preset');
    if (preset) {
      return preset;
    }
    // Fallback to environment variable
    const envPreset = process.env.FFMPEG_PRESET || 'fast';
    logger.debug({ preset: envPreset, source: 'env' }, 'Using FFmpeg preset from environment');
    return envPreset;
  }

  /**
   * Set FFmpeg preset
   * Validates against whitelist to prevent injection attacks
   */
  public async setFFmpegPreset(preset: string): Promise<void> {
    // Security: Whitelist validation - reject any value not in VALID_FFMPEG_PRESETS
    if (!VALID_FFMPEG_PRESETS.includes(preset as FFmpegPreset)) {
      throw new Error(`Invalid preset: ${preset}. Valid presets: ${VALID_FFMPEG_PRESETS.join(', ')}`);
    }
    await this.setSetting(
      'ffmpeg_preset',
      preset,
      'FFmpeg encoding preset (ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow)'
    );
  }

  /**
   * Get log level setting (with fallback to env var)
   */
  public async getLogLevel(): Promise<string> {
    const level = await this.settingsRepository.get('log_level');
    if (level) {
      return level;
    }
    return process.env.LOG_LEVEL || 'info';
  }

  /**
   * Set log level
   */
  public async setLogLevel(level: string): Promise<void> {
    const validLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
    if (!validLevels.includes(level)) {
      throw new Error(`Invalid log level: ${level}. Valid levels: ${validLevels.join(', ')}`);
    }
    await this.setSetting('log_level', level, 'Logging level (fatal, error, warn, info, debug, trace)');
  }

  /**
   * Get hardware acceleration setting (with fallback to env var)
   */
  public async getHardwareAcceleration(): Promise<string> {
    const hwAccel = await this.settingsRepository.get('hw_accel');
    if (hwAccel) {
      return hwAccel;
    }
    return process.env.HW_ACCEL || 'none';
  }

  /**
   * Set hardware acceleration
   */
  public async setHardwareAcceleration(hwAccel: string): Promise<void> {
    const validOptions = ['none', 'nvenc', 'qsv', 'videotoolbox'];
    if (!validOptions.includes(hwAccel)) {
      throw new Error(`Invalid hardware acceleration: ${hwAccel}. Valid options: ${validOptions.join(', ')}`);
    }
    await this.setSetting('hw_accel', hwAccel, 'Hardware acceleration (none, nvenc, qsv, videotoolbox)');
  }

  /**
   * Get max concurrent streams setting (with fallback to env var)
   */
  public async getMaxConcurrentStreams(): Promise<number> {
    const value = await this.settingsRepository.get('max_concurrent_streams');
    if (value) {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num >= 1 && num <= 100) {
        return num;
      }
    }
    return parseInt(process.env.MAX_CONCURRENT_STREAMS || '8', 10);
  }

  /**
   * Set max concurrent streams
   */
  public async setMaxConcurrentStreams(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      throw new Error('Max concurrent streams must be an integer between 1 and 100');
    }
    await this.setSetting('max_concurrent_streams', count.toString(), 'Maximum number of concurrent streams (1-100)');
  }

  /**
   * Get enable auto scan setting (with fallback to env var)
   */
  public async getEnableAutoScan(): Promise<boolean> {
    const value = await this.settingsRepository.get('enable_auto_scan');
    if (value !== null) {
      return value === 'true';
    }
    return process.env.ENABLE_AUTO_SCAN !== 'false';
  }

  /**
   * Set enable auto scan
   */
  public async setEnableAutoScan(enabled: boolean): Promise<void> {
    await this.setSetting('enable_auto_scan', enabled ? 'true' : 'false', 'Enable automatic library scanning');
  }

  /**
   * Get auto scan interval setting (with fallback to env var)
   */
  public async getAutoScanInterval(): Promise<number> {
    const value = await this.settingsRepository.get('auto_scan_interval');
    if (value) {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num >= 1) {
        return num;
      }
    }
    return parseInt(process.env.AUTO_SCAN_INTERVAL || '60', 10);
  }

  /**
   * Set auto scan interval
   */
  public async setAutoScanInterval(minutes: number): Promise<void> {
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new Error('Auto scan interval must be an integer >= 1 (minutes)');
    }
    await this.setSetting('auto_scan_interval', minutes.toString(), 'Auto scan interval in minutes');
  }

  /**
   * Get viewer disconnect grace period setting (with fallback to env var)
   */
  public async getViewerDisconnectGracePeriod(): Promise<number> {
    const value = await this.settingsRepository.get('viewer_disconnect_grace_period');
    if (value) {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num > 0) {
        return num;
      }
    }
    return parseInt(process.env.VIEWER_DISCONNECT_GRACE_PERIOD || '45', 10);
  }

  /**
   * Set viewer disconnect grace period
   */
  public async setViewerDisconnectGracePeriod(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new Error('Viewer disconnect grace period must be a positive integer (seconds)');
    }
    await this.setSetting('viewer_disconnect_grace_period', seconds.toString(), 'Seconds before pausing stream when no viewers');
  }
}

