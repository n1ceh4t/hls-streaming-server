import bcrypt from 'bcryptjs';
import { AdminUserRepository } from '../../infrastructure/database/repositories/AdminUserRepository';
import { AdminSessionRepository } from '../../infrastructure/database/repositories/AdminSessionRepository';
import { createLogger } from '../../utils/logger';

const logger = createLogger('AuthService');

export interface RegisterData {
  username: string;
  password: string;
  email?: string;
}

export interface LoginData {
  username: string;
  password: string;
}

export interface AuthResult {
  user: {
    id: string;
    username: string;
    email?: string;
  };
  sessionToken: string;
  expiresAt: Date;
}

/**
 * Authentication service for admin users
 */
export class AuthService {
  private readonly userRepository: AdminUserRepository;
  private readonly sessionRepository: AdminSessionRepository;

  constructor() {
    this.userRepository = new AdminUserRepository();
    this.sessionRepository = new AdminSessionRepository();
  }

  /**
   * Check if any users exist (for first-time setup)
   */
  async hasUsers(): Promise<boolean> {
    return this.userRepository.hasUsers();
  }

  /**
   * Register a new admin user (only if no users exist)
   */
  async register(data: RegisterData): Promise<AuthResult> {
    const hasUsers = await this.userRepository.hasUsers();
    
    if (hasUsers) {
      throw new Error('Registration is only allowed when no users exist');
    }

    // Validate username
    if (!data.username || data.username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(data.username)) {
      throw new Error('Username can only contain letters, numbers, underscores, and hyphens');
    }

    // Validate password
    if (!data.password || data.password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    // Check if username already exists
    const existing = await this.userRepository.findByUsername(data.username);
    if (existing) {
      throw new Error('Username already exists');
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(data.password, saltRounds);

    // Create user
    const user = await this.userRepository.create({
      username: data.username,
      passwordHash,
      email: data.email,
    });

    logger.info({ username: user.username }, 'Admin user created');

    // Create session
    const session = await this.sessionRepository.create({
      userId: user.id,
    });

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Login with username and password
   */
  async login(
    data: LoginData,
    options?: { ipAddress?: string; userAgent?: string }
  ): Promise<AuthResult> {
    // Find user
    const user = await this.userRepository.findByUsername(data.username);
    if (!user) {
      throw new Error('Invalid username or password');
    }

    if (!user.isActive) {
      throw new Error('Account is disabled');
    }

    // Verify password - access hash from domain model
    const passwordHash = (user as any).data.passwordHash;
    const isValid = await bcrypt.compare(data.password, passwordHash);
    if (!isValid) {
      throw new Error('Invalid username or password');
    }

    // Update last login
    await this.userRepository.updateLastLogin(user.id);

    // Create session
    const session = await this.sessionRepository.create({
      userId: user.id,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
    });

    logger.info({ username: user.username }, 'Admin user logged in');

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Validate session token
   */
  async validateSession(token: string): Promise<{
    userId: string;
    username: string;
  } | null> {
    const session = await this.sessionRepository.findByToken(token);
    if (!session) {
      return null;
    }

    // Update last used
    await this.sessionRepository.updateLastUsed(token);

    // Get user
    const user = await this.userRepository.findById(session.userId);
    if (!user || !user.isActive) {
      return null;
    }

    return {
      userId: user.id,
      username: user.username,
    };
  }

  /**
   * Logout (delete session)
   */
  async logout(token: string): Promise<void> {
    await this.sessionRepository.deleteByToken(token);
    logger.info('Admin user logged out');
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    return this.sessionRepository.cleanupExpired();
  }
}

