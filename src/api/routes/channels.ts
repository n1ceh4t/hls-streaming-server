import { Router, Request, Response, NextFunction } from 'express';
import { ChannelService } from '../../services/channel/ChannelService';
import { AuthService } from '../../services/auth/AuthService';
import { LibraryService } from '../../services/library/LibraryService';
import { MediaBucketService } from '../../services/bucket/MediaBucketService';
import { VirtualTimeService } from '../../services/virtual-time/VirtualTimeService';
import { ScheduleTimeService } from '../../services/schedule-time/ScheduleTimeService';
import { authenticate } from '../middleware/auth';
import { config } from '../../config/env';
import { z } from 'zod';

const router = Router();

// Validation schemas
const createChannelSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  videoBitrate: z.number().positive().optional(),
  audioBitrate: z.number().positive().optional(),
  resolution: z.string().regex(/^\d+x\d+$/).optional(),
  fps: z.number().min(1).max(120).optional(),
  segmentDuration: z.number().min(1).max(30).optional(),
  autoStart: z.boolean().optional(),
  useDynamicPlaylist: z.boolean().optional(),
  includeBumpers: z.boolean().optional(),
});

const setIndexSchema = z.object({
  index: z.number().int().min(0),
});

const updateChannelSchema = z.object({
  useDynamicPlaylist: z.boolean().optional(),
  includeBumpers: z.boolean().optional(),
  autoStart: z.boolean().optional(),
});

const updateScheduleTimeSchema = z.object({
  scheduleStartTime: z.string().datetime(),
});

export const createChannelRoutes = (channelService: ChannelService, authService?: AuthService, _libraryService?: LibraryService, bucketService?: MediaBucketService) => {
  const requireAuth = authenticate(authService);
  const virtualTimeService = new VirtualTimeService();
  const scheduleTimeService = new ScheduleTimeService();

  // Helper function to format duration in seconds to human-readable format
  function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * GET /api/channels
   * List all channels
   */
  router.get('/', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const channels = channelService.getAllChannels();
      res.json({
        success: true,
        data: channels.map((ch) => ch.toJSON()),
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/channels/:channelId
   * Get channel by ID with virtual time information
   */
  router.get('/:channelId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channel = await channelService.getChannel(req.params.channelId);
      const media = await channelService.getChannelMedia(req.params.channelId);

      // Get virtual time state
      const virtualTime = await virtualTimeService.getChannelVirtualTime(req.params.channelId);

      let virtualTimeData = null;
      if (virtualTime && virtualTime.virtualStartTime) {
        const virtualPosition = virtualTimeService.calculateCurrentVirtualPosition(
          virtualTime,
          media
        );

        // Calculate virtual current time (epoch + accumulated seconds)
        const virtualCurrentTime = new Date(
          virtualTime.virtualStartTime.getTime() +
          virtualPosition.totalVirtualSeconds * 1000
        );

        virtualTimeData = {
          virtualStartTime: virtualTime.virtualStartTime.toISOString(),
          totalVirtualSeconds: virtualPosition.totalVirtualSeconds,
          currentIndex: virtualPosition.currentIndex,
          positionInFile: virtualPosition.positionInFile,
          isPaused: virtualPosition.isPaused,
          pausedAt: virtualPosition.pausedAt?.toISOString() || null,
          virtualCurrentTime: virtualCurrentTime.toISOString(),
          // Human-readable formats
          virtualCurrentTimeFormatted: virtualCurrentTime.toLocaleString(),
          totalVirtualDuration: formatDuration(virtualPosition.totalVirtualSeconds),
          positionInFileFormatted: formatDuration(virtualPosition.positionInFile),
        };
      }

      // Get schedule start time
      const scheduleStartTime = await scheduleTimeService.getScheduleStartTime(req.params.channelId);

      res.json({
        success: true,
        data: {
          ...channel.toJSON(),
          mediaCount: media.length,
          currentMedia: media[channel.getMetadata().currentIndex] || null,
          virtualTime: virtualTimeData,
          scheduleStartTime: scheduleStartTime?.toISOString() || null,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/channels
   * Create new channel
   */
  router.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = createChannelSchema.parse(req.body);

      const channel = await channelService.createChannel({
        ...validated,
        outputDir: `./hls_output/${validated.slug}`,
        videoBitrate: validated.videoBitrate || config.streaming.videoBitrate,
        audioBitrate: validated.audioBitrate || config.streaming.audioBitrate,
        resolution: validated.resolution || config.streaming.resolution,
        fps: validated.fps || config.streaming.fps,
        segmentDuration: validated.segmentDuration || config.streaming.segmentDuration,
        useDynamicPlaylist: validated.useDynamicPlaylist,
        includeBumpers: validated.includeBumpers,
      });

      res.status(201).json({
        success: true,
        data: channel.toJSON(),
      });
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: error.errors.map((e) => ({
              path: e.path,
              message: e.message,
              code: e.code,
            })),
          },
        });
      }
      return next(error);
    }
  });

  /**
   * POST /api/channels/:channelId/start
   * Start channel streaming
   */
  router.post('/:channelId/start', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await channelService.startChannel(req.params.channelId);

      res.json({
        success: true,
        message: 'Channel started',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/channels/:channelId/stop
   * Stop channel streaming
   */
  router.post('/:channelId/stop', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await channelService.stopChannel(req.params.channelId);

      res.json({
        success: true,
        message: 'Channel stopped',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/channels/:channelId/restart
   * Restart channel
   */
  router.post('/:channelId/restart', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await channelService.restartChannel(req.params.channelId);

      res.json({
        success: true,
        message: 'Channel restarted',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/channels/:channelId/next
   * Move to next media file
   */
  router.post('/:channelId/next', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await channelService.nextFile(req.params.channelId);

      res.json({
        success: true,
        message: 'Moved to next file',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/channels/:channelId
   * Update channel settings
   */
  router.put('/:channelId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const validated = updateChannelSchema.parse(req.body);
      
      await channelService.updateChannelConfig(channelId, validated);

      const channel = await channelService.getChannel(channelId);
      res.json({
        success: true,
        data: channel.toJSON(),
        message: 'Channel settings updated',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/channels/:channelId/index
   * Set file index
   */
  router.put('/:channelId/index', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { index } = setIndexSchema.parse(req.body);
      await channelService.setFileIndex(req.params.channelId, index);

      res.json({
        success: true,
        message: 'Index updated',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/channels/:channelId/schedule-time
   * Update schedule start time
   */
  router.put('/:channelId/schedule-time', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const validated = updateScheduleTimeSchema.parse(req.body);
      
      const scheduleStartTime = new Date(validated.scheduleStartTime);
      await scheduleTimeService.updateScheduleStartTime(channelId, scheduleStartTime);

      res.json({
        success: true,
        message: 'Schedule start time updated',
        data: {
          scheduleStartTime: scheduleStartTime.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: error.errors.map((e) => ({
              path: e.path,
              message: e.message,
              code: e.code,
            })),
          },
        });
      }
      return next(error);
    }
  });

  /**
   * DELETE /api/channels/:channelId
   * Delete channel
   */
  router.delete('/:channelId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await channelService.deleteChannel(req.params.channelId);

      res.json({
        success: true,
        message: 'Channel deleted',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/channels/:channelId/media
   * Get channel media files (respects dynamic playlist mode)
   * For dynamic playlists: Uses PlaylistResolver to get media from schedule blocks
   * For static playlists: Uses directly assigned buckets
   */
  router.get('/:channelId/media', async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Use channelService.getChannelMedia() which handles both static and dynamic playlists
      const mediaFiles = await channelService.getChannelMedia(req.params.channelId);
      
      return res.json({
        success: true,
        data: mediaFiles.map((m) => m.toJSON()),
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/channels/:channelId/media/count
   * Get channel media count from buckets
   */
  router.get('/:channelId/media/count', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (bucketService) {
        const count = await bucketService.getChannelMediaCount(req.params.channelId);
        return res.json({
          success: true,
          data: { count },
        });
      }
      
      // No fallback - buckets are required
      return res.json({
        success: true,
        data: { count: 0 },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/channels/:channelId/media
   * DEPRECATED - Direct media assignment is no longer supported.
   * Use buckets to assign media to channels instead.
   */
  router.put('/:channelId/media', requireAuth, async (_req: Request, res: Response, _next: NextFunction) => {
    return res.status(410).json({
      success: false,
      error: {
        code: 'DEPRECATED',
        message: 'Direct media assignment is no longer supported. Use buckets to assign media to channels. Assign buckets to channels via PUT /api/channels/:channelId/buckets',
      },
    });
  });

  return router;
};
