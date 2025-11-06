import pino from 'pino';
import { mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../config/env';

// Build streams for multi-stream logging
const streams: Array<{ stream: NodeJS.WritableStream | ReturnType<typeof pino.destination>; level?: string }> = [];

// Always add console output
if (config.logging.format === 'pretty') {
  // Pretty console output - use pino-pretty transport
  // We'll handle file separately
} else {
  // JSON to stdout
  streams.push({
    stream: process.stdout,
    level: config.logging.level,
  });
}

// Add file logging if configured
let fileDestination: ReturnType<typeof pino.destination> | null = null;
if (config.logging.file) {
  // Ensure log directory exists
  const logDir = path.dirname(config.logging.file);
  mkdir(logDir, { recursive: true }).catch((err) => {
    console.error(`Failed to create log directory: ${err}`);
  });

  // Use pino's file destination
  fileDestination = pino.destination({
    dest: config.logging.file,
    sync: false,
  });

  streams.push({
    stream: fileDestination,
    level: config.logging.level,
  });
}

// Create logger instance
// If pretty format and no file, use transport for pretty output
// Otherwise use multistream or direct stream
let loggerInstance: pino.Logger;

if (config.logging.format === 'pretty' && streams.length === 0) {
  // Pretty console only (no file)
  loggerInstance = pino(
    {
      level: config.logging.level,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    }
  );
} else if (config.logging.format === 'pretty' && streams.length > 0) {
  // Pretty console + file (or file only)
  // Create pretty stream for console
  const prettyStream = pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  });

  // Combine streams: pretty console + file(s)
  const combinedStreams = [
    { stream: prettyStream, level: config.logging.level },
    ...streams,
  ];

  loggerInstance = pino(
    {
      level: config.logging.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    pino.multistream(combinedStreams)
  );
} else if (streams.length > 1) {
  // Multiple streams (file + console or multiple files)
  loggerInstance = pino(
    {
      level: config.logging.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    pino.multistream(streams)
  );
} else if (streams.length === 1) {
  // Single stream
  loggerInstance = pino(
    {
      level: config.logging.level,
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
      serializers: {
        err: pino.stdSerializers.err,
        error: pino.stdSerializers.err,
      },
    },
    streams[0].stream
  );
} else {
  // Fallback (shouldn't happen, but TypeScript needs it)
  loggerInstance = pino({
    level: config.logging.level,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  });
}

export const logger = loggerInstance;

// Create child logger with context
export const createLogger = (context: string) => {
  return logger.child({ context });
};

// Helper for structured error logging
export const logError = (error: Error, context?: Record<string, unknown>) => {
  logger.error(
    {
      err: error,
      ...context,
    },
    error.message
  );
};

// Helper for performance logging
export const logPerformance = (operation: string, startTime: number, metadata?: object) => {
  const duration = Date.now() - startTime;
  logger.info(
    {
      operation,
      duration,
      ...metadata,
    },
    `${operation} completed in ${duration}ms`
  );
};
