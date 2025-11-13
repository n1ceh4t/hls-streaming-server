import { Router, Request, Response, NextFunction } from 'express';
import { SettingsService, VALID_FFMPEG_PRESETS } from '../../services/settings/SettingsService';
import { authenticate } from '../middleware/auth';
import { AuthService } from '../../services/auth/AuthService';
import { z } from 'zod';

const router = Router();

// Security: Whitelist validation using shared constant
const updateSettingsSchema = z.object({
  ffmpegPreset: z.enum([...VALID_FFMPEG_PRESETS] as [string, ...string[]]).optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
  hwAccel: z.enum(['none', 'nvenc', 'qsv', 'videotoolbox']).optional(),
  maxConcurrentStreams: z.number().int().min(1).max(100).optional(),
  enableAutoScan: z.boolean().optional(),
  autoScanInterval: z.number().int().min(1).optional(),
  viewerDisconnectGracePeriod: z.number().int().positive().optional(),
});

export const createSettingsRoutes = (authService?: AuthService) => {
  const requireAuth = authenticate(authService);
  const settingsService = new SettingsService();

  /**
   * GET /api/settings
   * Get all global settings
   */
  router.get('/', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await settingsService.getAllSettings();
      res.json({
        success: true,
        data: settings,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/settings
   * Update global settings
   */
  router.put('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = updateSettingsSchema.parse(req.body);
      
      if (validated.ffmpegPreset !== undefined) {
        await settingsService.setFFmpegPreset(validated.ffmpegPreset);
      }
      if (validated.logLevel !== undefined) {
        await settingsService.setLogLevel(validated.logLevel);
      }
      if (validated.hwAccel !== undefined) {
        await settingsService.setHardwareAcceleration(validated.hwAccel);
      }
      if (validated.maxConcurrentStreams !== undefined) {
        await settingsService.setMaxConcurrentStreams(validated.maxConcurrentStreams);
      }
      if (validated.enableAutoScan !== undefined) {
        await settingsService.setEnableAutoScan(validated.enableAutoScan);
      }
      if (validated.autoScanInterval !== undefined) {
        await settingsService.setAutoScanInterval(validated.autoScanInterval);
      }
      if (validated.viewerDisconnectGracePeriod !== undefined) {
        await settingsService.setViewerDisconnectGracePeriod(validated.viewerDisconnectGracePeriod);
      }

      const updatedSettings = await settingsService.getAllSettings();
      res.json({
        success: true,
        message: 'Settings updated successfully',
        data: updatedSettings,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};

