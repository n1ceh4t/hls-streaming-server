import { Router, Request, Response, NextFunction } from 'express';
import { ChannelService } from '../../services/channel/ChannelService';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { validateSlug, validatePathWithinBase } from '../../utils/pathSecurity';

const router = Router();

// Track active viewer sessions per channel
// Key: channelId, Value: Map of sessionId -> timeout handle
const viewerSessions = new Map<string, Map<string, NodeJS.Timeout>>();

// Get session ID from request
function getSessionId(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const ua = req.get('user-agent') || 'unknown';
  // Simple hash of IP + UA for session tracking
  return `${ip}-${ua.substring(0, 50)}`;
}

// Update or create viewer session with timeout
function updateViewerSession(
  channelId: string,
  sessionId: string,
  channelService: ChannelService
): void {
  let sessions = viewerSessions.get(channelId);
  if (!sessions) {
    sessions = new Map();
    viewerSessions.set(channelId, sessions);
  }

  // Clear existing timeout for this session
  const existingTimeout = sessions.get(sessionId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set new timeout - session expires after 60 seconds of inactivity
  const timeout = setTimeout(() => {
    const currentSessions = viewerSessions.get(channelId);
    if (currentSessions) {
      currentSessions.delete(sessionId);
      // If no more active sessions, disconnect viewer
      if (currentSessions.size === 0) {
        viewerSessions.delete(channelId);
        channelService.onViewerDisconnect(channelId).catch(() => {
          // Silently handle errors
        });
      }
    }
  }, 60000); // 60 second timeout

  sessions.set(sessionId, timeout);
}

export const createStreamingRoutes = (channelService: ChannelService) => {
  // Use the same PlaylistService instance as ChannelService to share transition tracking
  // This ensures transition points recorded in ChannelService are visible when serving playlists
  const playlistService = channelService.playlistService;
  /**
   * GET /:slug/master.m3u8
   * Master playlist
   */
  router.get('/:slug/master.m3u8', async (req: Request, res: Response, next: NextFunction) => {
    // Security: Validate slug format (alphanumeric only)
    validateSlug(req.params.slug);

    const channel = await channelService.findChannelBySlug(req.params.slug);
    if (!channel) {
      return next(new NotFoundError(`Channel '${req.params.slug}'`));
    }

    // Track viewer session (don't disconnect immediately - HLS uses short-lived requests)
    const sessionId = getSessionId(req);
    const sessions = viewerSessions.get(channel.id);
    const wasFirstViewer = !sessions || sessions.size === 0;

    // Update session with timeout (resets timeout on each request)
    updateViewerSession(channel.id, sessionId, channelService);

    // Only call onViewerConnect if this is the first viewer (triggers stream resume)
    if (wasFirstViewer) {
      await channelService.onViewerConnect(channel.id);
    }

    const masterPlaylist = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=${channel.config.videoBitrate + channel.config.audioBitrate},RESOLUTION=${channel.config.resolution}
stream.m3u8
`;

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(masterPlaylist);
  });

  /**
   * GET /:slug/stream.m3u8
   * Stream playlist
   *
   * Simplified for the new pipeline:
   * - Just serves FFmpeg's playlist directly
   * - No bumper merging (bumpers stream as separate FFmpeg processes)
   * - PlaylistService handles missing/empty playlist gracefully
   */
  router.get('/:slug/stream.m3u8', async (req: Request, res: Response, next: NextFunction) => {
    // Security: Validate slug format (alphanumeric only)
    validateSlug(req.params.slug);

    const channel = await channelService.findChannelBySlug(req.params.slug);
    if (!channel) {
      return next(new NotFoundError(`Channel '${req.params.slug}'`));
    }

    // Track viewer session (playlist requests indicate active viewing)
    const sessionId = getSessionId(req);
    const sessions = viewerSessions.get(channel.id);
    const wasFirstViewer = !sessions || sessions.size === 0;

    // Update session with timeout (resets timeout on each request)
    updateViewerSession(channel.id, sessionId, channelService);

    // Only call onViewerConnect if this is the first viewer (triggers stream resume)
    if (wasFirstViewer) {
      await channelService.onViewerConnect(channel.id);
    }

    const playlistPath = path.join(channel.config.outputDir, 'stream.m3u8');

    // Simply serve FFmpeg's playlist (or minimal fallback if not ready)
    // Pass channelId for transition tracking
    const playlist = await playlistService.getPlaylist(playlistPath, channel.id);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(playlist);
  });

  /**
   * GET /:slug/:segment
   * Stream segment
   */
  router.get('/:slug/:segment', async (req: Request, res: Response, next: NextFunction) => {
    // Security: Validate slug format (alphanumeric only)
    validateSlug(req.params.slug);

    const channel = await channelService.findChannelBySlug(req.params.slug);
    if (!channel) {
      return next(new NotFoundError(`Channel '${req.params.slug}'`));
    }

    // Track viewer session (segment requests indicate active viewing)
    // Segment requests are the most reliable indicator of active viewers
    const sessionId = getSessionId(req);
    const sessions = viewerSessions.get(channel.id);
    const wasFirstViewer = !sessions || sessions.size === 0;

    // Update session with timeout (resets timeout on each segment request)
    updateViewerSession(channel.id, sessionId, channelService);

    // Only call onViewerConnect if this is the first viewer (triggers stream resume)
    if (wasFirstViewer) {
      await channelService.onViewerConnect(channel.id);
    }

    const segment = req.params.segment;

    // Security: Validate segment name (no path traversal)
    if (segment.includes('..') || segment.includes('/') || segment.includes('\\')) {
      throw new ValidationError('Invalid segment name');
    }

    // Validate segment filename - allow both stream_XXX.ts and starting.ts (placeholder)
    if (!/^(stream_\d+\.ts|starting\.ts)$/.test(segment)) {
      return next(new NotFoundError('Segment'));
    }

    // Security: Ensure resolved path stays within output directory
    const segmentPath = validatePathWithinBase(channel.config.outputDir, segment);

    try {
      const stats = await fs.stat(segmentPath);

      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'max-age=3600');

      const stream = createReadStream(segmentPath);

      // Handle stream errors
      stream.on('error', (error: NodeJS.ErrnoException) => {
        // Don't send error if response already sent
        if (!res.headersSent) {
          // If file not found, return 404 silently (common in HLS)
          if (error.code === 'ENOENT') {
            res.status(404).end(); // Empty response for HLS compatibility
            return;
          }
          return next(error);
        }
        // Silently handle errors after headers sent (client may have disconnected)
      });

      // Handle client disconnect
      req.on('close', () => {
        // Destroy the stream if client disconnects
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      // Handle response errors
      res.on('error', (error) => {
        // Clean up stream if response errors
        if (!stream.destroyed) {
          stream.destroy();
        }
        // Don't call next() if response already started
        if (!res.headersSent) {
          next(error);
        }
      });

      // Pipe stream to response
      stream.pipe(res);
    } catch (error) {
      // For file system errors (like ENOENT), return 404 without logging as error
      // This is common in HLS when segments haven't been generated yet or were cleaned up
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'ENOENT') {
        return res.status(404).end(); // Empty response for HLS compatibility
      }
      // For other errors, pass to error handler
      return next(error);
    }
  });

  return router;
};
