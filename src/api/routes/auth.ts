import { Router, Request, Response, NextFunction } from 'express';
import { AuthService } from '../../services/auth/AuthService';
import { z } from 'zod';

const router = Router();

// Validation schemas
const registerSchema = z.object({
  username: z.string().min(3).max(100),
  password: z.string().min(8),
  email: z.string().email().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const createAuthRoutes = (authService: AuthService) => {
  /**
   * GET /api/auth/setup-required
   * Check if admin setup is required (no users exist)
   */
  router.get('/setup-required', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const hasUsers = await authService.hasUsers();
      res.json({
        success: true,
        data: {
          setupRequired: !hasUsers,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/auth/register
   * Register first admin user (only works if no users exist)
   */
  router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = registerSchema.parse(req.body);
      const result = await authService.register(validated);

      // Set session cookie
      res.cookie('sessionToken', result.sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        expires: result.expiresAt,
      });

      res.status(201).json({
        success: true,
        data: {
          user: result.user,
          expiresAt: result.expiresAt,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/auth/login
   * Login with username and password
   */
  router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = loginSchema.parse(req.body);
      
      const ipAddress = req.ip || req.socket.remoteAddress || undefined;
      const userAgent = req.get('user-agent') || undefined;

      const result = await authService.login(validated, {
        ipAddress,
        userAgent,
      });

      // Set session cookie
      res.cookie('sessionToken', result.sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        expires: result.expiresAt,
      });

      res.json({
        success: true,
        data: {
          user: result.user,
          expiresAt: result.expiresAt,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /api/auth/logout
   * Logout (delete session)
   */
  router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.sessionToken || 
        req.headers.authorization?.replace('Bearer ', '');

      if (token) {
        await authService.logout(token);
      }

      // Clear cookie
      res.clearCookie('sessionToken');

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * GET /api/auth/me
   * Get current user info
   */
  router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.sessionToken || 
        req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
        });
      }

      const session = await authService.validateSession(token);
      if (!session) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired session',
          },
        });
      }

      res.json({
        success: true,
        data: {
          userId: session.userId,
          username: session.username,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};

