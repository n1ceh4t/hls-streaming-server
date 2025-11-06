import { Router, Request, Response, NextFunction } from 'express';
import { ScheduleRepository } from '../../infrastructure/database/repositories/ScheduleRepository';
import { MediaBucketRepository } from '../../infrastructure/database/repositories/MediaBucketRepository';
import { Database } from '../../infrastructure/database/Database';
import { AuthService } from '../../services/auth/AuthService';
import { ChannelService } from '../../services/channel/ChannelService';
import { authenticate } from '../middleware/auth';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { z } from 'zod';

const router = Router();

// Validation schemas
const createScheduleBlockSchema = z.object({
  channelId: z.string().uuid(),
  name: z.string().min(1).max(255),
  dayOfWeek: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  bucketId: z.string().uuid().nullable().optional(),
  playbackMode: z.enum(['sequential', 'random', 'shuffle']).optional(),
  priority: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
});

const updateScheduleBlockSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  dayOfWeek: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  bucketId: z.string().uuid().nullable().optional(),
  playbackMode: z.enum(['sequential', 'random', 'shuffle']).optional(),
  priority: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
});

const reorderBlocksSchema = z.object({
  blockIds: z.array(z.string().uuid()),
});

export const createScheduleRoutes = (authService?: AuthService, channelService?: ChannelService) => {
  const requireAuth = authenticate(authService);
  const scheduleRepository = new ScheduleRepository();
  const bucketRepository = new MediaBucketRepository();

  /**
   * GET /api/schedules/channels/:channelId/blocks
   * Get all schedule blocks for a channel
   */
  router.get('/channels/:channelId/blocks', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const blocks = await scheduleRepository.getBlocksForChannel(channelId);

      // Enrich with bucket information
      const enrichedBlocks = await Promise.all(
        blocks.map(async (block) => {
          let bucket = null;
          if (block.bucket_id) {
            bucket = await bucketRepository.findById(block.bucket_id);
          }
          return {
            id: block.id,
            channelId: block.channel_id,
            name: block.name,
            dayOfWeek: block.day_of_week,
            startTime: block.start_time,
            endTime: block.end_time,
            bucketId: block.bucket_id,
            bucket: bucket ? {
              id: bucket.getId(),
              name: bucket.getName(),
              bucketType: bucket.getBucketType(),
            } : null,
            playbackMode: block.playback_mode,
            priority: block.priority,
            enabled: block.enabled,
            createdAt: block.created_at,
            updatedAt: block.updated_at,
          };
        })
      );

      res.json({
        success: true,
        data: enrichedBlocks,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/schedules/channels/:channelId/blocks/:blockId
   * Get a specific schedule block
   */
  router.get('/channels/:channelId/blocks/:blockId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId, blockId } = req.params;
      const blocks = await scheduleRepository.getBlocksForChannel(channelId);
      const block = blocks.find(b => b.id === blockId);

      if (!block) {
        return next(new NotFoundError(`Schedule block '${blockId}' not found`));
      }

      let bucket = null;
      if (block.bucket_id) {
        bucket = await bucketRepository.findById(block.bucket_id);
      }

      res.json({
        success: true,
        data: {
          id: block.id,
          channelId: block.channel_id,
          name: block.name,
          dayOfWeek: block.day_of_week,
          startTime: block.start_time,
          endTime: block.end_time,
          bucketId: block.bucket_id,
          bucket: bucket ? {
            id: bucket.getId(),
            name: bucket.getName(),
            bucketType: bucket.getBucketType(),
          } : null,
          playbackMode: block.playback_mode,
          priority: block.priority,
          enabled: block.enabled,
          createdAt: block.created_at,
          updatedAt: block.updated_at,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/schedules/channels/:channelId/blocks
   * Create a new schedule block
   */
  router.post('/channels/:channelId/blocks', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const validated = createScheduleBlockSchema.parse({
        ...req.body,
        channelId,
      });

      // Validate time range
      const startTime = new Date(`2000-01-01T${validated.startTime}`);
      const endTime = new Date(`2000-01-01T${validated.endTime}`);
      
      if (endTime <= startTime) {
        throw new ValidationError('endTime must be after startTime');
      }

      // Validate bucket exists if provided
      if (validated.bucketId) {
        const bucket = await bucketRepository.findById(validated.bucketId);
        if (!bucket) {
          throw new NotFoundError(`Bucket '${validated.bucketId}' not found`);
        }
      }

      // Insert new block
      const result = await Database.query(
        `INSERT INTO schedule_blocks (
          channel_id, name, day_of_week, start_time, end_time,
          bucket_id, playback_mode, priority, enabled
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        ) RETURNING *`,
        [
          channelId,
          validated.name,
          validated.dayOfWeek || null,
          validated.startTime,
          validated.endTime,
          validated.bucketId || null,
          validated.playbackMode || 'sequential',
          validated.priority || 1,
          validated.enabled !== false,
        ]
      );

      const block = result.rows[0];

      // Log what was actually stored
      const { createLogger } = await import('../../utils/logger');
      const logger = createLogger('ScheduleRoutes');
      logger.info({
        channelId,
        blockId: block.id,
        blockName: block.name,
        dayOfWeek: block.day_of_week,
        startTime: block.start_time,
        endTime: block.end_time,
        bucketId: block.bucket_id,
        playbackMode: block.playback_mode,
        priority: block.priority,
        enabled: block.enabled,
      }, 'Schedule block created and stored in database');

      // Invalidate channel media cache so it re-resolves with new schedule block
      if (channelService) {
        channelService.invalidateChannelMediaCache(channelId);
        await channelService.invalidateEPGCache(channelId);
      }

      // Get bucket info if available
      let bucket = null;
      if (block.bucket_id) {
        bucket = await bucketRepository.findById(block.bucket_id);
      }

      res.status(201).json({
        success: true,
        data: {
          id: block.id,
          channelId: block.channel_id,
          name: block.name,
          dayOfWeek: block.day_of_week,
          startTime: block.start_time,
          endTime: block.end_time,
          bucketId: block.bucket_id,
          bucket: bucket ? {
            id: bucket.getId(),
            name: bucket.getName(),
            bucketType: bucket.getBucketType(),
          } : null,
          playbackMode: block.playback_mode,
          priority: block.priority,
          enabled: block.enabled,
          createdAt: block.created_at,
          updatedAt: block.updated_at,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: error.errors,
          },
        });
      }
      return next(error);
    }
  });

  /**
   * PUT /api/schedules/channels/:channelId/blocks/:blockId
   * Update a schedule block
   */
  router.put('/channels/:channelId/blocks/:blockId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId, blockId } = req.params;
      const validated = updateScheduleBlockSchema.parse(req.body);

      // Check if block exists
      const blocks = await scheduleRepository.getBlocksForChannel(channelId);
      const existingBlock = blocks.find(b => b.id === blockId);
      if (!existingBlock) {
        return next(new NotFoundError(`Schedule block '${blockId}' not found`));
      }

      // Validate time range if both times are provided
      if (validated.startTime && validated.endTime) {
        const startTime = new Date(`2000-01-01T${validated.startTime}`);
        const endTime = new Date(`2000-01-01T${validated.endTime}`);
        if (endTime <= startTime) {
          throw new ValidationError('endTime must be after startTime');
        }
      }

      // Validate bucket exists if provided
      if (validated.bucketId !== undefined && validated.bucketId !== null) {
        const bucket = await bucketRepository.findById(validated.bucketId);
        if (!bucket) {
          throw new NotFoundError(`Bucket '${validated.bucketId}' not found`);
        }
      }

      // Build update query
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (validated.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(validated.name);
      }
      if (validated.dayOfWeek !== undefined) {
        updates.push(`day_of_week = $${paramIndex++}`);
        values.push(validated.dayOfWeek);
      }
      if (validated.startTime !== undefined) {
        updates.push(`start_time = $${paramIndex++}`);
        values.push(validated.startTime);
      }
      if (validated.endTime !== undefined) {
        updates.push(`end_time = $${paramIndex++}`);
        values.push(validated.endTime);
      }
      if (validated.bucketId !== undefined) {
        updates.push(`bucket_id = $${paramIndex++}`);
        values.push(validated.bucketId);
      }
      if (validated.playbackMode !== undefined) {
        updates.push(`playback_mode = $${paramIndex++}`);
        values.push(validated.playbackMode);
      }
      if (validated.priority !== undefined) {
        updates.push(`priority = $${paramIndex++}`);
        values.push(validated.priority);
      }
      if (validated.enabled !== undefined) {
        updates.push(`enabled = $${paramIndex++}`);
        values.push(validated.enabled);
      }

      if (updates.length === 0) {
        return res.json({
          success: true,
          data: existingBlock,
        });
      }

      updates.push(`updated_at = NOW()`);
      values.push(blockId);

      const result = await Database.query(
        `UPDATE schedule_blocks 
         SET ${updates.join(', ')} 
         WHERE id = $${paramIndex} 
         RETURNING *`,
        values
      );

      const block = result.rows[0];

      // Invalidate channel media cache so it re-resolves with updated schedule block
      if (channelService) {
        channelService.invalidateChannelMediaCache(channelId);
        await channelService.invalidateEPGCache(channelId);
      }

      // Get bucket info if available
      let bucket = null;
      if (block.bucket_id) {
        bucket = await bucketRepository.findById(block.bucket_id);
      }

      res.json({
        success: true,
        data: {
          id: block.id,
          channelId: block.channel_id,
          name: block.name,
          dayOfWeek: block.day_of_week,
          startTime: block.start_time,
          endTime: block.end_time,
          bucketId: block.bucket_id,
          bucket: bucket ? {
            id: bucket.getId(),
            name: bucket.getName(),
            bucketType: bucket.getBucketType(),
          } : null,
          playbackMode: block.playback_mode,
          priority: block.priority,
          enabled: block.enabled,
          createdAt: block.created_at,
          updatedAt: block.updated_at,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: error.errors,
          },
        });
      }
      return next(error);
    }
  });

  /**
   * DELETE /api/schedules/channels/:channelId/blocks/:blockId
   * Delete a schedule block
   */
  router.delete('/channels/:channelId/blocks/:blockId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId, blockId } = req.params;

      // Check if block exists
      const blocks = await scheduleRepository.getBlocksForChannel(channelId);
      const block = blocks.find(b => b.id === blockId);
      if (!block) {
        return next(new NotFoundError(`Schedule block '${blockId}' not found`));
      }

      await Database.query('DELETE FROM schedule_blocks WHERE id = $1', [blockId]);

      // Invalidate channel media cache so it re-resolves without deleted schedule block
      if (channelService) {
        channelService.invalidateChannelMediaCache(channelId);
        await channelService.invalidateEPGCache(channelId);
      }

      res.json({
        success: true,
        message: 'Schedule block deleted',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/schedules/channels/:channelId/blocks/reorder
   * Reorder schedule blocks (update priorities)
   */
  router.post('/channels/:channelId/blocks/reorder', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channelId } = req.params;
      const validated = reorderBlocksSchema.parse(req.body);

      // Verify all blocks belong to this channel
      const blocks = await scheduleRepository.getBlocksForChannel(channelId);
      const blockIds = blocks.map(b => b.id);
      const invalidIds = validated.blockIds.filter(id => !blockIds.includes(id));
      
      if (invalidIds.length > 0) {
        throw new ValidationError(`Invalid block IDs: ${invalidIds.join(', ')}`);
      }

      // Update priorities based on order (first in array = highest priority)
      await Database.transaction(async (client) => {
        for (let i = 0; i < validated.blockIds.length; i++) {
          const priority = validated.blockIds.length - i; // Reverse: first = highest
          await client.query(
            'UPDATE schedule_blocks SET priority = $1 WHERE id = $2',
            [priority, validated.blockIds[i]]
          );
        }
      });

      // Invalidate channel media cache so it re-resolves with new block order
      if (channelService) {
        channelService.invalidateChannelMediaCache(channelId);
        await channelService.invalidateEPGCache(channelId);
      }

      res.json({
        success: true,
        message: 'Schedule blocks reordered',
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: error.errors,
          },
        });
      }
      return next(error);
    }
  });

  return router;
};

