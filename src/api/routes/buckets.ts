import { Router, Request, Response, NextFunction } from 'express';
import { MediaBucketService } from '../../services/bucket/MediaBucketService';
import { AuthService } from '../../services/auth/AuthService';
import { authenticate } from '../middleware/auth';
import { ChannelService } from '../../services/channel/ChannelService';
import { EPGService } from '../../services/epg/EPGService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('BucketRoutes');
const router = Router();

export const createBucketRoutes = (
  bucketService: MediaBucketService,
  authService?: AuthService,
  channelService?: ChannelService,
  epgService?: EPGService
) => {
  const requireAuth = authenticate(authService);
  /**
   * GET /api/buckets
   * Get all media buckets
   */
  router.get('/api/buckets', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bucketType = req.query.type as 'global' | 'channel_specific' | undefined;
      const buckets = await bucketService.getAllBuckets(bucketType);

      return res.json({
        success: true,
        data: {
          buckets: buckets.map((b) => b.toJSON()),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/buckets
   * Create a new media bucket
   */
  router.post('/api/buckets', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, bucketType, description } = req.body;

      if (!name || !bucketType) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Name and bucketType are required',
          },
        });
      }

      if (!['global', 'channel_specific'].includes(bucketType)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bucketType must be "global" or "channel_specific"',
          },
        });
      }

      const bucket = await bucketService.createBucket({
        name,
        bucketType,
        description,
      });

      return res.status(201).json({
        success: true,
        data: {
          bucket: bucket.toJSON(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId
   * Get a specific bucket by ID
   */
  router.get('/api/buckets/:bucketId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bucket = await bucketService.getBucket(req.params.bucketId);

      return res.json({
        success: true,
        data: {
          bucket: bucket.toJSON(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/buckets/:bucketId
   * Update a bucket
   */
  router.put('/api/buckets/:bucketId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, description } = req.body;

      const bucket = await bucketService.updateBucket(req.params.bucketId, {
        name,
        description,
      });

      return res.json({
        success: true,
        data: {
          bucket: bucket.toJSON(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * DELETE /api/buckets/:bucketId
   * Delete a bucket
   */
  router.delete('/api/buckets/:bucketId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await bucketService.deleteBucket(req.params.bucketId);

      return res.json({
        success: true,
        message: 'Bucket deleted successfully',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId/media
   * Get all media files in a bucket
   */
  router.get('/api/buckets/:bucketId/media', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mediaFileIds = await bucketService.getMediaInBucket(req.params.bucketId);

      return res.json({
        success: true,
        data: {
          mediaFileIds,
          count: mediaFileIds.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/buckets/:bucketId/media
   * Add media files to a bucket
   */
  router.post('/api/buckets/:bucketId/media', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mediaFileIds } = req.body;

      if (!Array.isArray(mediaFileIds) || mediaFileIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'mediaFileIds must be a non-empty array',
          },
        });
      }

      await bucketService.addMediaToBucket(req.params.bucketId, mediaFileIds);

      // Invalidate cache for all channels using this bucket
      if (channelService && epgService) {
        try {
          const channelIds = await bucketService.getChannelsForBucket(req.params.bucketId);
          logger.info(
            { bucketId: req.params.bucketId, channelIds, addedCount: mediaFileIds.length },
            'Invalidating cache for channels using modified bucket'
          );
          
          for (const channelId of channelIds) {
            channelService.invalidateChannelMediaCache(channelId);
            await epgService.invalidateCache(channelId);
          }
        } catch (error) {
          logger.warn({ error, bucketId: req.params.bucketId }, 'Failed to invalidate cache after adding media to bucket');
        }
      }

      return res.json({
        success: true,
        message: `Added ${mediaFileIds.length} media file(s) to bucket`,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * DELETE /api/buckets/:bucketId/media/:mediaFileId
   * Remove a media file from a bucket
   */
  router.delete('/api/buckets/:bucketId/media/:mediaFileId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await bucketService.removeMediaFromBucket(req.params.bucketId, req.params.mediaFileId);

      // Invalidate cache for all channels using this bucket
      if (channelService && epgService) {
        try {
          const channelIds = await bucketService.getChannelsForBucket(req.params.bucketId);
          logger.info(
            { bucketId: req.params.bucketId, channelIds, removedMediaId: req.params.mediaFileId },
            'Invalidating cache for channels using modified bucket'
          );
          
          for (const channelId of channelIds) {
            channelService.invalidateChannelMediaCache(channelId);
            await epgService.invalidateCache(channelId);
          }
        } catch (error) {
          logger.warn({ error, bucketId: req.params.bucketId }, 'Failed to invalidate cache after removing media from bucket');
        }
      }

      return res.json({
        success: true,
        message: 'Media file removed from bucket',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/buckets/:bucketId/media/reorder
   * Reorder media files in a bucket
   */
  router.put('/api/buckets/:bucketId/media/reorder', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mediaFileIds } = req.body;

      if (!Array.isArray(mediaFileIds)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'mediaFileIds must be an array',
          },
        });
      }

      await bucketService.reorderMedia(req.params.bucketId, mediaFileIds);

      // Invalidate cache for all channels using this bucket
      if (channelService && epgService) {
        try {
          const channelIds = await bucketService.getChannelsForBucket(req.params.bucketId);
          logger.info(
            { bucketId: req.params.bucketId, channelIds, reorderedCount: mediaFileIds.length },
            'Invalidating cache for channels using reordered bucket'
          );
          
          for (const channelId of channelIds) {
            channelService.invalidateChannelMediaCache(channelId);
            await epgService.invalidateCache(channelId);
          }
        } catch (error) {
          logger.warn({ error, bucketId: req.params.bucketId }, 'Failed to invalidate cache after reordering bucket media');
        }
      }

      return res.json({
        success: true,
        message: 'Media files reordered successfully',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId/channels
   * Get all channels using a bucket
   */
  router.get('/api/buckets/:bucketId/channels', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channelIds = await bucketService.getChannelsForBucket(req.params.bucketId);

      return res.json({
        success: true,
        data: {
          channelIds,
          count: channelIds.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/buckets/:bucketId/channels/:channelId
   * Associate a bucket with a channel
   */
  router.post('/api/buckets/:bucketId/channels/:channelId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { priority } = req.body;

      await bucketService.addBucketToChannel(
        req.params.channelId,
        req.params.bucketId,
        priority || 1
      );

      return res.json({
        success: true,
        message: 'Bucket associated with channel',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * DELETE /api/buckets/:bucketId/channels/:channelId
   * Remove bucket from channel
   */
  router.delete('/api/buckets/:bucketId/channels/:channelId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await bucketService.removeBucketFromChannel(req.params.channelId, req.params.bucketId);

      return res.json({
        success: true,
        message: 'Bucket removed from channel',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/channels/:channelId/buckets
   * Get all buckets for a channel
   */
  router.get('/api/channels/:channelId/buckets', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const buckets = await bucketService.getBucketsForChannel(req.params.channelId);

      return res.json({
        success: true,
        data: {
          buckets: buckets.map((b) => b.toJSON()),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId/progression/:channelId
   * Get progression for a channel-bucket
   */
  router.get('/api/buckets/:bucketId/progression/:channelId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const progression = await bucketService.getProgression(req.params.channelId, req.params.bucketId);

      return res.json({
        success: true,
        data: {
          progression,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/buckets/:bucketId/progression/:channelId/reset
   * Reset progression for a channel-bucket
   */
  router.post('/api/buckets/:bucketId/progression/:channelId/reset', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await bucketService.resetProgression(req.params.channelId, req.params.bucketId);

      return res.json({
        success: true,
        message: 'Progression reset successfully',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId/stats
   * Get bucket statistics
   */
  router.get('/api/buckets/:bucketId/stats', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await bucketService.getStats(req.params.bucketId);

      return res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/buckets/:bucketId/libraries
   * Get all libraries assigned to a bucket
   */
  router.get('/api/buckets/:bucketId/libraries', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const libraries = await bucketService.getLibrariesForBucket(req.params.bucketId);

      return res.json({
        success: true,
        data: { libraries },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/buckets/:bucketId/libraries
   * Assign a library to a bucket
   */
  router.post('/api/buckets/:bucketId/libraries', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { libraryFolderId } = req.body;

      if (!libraryFolderId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'libraryFolderId is required',
          },
        });
      }

      await bucketService.assignLibraryToBucket(req.params.bucketId, libraryFolderId);

      return res.json({
        success: true,
        message: 'Library assigned to bucket',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * DELETE /api/buckets/:bucketId/libraries/:libraryFolderId
   * Remove a library from a bucket
   */
  router.delete('/api/buckets/:bucketId/libraries/:libraryFolderId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await bucketService.removeLibraryFromBucket(req.params.bucketId, req.params.libraryFolderId);

      return res.json({
        success: true,
        message: 'Library removed from bucket',
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
