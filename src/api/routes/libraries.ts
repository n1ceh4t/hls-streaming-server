import { Router, Request, Response, NextFunction } from 'express';
import { LibraryService } from '../../services/library/LibraryService';
import { AuthService } from '../../services/auth/AuthService';
import { authenticate } from '../middleware/auth';
import { createLogger } from '../../utils/logger';

const logger = createLogger('LibraryRoutes');

const router = Router();

export const createLibraryRoutes = (libraryService: LibraryService, authService?: AuthService) => {
  const requireAuth = authenticate(authService);
  /**
   * GET /api/libraries
   * Get all library folders
   */
  router.get('/api/libraries', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const enabled = req.query.enabled === 'true' ? true : req.query.enabled === 'false' ? false : undefined;
      const category = req.query.category as any;

      const libraries = await libraryService.getAllLibraries({ enabled, category });

      return res.json({
        success: true,
        data: {
          libraries: libraries.map((l) => l.toJSON()),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/libraries
   * Create a new library folder
   */
  router.post('/api/libraries', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info({
        method: 'POST',
        path: '/api/libraries',
        body: req.body,
        headers: {
          'content-type': req.headers['content-type'],
          'x-api-key': req.headers['x-api-key'] ? 'present' : 'missing',
          cookie: req.headers.cookie ? 'present' : 'missing',
        },
      }, 'LibraryRoutes: POST /api/libraries - Request received');

      const { name, path, category, enabled, recursive } = req.body;

      logger.debug({ name, path, category, enabled, recursive }, 'LibraryRoutes: Extracted fields from request body');

      if (!name || !path || !category) {
        logger.warn({ name, path, category }, 'LibraryRoutes: Validation failed - missing required fields');
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Name, path, and category are required',
          },
        });
      }

      logger.info({ name, path, category, enabled, recursive }, 'LibraryRoutes: Calling libraryService.createLibrary()');
      const library = await libraryService.createLibrary({
        name,
        path,
        category,
        enabled,
        recursive,
      });

      logger.info({ id: library.getId(), name: library.getName() }, 'LibraryRoutes: Library created successfully');

      return res.status(201).json({
        success: true,
        data: {
          library: library.toJSON(),
        },
      });
    } catch (error) {
      logger.error({ error, body: req.body }, 'LibraryRoutes: Error creating library');
      return next(error);
    }
  });

  /**
   * GET /api/libraries/:libraryId
   * Get a specific library by ID
   */
  router.get('/api/libraries/:libraryId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const library = await libraryService.getLibrary(req.params.libraryId);

      return res.json({
        success: true,
        data: {
          library: library.toJSON(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * PUT /api/libraries/:libraryId
   * Update a library
   */
  router.put('/api/libraries/:libraryId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, path, category, enabled, recursive } = req.body;

      const library = await libraryService.updateLibrary(req.params.libraryId, {
        name,
        path,
        category,
        enabled,
        recursive,
      });

      return res.json({
        success: true,
        data: {
          library: library.toJSON(),
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * DELETE /api/libraries/:libraryId
   * Delete a library
   */
  router.delete('/api/libraries/:libraryId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleteMedia = req.query.deleteMedia === 'true';

      await libraryService.deleteLibrary(req.params.libraryId, deleteMedia);

      return res.json({
        success: true,
        message: 'Library deleted successfully',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/libraries/:libraryId/scan
   * Scan a specific library
   */
  router.post('/api/libraries/:libraryId/scan', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await libraryService.scanLibrary(req.params.libraryId);

      return res.json({
        success: true,
        data: result,
        message: `Scanned ${result.filesScanned} files, added ${result.filesAdded} to library`,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/libraries/scan-all
   * Scan all enabled libraries
   */
  router.post('/api/libraries/scan-all', requireAuth, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await libraryService.scanAllLibraries();

      return res.json({
        success: true,
        data: result,
        message: `Scanned ${result.librariesScanned} libraries, found ${result.totalFilesScanned} files`,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/libraries/:libraryId/media
   * Get all media files in a library
   */
  router.get('/api/libraries/:libraryId/media', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;

      const mediaFiles = await libraryService.getMediaInLibrary(req.params.libraryId, {
        limit,
        offset,
      });

      return res.json({
        success: true,
        data: {
          mediaFiles: mediaFiles.map((m) => ({
            id: m.id,
            filename: m.filename,
            path: m.path,
            duration: m.metadata.duration,
            fileSize: m.metadata.fileSize,
            showName: m.info.showName,
            season: m.info.season,
            episode: m.info.episode,
            title: m.info.title,
          })),
          count: mediaFiles.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/libraries/:libraryId/stats
   * Get library statistics
   */
  router.get('/api/libraries/:libraryId/stats', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await libraryService.getLibraryStats(req.params.libraryId);

      return res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/media
   * Search/list all media files
   */
  router.get('/api/media', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const category = _req.query.category as any;
      const libraryId = _req.query.libraryId as string | undefined;
      const search = _req.query.search as string | undefined;
      const limit = _req.query.limit ? parseInt(_req.query.limit as string) : undefined;
      const offset = _req.query.offset ? parseInt(_req.query.offset as string) : undefined;

      const mediaFiles = await libraryService.searchMedia({
        category,
        libraryId,
        search,
        limit,
        offset,
      });

      return res.json({
        success: true,
        data: {
          mediaFiles: mediaFiles.map((m) => ({
            id: m.id,
            filename: m.filename,
            path: m.path,
            duration: m.metadata.duration,
            fileSize: m.metadata.fileSize,
            showName: m.info.showName,
            season: m.info.season,
            episode: m.info.episode,
            title: m.info.title,
          })),
          count: mediaFiles.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/media/count
   * Get total count of all media files
   */
  router.get('/api/media/count', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const totalCount = await libraryService.getTotalMediaCount();

      return res.json({
        success: true,
        data: {
          totalCount,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/media/series
   * Get all series names
   */
  router.get('/api/media/series', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const series = await libraryService.getAllSeries();

      return res.json({
        success: true,
        data: {
          series,
          count: series.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/media/series/:seriesName
   * Get a series with all its seasons and episodes
   */
  router.get('/api/media/series/:seriesName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const seriesName = decodeURIComponent(req.params.seriesName);
      const mediaFiles = await libraryService.getMediaBySeries(seriesName);
      const stats = await libraryService.getSeriesStats(seriesName);

      // Group by season
      const seasons = new Map<number | null, typeof mediaFiles>();
      for (const file of mediaFiles) {
        const season = file.info.season ?? null;
        if (!seasons.has(season)) {
          seasons.set(season, []);
        }
        seasons.get(season)!.push(file);
      }

      // Convert to array format
      const seasonsArray = Array.from(seasons.entries()).map(([season, episodes]) => ({
        season,
        episodes: episodes.map((m) => ({
          id: m.id,
          filename: m.filename,
          path: m.path,
          duration: m.metadata.duration,
          fileSize: m.metadata.fileSize,
          episode: m.info.episode,
          title: m.info.title,
        })),
        episodeCount: episodes.length,
      })).sort((a, b) => {
        // Sort null seasons last
        if (a.season === null) return 1;
        if (b.season === null) return -1;
        return a.season - b.season;
      });

      return res.json({
        success: true,
        data: {
          seriesName,
          stats,
          seasons: seasonsArray,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/media/series/:seriesName/seasons/:season
   * Get episodes for a specific season
   */
  router.get('/api/media/series/:seriesName/seasons/:season', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const seriesName = decodeURIComponent(req.params.seriesName);
      const season = parseInt(req.params.season);

      if (isNaN(season)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid season number',
          },
        });
      }

      const episodes = await libraryService.getEpisodesForSeason(seriesName, season);

      return res.json({
        success: true,
        data: {
          seriesName,
          season,
          episodes: episodes.map((m) => ({
            id: m.id,
            filename: m.filename,
            path: m.path,
            duration: m.metadata.duration,
            fileSize: m.metadata.fileSize,
            episode: m.info.episode,
            title: m.info.title,
          })),
          count: episodes.length,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
