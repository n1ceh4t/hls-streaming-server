import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/errors';
import { logError } from '../../utils/logger';
import { sanitizeErrorMessage } from '../../utils/pathSecurity';
import { config } from '../../config/env';

/**
 * Global error handling middleware
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Handle known application errors
  if (err instanceof AppError) {
    // Check if this is a streaming segment request
    const isStreamingSegment = /^\/[^\/]+\/stream_\d+\.ts$/.test(req.path);
    
    // For streaming segments, 404s are common (segment not generated yet or cleaned up)
    // Don't log them as errors to avoid noise
    if (isStreamingSegment && err.statusCode === 404) {
      // Response may already be sent, check before sending
      if (!res.headersSent) {
        res.status(404).end(); // Empty response for HLS compatibility
      }
      return;
    }

    // Log other errors normally
    logError(err, {
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body,
    });

    // Response may already be sent, check before sending
    if (!res.headersSent) {
      // Security: Sanitize error message to remove filesystem paths
      const sanitizedMessage = sanitizeErrorMessage(err.message, [
        config.paths.hlsOutput,
        config.paths.temp,
        ...config.paths.media,
      ]);

      res.status(err.statusCode).json({
        success: false,
        error: {
          code: err.code,
          message: sanitizedMessage,
          ...(err instanceof Error && 'details' in err ? { details: (err as any).details } : {}),
        },
      });
    }
    return;
  }

  // Log unknown errors
  logError(err, {
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
  });

  // Handle unknown errors
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Response may already be sent, check before sending
  if (!res.headersSent) {
    // Security: Sanitize error message to remove filesystem paths (even in development)
    const sanitizedMessage = isDevelopment
      ? sanitizeErrorMessage(err.message, [
          config.paths.hlsOutput,
          config.paths.temp,
          ...config.paths.media,
        ])
      : 'Internal server error';

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: sanitizedMessage,
        ...(isDevelopment ? { stack: err.stack } : {}),
      },
    });
  }
};

/**
 * 404 handler
 */
export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
};
