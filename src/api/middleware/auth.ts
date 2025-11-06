import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/env';
import { AuthenticationError } from '../../utils/errors';
import { AuthService } from '../../services/auth/AuthService';
import { createLogger } from '../../utils/logger';

const logger = createLogger('AuthMiddleware');

// Extend Express Request to include session data
declare global {
  namespace Express {
    interface Request {
      session?: {
        userId: string;
        username: string;
      };
    }
  }
}

/**
 * Combined authentication middleware
 * Supports both API key (backwards compatible) and session authentication
 */
export const authenticate = (authService?: AuthService) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Skip auth if disabled
    if (!config.security.requireAuth) {
      return next();
    }

    // Try API key first (backwards compatible)
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (apiKey && apiKey === config.security.apiKey) {
      logger.debug({ method: req.method, path: req.path }, 'AuthMiddleware: API key authentication successful');
      return next();
    }

    // Try session authentication
    if (authService) {
      const token = req.cookies?.sessionToken || 
        req.headers.authorization?.replace('Bearer ', '');

      if (token) {
        const session = await authService.validateSession(token);
        if (session) {
          logger.debug({ method: req.method, path: req.path, username: session.username }, 'AuthMiddleware: Session authentication successful');
          req.session = session;
          return next();
        } else {
          logger.warn({ method: req.method, path: req.path, hasToken: true }, 'AuthMiddleware: Invalid or expired session token');
        }
      } else {
        logger.warn({ method: req.method, path: req.path, hasApiKey: !!apiKey }, 'AuthMiddleware: No authentication token provided');
      }
    }

    logger.error({ method: req.method, path: req.path, headers: { 'x-api-key': req.headers['x-api-key'] ? 'present' : 'missing', cookie: req.headers.cookie ? 'present' : 'missing' } }, 'AuthMiddleware: Authentication required but not provided');
    throw new AuthenticationError('Authentication required');
  };
};
