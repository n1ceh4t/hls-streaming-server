import { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../../utils/errors';
import { AuthService } from '../../services/auth/AuthService';

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
 * Session authentication middleware
 * Validates session token from cookies or Authorization header
 */
export const requireSession = (authService: AuthService) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      // Get token from cookie or Authorization header
      const token = req.cookies?.sessionToken || 
        req.headers.authorization?.replace('Bearer ', '') ||
        req.query.token as string;

      if (!token) {
        throw new AuthenticationError('Session token required');
      }

      // Validate session
      const session = await authService.validateSession(token);
      if (!session) {
        throw new AuthenticationError('Invalid or expired session');
      }

      // Attach session to request
      req.session = session;

      next();
    } catch (error) {
      next(error);
    }
  };
};

