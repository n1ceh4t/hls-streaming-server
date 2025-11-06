import path from 'path';
import { ValidationError } from './errors';
import { createLogger } from './logger';

const logger = createLogger('PathSecurity');

/**
 * Security utilities for path validation and sanitization
 */

/**
 * Check if a path contains traversal sequences
 */
export function containsPathTraversal(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return normalized.includes('..') || filePath.includes('../') || filePath.includes('..\\');
}

/**
 * Validate that a path doesn't attempt directory traversal
 */
export function validatePath(filePath: string, description: string = 'Path'): void {
  if (containsPathTraversal(filePath)) {
    throw new ValidationError(`${description} contains invalid characters (potential path traversal)`);
  }
}

/**
 * Resolve and validate that a path stays within a base directory
 */
export function validatePathWithinBase(basePath: string, targetPath: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(basePath, targetPath);

  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new ValidationError('Path traversal attempt detected');
  }

  return resolvedTarget;
}

/**
 * Sanitize a filename by removing/replacing dangerous characters
 */
export function sanitizeFilename(filename: string): string {
  // Remove path separators and null bytes
  return filename
    .replace(/[\/\\]/g, '_')
    .replace(/\0/g, '')
    .replace(/\.\./g, '__');
}

/**
 * Validate a slug (channel identifier, etc.)
 */
export function validateSlug(slug: string): void {
  // Only allow alphanumeric, hyphens, and underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new ValidationError('Slug contains invalid characters');
  }
}

/**
 * Sanitize error messages to remove filesystem paths
 */
export function sanitizeErrorMessage(message: string, basePaths: string[] = []): string {
  let sanitized = message;

  // Remove common base paths
  for (const basePath of basePaths) {
    const regex = new RegExp(basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    sanitized = sanitized.replace(regex, '[REDACTED_PATH]');
  }

  // Remove absolute paths (Unix and Windows)
  sanitized = sanitized.replace(/\/[^\s]+/g, '[PATH]');
  sanitized = sanitized.replace(/[A-Z]:\\[^\s]+/g, '[PATH]');

  return sanitized;
}

/**
 * Get relative path for API responses (never expose full system paths)
 */
export function getPublicPath(fullPath: string, basePath: string): string {
  const resolvedFull = path.resolve(fullPath);
  const resolvedBase = path.resolve(basePath);

  if (resolvedFull.startsWith(resolvedBase)) {
    return path.relative(resolvedBase, resolvedFull);
  }

  // If not within base, return just the filename
  return path.basename(fullPath);
}

/**
 * Validate that a library path is within allowed directories
 */
export function validateLibraryPath(libraryPath: string, allowedBasePaths?: string[]): void {
  logger.debug({ libraryPath, allowedBasePaths: allowedBasePaths || 'not configured' }, 'PathSecurity.validateLibraryPath: Starting validation');
  
  // Check for path traversal
  try {
    validatePath(libraryPath, 'Library path');
    logger.debug({ libraryPath }, 'PathSecurity.validateLibraryPath: Path traversal check passed');
  } catch (error) {
    logger.warn({ libraryPath, error }, 'PathSecurity.validateLibraryPath: Path traversal detected');
    throw error;
  }

  // If allowed base paths are configured, ensure library is within one of them
  if (allowedBasePaths && allowedBasePaths.length > 0) {
    const resolvedLibrary = path.resolve(libraryPath);
    logger.debug({ resolvedLibrary, allowedBasePaths }, 'PathSecurity.validateLibraryPath: Checking against allowed base paths');
    
    const isWithinAllowed = allowedBasePaths.some((basePath) => {
      const resolvedBase = path.resolve(basePath);
      const matches = resolvedLibrary.startsWith(resolvedBase);
      logger.debug({ libraryPath: resolvedLibrary, basePath: resolvedBase, matches }, 'PathSecurity.validateLibraryPath: Checking base path');
      return matches;
    });

    if (!isWithinAllowed) {
      logger.error({ libraryPath: resolvedLibrary, allowedBasePaths }, 'PathSecurity.validateLibraryPath: Library path is not within allowed directories');
      throw new ValidationError('Library path is not within allowed directories');
    }
    
    logger.debug({ libraryPath: resolvedLibrary }, 'PathSecurity.validateLibraryPath: Path is within allowed directories');
  } else {
    logger.debug({ libraryPath }, 'PathSecurity.validateLibraryPath: No allowed base paths configured, skipping restriction check');
  }
}
