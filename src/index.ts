import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { FFmpegEngine } from './infrastructure/ffmpeg/FFmpegEngine';
import { MetadataExtractor } from './infrastructure/ffmpeg/MetadataExtractor';
import { ChannelService } from './services/channel/ChannelService';
import { MediaScanner } from './services/media/MediaScanner';
import { EPGService } from './services/epg/EPGService';
import { StatePersistence } from './services/state/StatePersistence';
import { createChannelRoutes } from './api/routes/channels';
import { createStreamingRoutes } from './api/routes/streaming';
import { createEPGRoutes } from './api/routes/epg';
import { createBucketRoutes } from './api/routes/buckets';
import { createLibraryRoutes } from './api/routes/libraries';
import { createAuthRoutes } from './api/routes/auth';
import { createScheduleRoutes } from './api/routes/schedules';
import { MediaBucketService } from './services/bucket/MediaBucketService';
import { LibraryService } from './services/library/LibraryService';
import { AuthService } from './services/auth/AuthService';
import { PlaylistResolver } from './services/playlist/PlaylistResolver';
import { Database } from './infrastructure/database/Database';
import path from 'path';
import fs from 'fs/promises';

class Application {
  private app: express.Application;
  private server?: any;
  private ffmpegEngine!: FFmpegEngine;
  private channelService!: ChannelService;
  private mediaScanner!: MediaScanner;
  private epgService!: EPGService;
  private bucketService!: MediaBucketService;
  private libraryService!: LibraryService;
  private authService!: AuthService;
  private statePersistence!: StatePersistence;

  constructor() {
    this.app = express();
    this.setupMiddleware();
  }

  private setupMiddleware() {
    // Security
    this.app.use(helmet({
      contentSecurityPolicy: false, // Allow video streaming
    }));

    // CORS
    this.app.use(cors());

    // Compression
    this.app.use(compression());

    // Cookie parsing
    this.app.use(cookieParser());

    // Body parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: config.security.rateLimit.windowMs,
      max: config.security.rateLimit.max,
      message: {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
        },
      },
    });
    this.app.use('/api', limiter);

    // Request logging (exclude HLS streaming requests to reduce noise)
    this.app.use((req, _res, next) => {
      // Skip logging for HLS streaming requests (.m3u8 playlists and .ts segments)
      const isStreamingRequest = req.path.endsWith('.m3u8') || req.path.endsWith('.ts');
      if (!isStreamingRequest) {
        logger.info({ method: req.method, path: req.path }, 'Request received');
      }
      next();
    });
  }

  private async setupServices() {
    logger.info('Initializing services...');

    // Initialize database first (before services that depend on it)
    Database.initialize();

    // Test database connection
    const dbHealthy = await Database.healthCheck();
    if (dbHealthy) {
      logger.info('Database connection verified');
    } else {
      logger.error('Database health check failed - server will start but database features unavailable');
    }

    // Create output directories
    await fs.mkdir(config.paths.hlsOutput, { recursive: true });
    await fs.mkdir(config.paths.temp, { recursive: true });

    // Initialize services
    this.ffmpegEngine = new FFmpegEngine();
    
    // Kill any orphaned FFmpeg processes from previous runs
    const orphanedCount = this.ffmpegEngine.killOrphanedProcesses();
    if (orphanedCount > 0) {
      logger.info({ killedCount: orphanedCount }, 'Killed orphaned FFmpeg processes on startup');
    }
    
    // Initialize bucket service before channel service (channel service needs it)
    this.bucketService = new MediaBucketService();
    
    // Initialize playlist resolver (for dynamic playlist generation)
    const playlistResolver = new PlaylistResolver(this.bucketService);
    
    this.channelService = new ChannelService(this.ffmpegEngine);
    // Set bucket service reference for channel service
    this.channelService.setBucketService(this.bucketService);
    // Set playlist resolver for dynamic playlist generation
    this.channelService.setPlaylistResolver(playlistResolver);

    // Load channels from database if available
    if (dbHealthy) {
      try {
        await this.channelService.loadChannelsFromDatabase();
        logger.info('Channels loaded from database');
      } catch (error) {
        logger.error({ error }, 'Failed to load channels from database - starting with empty state');
      }
    } else {
      logger.warn('Skipping database channel load (database unavailable)');
    }
    
    const metadataExtractor = new MetadataExtractor();
    this.mediaScanner = new MediaScanner(metadataExtractor);
    this.epgService = new EPGService({
      lookaheadHours: 48,
      cacheMinutes: 5,
      bucketService: this.bucketService, // Pass bucket service for dynamic playlist EPG generation
      playlistResolver: playlistResolver, // Pass playlist resolver for consistent dynamic playlist EPG generation
      metadataExtractor: metadataExtractor, // Pass metadata extractor for fresh duration data during EPG generation
    });
    this.libraryService = new LibraryService(this.mediaScanner);
    this.authService = new AuthService();
    this.statePersistence = new StatePersistence(this.channelService, {
      autoSaveInterval: 60000, // Save every minute
      stateDir: './data',
    });

    logger.info('Services initialized');
  }

  private async setupRoutes() {
    logger.info('Setting up routes...');

    // Serve static files from public directory
    this.app.use(express.static('public'));

    // Serve admin panel
    this.app.get('/admin', (_req, res) => {
      res.sendFile(path.join(__dirname, '../../public/admin/index.html'));
    });
    this.app.get('/admin/', (_req, res) => {
      res.sendFile(path.join(__dirname, '../../public/admin/index.html'));
    });

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        success: true,
        data: {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          appName: config.server.appName,
        },
      });
    });

    // Redirect root to admin panel
    this.app.get('/', (_req, res) => {
      res.redirect('/admin/');
    });

    // Auth routes (must be before other API routes)
    this.app.use('/api/auth', createAuthRoutes(this.authService));

    // Make services available to routes via app.locals
    this.app.set('bucketService', this.bucketService);
    
    // API routes
    this.app.use('/api/channels', createChannelRoutes(this.channelService, this.authService, this.libraryService, this.bucketService));

    // Media bucket routes
    this.app.use('/', createBucketRoutes(this.bucketService, this.authService, this.channelService, this.epgService));

    // Library and media routes
    this.app.use('/', createLibraryRoutes(this.libraryService, this.authService));

    // EPG routes (public and API)
    this.app.use('/', createEPGRoutes(this.channelService, this.epgService, this.authService));

    // Schedule routes (API)
    this.app.use('/api/schedules', createScheduleRoutes(this.authService, this.channelService));

    // Streaming routes (public)
    this.app.use('/', createStreamingRoutes(this.channelService));

    // Error handlers
    this.app.use(notFoundHandler);
    this.app.use(errorHandler);

    logger.info('Routes configured');
  }

  private async restoreState(): Promise<{ restored: boolean; channelsToResume: string[] }> {
    logger.info('Attempting to restore previous state...');

    const stateExists = await this.statePersistence.exists();
    if (stateExists) {
      // Restore channels but don't auto-start yet (media files not scanned)
      const result = await this.statePersistence.restore(false);
      if (result.restored) {
        logger.info(
          { channelsToResume: result.channelsToResume.length },
          'Previous state restored successfully'
        );
        return result;
      }
    }

    logger.info('No previous state to restore');
    return { restored: false, channelsToResume: [] };
  }


  private setupGracefulShutdown() {
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);

      // Stop accepting new connections
      if (this.server) {
        this.server.close(() => {
          logger.info('HTTP server closed');
        });
      }

      // Cleanup services
      try {
        await this.statePersistence.cleanup();
        await this.channelService.cleanup();
        await Database.close();
        logger.info('Services cleaned up');
      } catch (error) {
        logger.error({ error }, 'Error during cleanup');
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.fatal({ reason, promise }, 'Unhandled rejection');
      shutdown('unhandledRejection');
    });
  }

  public async start() {
    try {
      logger.info('Starting HLS/IPTV Server v1.0...');

      // Setup services
      await this.setupServices();

      // Setup routes
      await this.setupRoutes();

      // Clean up old HLS output on server restart to start fresh
      // This ensures FFmpeg starts from segment 0 on first stream start
      logger.info('Cleaning up old HLS output...');
      const channels = this.channelService.getAllChannels();
      for (const channel of channels) {
        try {
          const outputDir = channel.config.outputDir;
          const files = await fs.readdir(outputDir);

          // Remove old .ts segments and .m3u8 playlists
          let removedCount = 0;
          for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.m3u8')) {
              await fs.unlink(path.join(outputDir, file));
              removedCount++;
            }
          }

          logger.info({ channelId: channel.id, outputDir, removedCount }, 'Cleaned up old HLS files on server restart');
        } catch (error) {
          // Directory might not exist yet - that's fine
          logger.debug({ channelId: channel.id, error }, 'No HLS files to clean up');
        }
      }

      // Restore previous state (if exists) - channels restored but not started
      const restoreResult = await this.restoreState();

      // Scan media directories
      const mediaFiles = await this.mediaScanner.scan(config.paths.media, {
        recursive: true,
      });

      logger.info({ count: mediaFiles.length }, 'Media scan complete');

      if (restoreResult.restored) {
        // Channels now get media from buckets, not direct assignment
        // Check if restored channels have buckets assigned
        const channels = this.channelService.getAllChannels();
        for (const channel of channels) {
          const channelMedia = await this.channelService.getChannelMedia(channel.id);
          if (channelMedia.length === 0) {
            logger.info(
              { channelId: channel.id },
              'Restored channel has no media. Assign buckets to the channel to provide media.'
            );
          } else {
            logger.info(
              { channelId: channel.id, mediaCount: channelMedia.length },
              'Restored channel has media from buckets'
            );
          }
        }

        // Don't auto-start streaming on server boot
        // Virtual time will continue tracking position, and streaming will resume
        // automatically when the first viewer connects (via onViewerConnect)
        logger.info(
          {
            channelsRestoredCount: restoreResult.channelsToResume.length,
            channelIds: restoreResult.channelsToResume
          },
          'Channels restored with virtual time - will start streaming when viewer connects'
        );
      } else {
        // No state restored - create default channel if media files found
        if (mediaFiles.length > 0 && this.channelService.getAllChannels().length === 0) {
          logger.info('Creating default channel...');

          const defaultChannel = await this.channelService.createChannel({
            name: 'Default Channel',
            slug: 'default',
            outputDir: path.join(config.paths.hlsOutput, 'default'),
            videoBitrate: config.streaming.videoBitrate,
            audioBitrate: config.streaming.audioBitrate,
            resolution: config.streaming.resolution,
            fps: config.streaming.fps,
            segmentDuration: config.streaming.segmentDuration,
            autoStart: false, // On-demand streaming - start when viewer connects
          });

          await this.channelService.setChannelMedia(defaultChannel.id, mediaFiles);

          logger.info(
            { channelId: defaultChannel.id },
            'Default channel created - will start streaming when viewer connects'
          );
        }
      }

      // Start auto-save
      this.statePersistence.startAutoSave();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      // Start server
      this.server = this.app.listen(config.server.port, config.server.host, () => {
        logger.info(
          {
            host: config.server.host,
            port: config.server.port,
            env: process.env.NODE_ENV,
          },
          `Server listening on http://${config.server.host}:${config.server.port}`
        );

        logger.info('✨ HLS/IPTV Server is ready!');
        logger.info('');
        logger.info('Next steps:');
        logger.info('  1. Admin Panel: http://localhost:8080/admin/');
        logger.info('  2. Access the API: http://localhost:8080/api/channels');
        logger.info('  3. Stream: http://localhost:8080/default/master.m3u8');
        logger.info('  4. Health check: http://localhost:8080/health');
      });
    } catch (error) {
      logger.fatal({ error }, 'Failed to start server');
      process.exit(1);
    }
  }
}

// Start the application
const app = new Application();
app.start();
