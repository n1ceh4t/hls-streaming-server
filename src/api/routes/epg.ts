import { Router, Request, Response, NextFunction } from 'express';
import { ChannelService } from '../../services/channel/ChannelService';
import { EPGService } from '../../services/epg/EPGService';
import { AuthService } from '../../services/auth/AuthService';
import { authenticate } from '../middleware/auth';
import { createLogger } from '../../utils/logger';

const logger = createLogger('EPGRoutes');

const router = Router();

export const createEPGRoutes = (channelService: ChannelService, epgService: EPGService, authService?: AuthService) => {
  const requireAuth = authenticate(authService);
  /**
   * GET /playlist.m3u
   * Get IPTV M3U playlist with all channels
   */
  router.get('/playlist.m3u', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const channels = channelService.getAllChannels();
      const baseUrl = `${_req.protocol}://${_req.get('host')}`;

      // Build M3U playlist
      const lines: string[] = ['#EXTM3U'];

      for (const channel of channels) {
        // Skip default channel (exclude from playlist)
        if (channel.config.slug === 'default' || channel.config.name === 'Default Channel') {
          continue;
        }

        const slug = channel.config.slug;
        const name = channel.config.name;
        const streamUrl = `${baseUrl}/${slug}/master.m3u8`;

        // M3U format: #EXTINF:-1 tvg-id="id" tvg-name="name" group-title="category",Display Name
        lines.push(
          `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${name}" tvg-logo="" group-title="Live TV",${name}`,
          streamUrl
        );
      }

      const m3u = lines.join('\n');

      res.setHeader('Content-Type', 'audio/x-mpegurl');
      res.setHeader('Content-Disposition', 'attachment; filename="channels.m3u"');
      res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      res.send(m3u);
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /epg.xml
   * Get XMLTV EPG for all channels
   */
  router.get('/epg.xml', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const channels = channelService.getAllChannels();

      // Build channel map with media files
      // For dynamic playlists, don't use getChannelMedia() - it queries current time
      // EPG generation will query schedule blocks directly for future times
      const channelMap = new Map();
      for (const channel of channels) {
        let mediaFiles: any[];
        if (channel.config.useDynamicPlaylist) {
          // For dynamic playlists, pass empty array - EPG generator will query schedule blocks
          mediaFiles = [];
          logger.debug({ channelId: channel.id, slug: channel.config.slug }, 'Dynamic playlist detected for EPG XML - will query schedule blocks directly');
        } else {
          // For static playlists, use getChannelMedia as before
          // But allow empty media - EPG might be cached or generatePrograms might handle it
          try {
            mediaFiles = await channelService.getChannelMedia(channel.id);
            logger.debug(
              {
                channelId: channel.id,
                slug: channel.config.slug,
                mediaFilesCount: mediaFiles.length,
              },
              'EPG XML: Got media files for static channel'
            );
            // Don't skip channels with empty media - let generatePrograms decide
            // It might have cached EPG or handle empty media gracefully
            if (mediaFiles.length === 0) {
              logger.debug(
                {
                  channelId: channel.id,
                  slug: channel.config.slug,
                },
                'EPG XML: Static channel has no media, but will try EPG generation (may have cached EPG)'
              );
            }
          } catch (error) {
            logger.error(
              {
                error,
                channelId: channel.id,
                slug: channel.config.slug,
              },
              'EPG XML: Failed to get media for static channel, skipping'
            );
            continue;
          }
        }
        // Include channel even if mediaFiles is empty (for dynamic playlists)
        channelMap.set(channel.config.slug, { channel, mediaFiles });
        logger.debug(
          {
            channelId: channel.id,
            slug: channel.config.slug,
            useDynamic: channel.config.useDynamicPlaylist,
            mediaFilesCount: mediaFiles.length,
          },
          'EPG XML: Added channel to channelMap'
        );
      }
      
      logger.debug(
        {
          totalChannels: channels.length,
          channelsInMap: channelMap.size,
          channelSlugs: Array.from(channelMap.keys()),
        },
        'EPG XML: Channel map built'
      );

      const xmltv = await epgService.generateXMLTV(channelMap);

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 minutes
      res.send(xmltv);
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/epg/channels/:slug
   * Get EPG programs for a specific channel (JSON)
   */
  router.get('/api/epg/channels/:slug', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channel = await channelService.findChannelBySlug(req.params.slug);
      if (!channel) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Channel '${req.params.slug}' not found`,
          },
        });
      }

      // For dynamic playlists, don't use getChannelMedia() - it queries current time
      // EPG generation will query schedule blocks directly for future times
      let mediaFiles: any[];
      if (channel.config.useDynamicPlaylist) {
        mediaFiles = [];
        logger.info(
          {
            channelId: channel.id,
            slug: req.params.slug,
            channelName: channel.config.name,
            useDynamicPlaylist: channel.config.useDynamicPlaylist,
          },
          'EPG API: Dynamic playlist detected for EPG JSON - will query schedule blocks directly'
        );
      } else {
        mediaFiles = await channelService.getChannelMedia(channel.id);
        logger.debug(
          {
            channelId: channel.id,
            slug: req.params.slug,
            mediaFilesCount: mediaFiles.length,
          },
          'EPG API: Static playlist - got media files'
        );
      }
      
      logger.info(
        {
          channelId: channel.id,
          slug: req.params.slug,
          mediaFilesCount: mediaFiles.length,
          useDynamicPlaylist: channel.config.useDynamicPlaylist,
        },
        'EPG API: Calling epgService.generatePrograms()'
      );
      
      const programs = await epgService.generatePrograms(channel, mediaFiles);
      
      logger.info(
        {
          channelId: channel.id,
          slug: req.params.slug,
          programCount: programs.length,
          useDynamicPlaylist: channel.config.useDynamicPlaylist,
        },
        'EPG API: generatePrograms() completed'
      );

      return res.json({
        success: true,
        data: {
          channel: {
            id: channel.id,
            name: channel.config.name,
            slug: channel.config.slug,
          },
          programs: programs.map((p) => p.toJSON()),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/epg/channels/:slug/current
   * Get current and next program for a channel
   */
  router.get('/api/epg/channels/:slug/current', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channel = await channelService.findChannelBySlug(req.params.slug);
      if (!channel) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Channel '${req.params.slug}' not found`,
          },
        });
      }

      // For dynamic playlists, don't use getChannelMedia() - it queries current time
      // EPG generation will query schedule blocks directly
      let mediaFiles: any[];
      if (channel.config.useDynamicPlaylist) {
        mediaFiles = [];
        logger.debug({ channelId: channel.id, slug: req.params.slug }, 'Dynamic playlist detected for current/next - will query schedule blocks directly');
      } else {
        mediaFiles = await channelService.getChannelMedia(channel.id);
      }
      const { current, next } = await epgService.getCurrentAndNext(channel, mediaFiles);

      return res.json({
        success: true,
        data: {
          channel: {
            id: channel.id,
            name: channel.config.name,
            slug: channel.config.slug,
          },
          current: current ? current.toJSON() : null,
          next: next ? next.toJSON() : null,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/epg/refresh
   * Clear EPG cache and force regeneration for all channels
   */
  router.post('/api/epg/refresh', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await epgService.clearCache();

      res.json({
        success: true,
        message: 'EPG cache cleared for all channels',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/epg/channels/:channelId/regenerate
   * Invalidate EPG cache and regenerate for a specific channel
   */
  router.post('/api/epg/channels/:channelId/regenerate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const channelId = req.params.channelId;
      const channel = await channelService.getChannel(channelId);

      if (!channel) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Channel '${channelId}' not found`,
          },
        });
      }

      // Invalidate cache for this channel
      await epgService.invalidateCache(channelId);

      // Immediately regenerate EPG
      // For dynamic playlists, don't use getChannelMedia() - it queries current time
      // EPG generation will query schedule blocks directly for future times
      let mediaFiles: any[];
      if (channel.config.useDynamicPlaylist) {
        // For dynamic playlists, pass empty array - EPG generator will query schedule blocks
        mediaFiles = [];
        logger.debug({ channelId }, 'Dynamic playlist detected - EPG will query schedule blocks directly');
      } else {
        // For static playlists, use getChannelMedia as before
        mediaFiles = await channelService.getChannelMedia(channelId);
      }
      const programs = await epgService.generatePrograms(channel, mediaFiles);

      return res.json({
        success: true,
        message: 'EPG cache invalidated and regenerated',
        data: {
          channel: {
            id: channel.id,
            name: channel.config.name,
            slug: channel.config.slug,
          },
          programCount: programs.length,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/epg/stats
   * Get EPG cache statistics
   */
  router.get('/api/epg/stats', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = epgService.getCacheStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
