import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// Load environment variables
dotenv.config();

// Environment validation schema
const envSchema = z.object({
  // Server
  APP_NAME: z.string().default('HLS Streaming Server'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  WEBSOCKET_PORT: z.coerce.number().min(1).max(65535).default(8081),

  // Media
  MEDIA_DIRECTORIES: z
    .string()
    .transform((val) => val.split(',').map((dir) => dir.trim()))
    .default('/media'),
  HLS_OUTPUT_DIR: z.string().default('./hls_output'),
  TEMP_DIR: z.string().default('./temp'),

  // Streaming
  DEFAULT_VIDEO_BITRATE: z.coerce.number().positive().default(1500000),
  DEFAULT_AUDIO_BITRATE: z.coerce.number().positive().default(128000),
  DEFAULT_RESOLUTION: z.string().default('1920x1080'),
  DEFAULT_FPS: z.coerce.number().min(1).max(120).default(30),
  DEFAULT_SEGMENT_DURATION: z.coerce.number().min(1).max(30).default(15),
  MAX_CONCURRENT_STREAMS: z.coerce.number().min(1).max(100).default(8),

  // Security
  API_KEY: z.string().min(8).default('change-this-to-a-secure-random-string'),
  REQUIRE_AUTH: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  RATE_LIMIT_MAX: z.coerce.number().positive().default(1000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().positive().default(900000),
  ALLOWED_LIBRARY_PATHS: z
    .string()
    .transform((val) => val.split(',').map((dir) => dir.trim()))
    .optional(),
  EXPOSE_FULL_PATHS: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),

  // Features
  ENABLE_EPG: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  ENABLE_ANALYTICS: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  ENABLE_AUTO_SCAN: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  AUTO_SCAN_INTERVAL: z.coerce.number().min(1).default(60),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  LOG_FILE: z.string().optional(), // Optional log file path

  // FFmpeg
  FFMPEG_PATH: z.string().default('/usr/bin/ffmpeg'),
  FFPROBE_PATH: z.string().default('/usr/bin/ffprobe'),
  HW_ACCEL: z.enum(['nvenc', 'qsv', 'videotoolbox', 'none']).default('none'),
  FFMPEG_PRESET: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
    .default('fast'), // Changed from 'veryfast' to 'fast' for better quality (less blocky video)

  // Advanced
  SEGMENT_CLEANUP_INTERVAL: z.coerce.number().positive().default(30),
  SEGMENT_MAX_AGE: z.coerce.number().positive().default(300),
  SESSION_TIMEOUT: z.coerce.number().positive().default(300),

  // Viewer Session & Pause/Resume Configuration
  VIEWER_SESSION_TIMEOUT: z.coerce.number().positive().default(60), // Seconds before session expires
  VIEWER_DISCONNECT_GRACE_PERIOD: z.coerce.number().positive().default(45), // Seconds before pausing stream
  ENABLE_RESUME_SEEKING: z
    .string()
    .transform((val) => val === 'true')
    .default('true'), // Seek to exact position on resume
  RESUME_SEEK_THRESHOLD: z.coerce.number().min(0).default(10), // Min seconds to bother seeking

  // HLS Playlist Configuration
  HLS_PLAYLIST_WINDOW_SIZE: z.coerce.number().min(3).max(50).default(10), // Number of segments in playlist
  HLS_DISCONTINUITY_TRACKING: z
    .string()
    .transform((val) => val === 'true')
    .default('true'), // Track discontinuity sequence
  HLS_INSERT_DISCONTINUITY_TAGS: z
    .string()
    .transform((val) => val === 'true')
    .default('true'), // Auto-insert at transitions

  // Transition & Buffering Configuration
  TRANSITION_BUFFER_SEGMENTS: z.coerce.number().min(1).max(10).default(2), // Segments to wait during transitions
  TRANSITION_BUFFER_TIMEOUT: z.coerce.number().positive().default(15), // Max seconds to wait for buffer

  // Database
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
  DB_NAME: z.string().default('hls_streaming'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_MIN: z.coerce.number().min(1).default(2),
  DB_POOL_MAX: z.coerce.number().min(1).default(10),
  DB_SSL: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
});

// Validate and export
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;

// Derived configuration
export const config = {
  // Server
  server: {
    appName: env.APP_NAME,
    port: env.PORT,
    host: env.HOST,
    websocketPort: env.WEBSOCKET_PORT,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },

  // Paths (resolve to absolute paths)
  paths: {
    media: env.MEDIA_DIRECTORIES.map((dir) => path.resolve(dir)),
    hlsOutput: path.resolve(env.HLS_OUTPUT_DIR),
    temp: path.resolve(env.TEMP_DIR),
    root: path.resolve(__dirname, '../..'),
  },

  // Streaming defaults
  streaming: {
    videoBitrate: env.DEFAULT_VIDEO_BITRATE,
    audioBitrate: env.DEFAULT_AUDIO_BITRATE,
    resolution: env.DEFAULT_RESOLUTION,
    fps: env.DEFAULT_FPS,
    segmentDuration: env.DEFAULT_SEGMENT_DURATION,
    maxConcurrentStreams: env.MAX_CONCURRENT_STREAMS,
  },

  // Security
  security: {
    apiKey: env.API_KEY,
    requireAuth: env.REQUIRE_AUTH,
    rateLimit: {
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
    },
    allowedLibraryPaths: env.ALLOWED_LIBRARY_PATHS,
    exposeFullPaths: env.EXPOSE_FULL_PATHS,
  },

  // Features
  features: {
    epg: env.ENABLE_EPG,
    analytics: env.ENABLE_ANALYTICS,
    autoScan: env.ENABLE_AUTO_SCAN,
    autoScanInterval: env.AUTO_SCAN_INTERVAL,
  },

  // Logging
  logging: {
    level: env.LOG_LEVEL,
    format: env.LOG_FORMAT,
    file: env.LOG_FILE,
  },

  // FFmpeg
  ffmpeg: {
    path: env.FFMPEG_PATH,
    probePath: env.FFPROBE_PATH,
    hwAccel: env.HW_ACCEL,
    preset: env.FFMPEG_PRESET,
  },

  // Cleanup
  cleanup: {
    interval: env.SEGMENT_CLEANUP_INTERVAL,
    maxAge: env.SEGMENT_MAX_AGE,
  },

  // Sessions
  session: {
    timeout: env.SESSION_TIMEOUT,
  },

  // Viewer Session Management
  viewer: {
    sessionTimeout: env.VIEWER_SESSION_TIMEOUT,
    disconnectGracePeriod: env.VIEWER_DISCONNECT_GRACE_PERIOD,
    enableResumeSeeking: env.ENABLE_RESUME_SEEKING,
    resumeSeekThreshold: env.RESUME_SEEK_THRESHOLD,
  },

  // HLS Playlist Management
  hls: {
    playlistWindowSize: env.HLS_PLAYLIST_WINDOW_SIZE,
    discontinuityTracking: env.HLS_DISCONTINUITY_TRACKING,
    insertDiscontinuityTags: env.HLS_INSERT_DISCONTINUITY_TAGS,
  },

  // Transition & Buffering
  transition: {
    bufferSegments: env.TRANSITION_BUFFER_SEGMENTS,
    bufferTimeout: env.TRANSITION_BUFFER_TIMEOUT,
  },

  // Database
  database: {
    url: env.DATABASE_URL,
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    pool: {
      min: env.DB_POOL_MIN,
      max: env.DB_POOL_MAX,
    },
    ssl: env.DB_SSL,
  },
} as const;

// Export for testing
export type Config = typeof config;
