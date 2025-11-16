import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { createLogger } from '../../utils/logger';
import { config as envConfig } from '../../config/env';

const logger = createLogger('BumperGenerator');

/**
 * Base bumper configuration (backwards compatible)
 */
export interface BumperConfig {
  showName: string;
  episodeName?: string;
  duration: number; // seconds (typically 5-10 seconds)
  resolution: string;
  fps: number;
}

/**
 * Enhanced bumper configuration with optional template features
 */
export interface EnhancedBumperConfig extends BumperConfig {
  // Visual enhancements
  template?: BumperTemplate;
  backgroundImage?: string; // Path to background image (show poster, etc.)
  backgroundBlur?: number; // Blur amount (0-10, default 0)
  overlayOpacity?: number; // Dark overlay opacity (0.0-1.0, default 0.6)
  
  // Audio support
  audioFile?: string; // Path to audio file (music/jingle)
  audioVolume?: number; // Audio volume (0.0-1.0, default 0.5)
  audioFadeIn?: boolean; // Fade in audio (default true)
  audioFadeOut?: boolean; // Fade out audio (default true)
  
  // Animation
  textAnimation?: 'none' | 'fadeIn' | 'slideUp' | 'zoom';
  textAnimationDuration?: number; // Animation duration in seconds (default 0.5)
  
  // Progress indicator
  showCountdown?: boolean; // Show "Starting in Xs" countdown (default false)
  countdownPosition?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  
  // Typography
  fontFamily?: string; // Path to TTF font file
  fontSize?: number; // Font size (default 72)
  fontColor?: string; // Font color (default 'white')
  textStrokeColor?: string; // Text outline color (optional)
  textStrokeWidth?: number; // Text outline width (0-10, default 0)
}

/**
 * Bumper template configuration
 */
export interface BumperTemplate {
  id: string;
  name: string;
  background: {
    type: 'solid' | 'gradient' | 'image' | 'video';
    color?: string; // For solid: hex color, e.g., '#000000'
    gradient?: {
      from: string;
      to: string;
      direction: 'horizontal' | 'vertical' | 'diagonal';
    };
  };
  text: {
    label?: string; // "Up Next", "Coming Soon", etc.
    showNameStyle?: TextStyle;
    episodeNameStyle?: TextStyle;
  };
}

export interface TextStyle {
  fontSize?: number;
  fontColor?: string;
  position?: { x: string; y: string }; // CSS-like: 'center', '10%', '50px'
}

interface ActiveGeneration {
  process: ReturnType<typeof spawn>;
  segmentsDir: string;
  timeoutId: NodeJS.Timeout;
}

/**
 * Security utilities for path validation and sanitization
 */
class PathValidator {
  /**
   * Validate and normalize a file path to prevent command injection
   * Throws if path is invalid or potentially dangerous
   */
  static validatePath(filePath: string, allowedBaseDir?: string): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path: path must be a non-empty string');
    }

    // Normalize path (resolves .. and .)
    const normalized = path.normalize(filePath);

    // Check for dangerous patterns
    if (normalized.includes('\0') || normalized.includes('\r') || normalized.includes('\n')) {
      throw new Error('Invalid file path: contains illegal characters');
    }

    // If allowedBaseDir is provided, ensure path is within it
    if (allowedBaseDir) {
      const baseDir = path.normalize(allowedBaseDir);
      const resolved = path.resolve(normalized);
      const resolvedBase = path.resolve(baseDir);
      
      if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
        throw new Error(`Invalid file path: path must be within ${allowedBaseDir}`);
      }
    }

    // Check for absolute path (if no baseDir, allow it but log)
    if (path.isAbsolute(normalized) && !allowedBaseDir) {
      logger.debug({ path: normalized }, 'Using absolute path (no base directory restriction)');
    }

    return normalized;
  }

  /**
   * Safely escape a value for use in FFmpeg filter expressions
   * Only escapes quotes and backslashes, doesn't allow shell injection
   */
  static escapeFilterValue(value: string): string {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/,/g, '\\,');
  }

  /**
   * Validate numeric value is within safe bounds
   */
  static validateNumber(value: number | undefined, min: number, max: number, defaultValue: number): number {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    const num = Number(value);
    if (isNaN(num) || num < min || num > max) {
      logger.warn({ value, min, max, defaultValue }, 'Invalid number value, using default');
      return defaultValue;
    }
    return num;
  }
}

export class BumperGenerator {
  private readonly bumpersDir: string;
  // Track active FFmpeg processes by segmentsDir to prevent duplicates and enable cleanup
  private activeGenerations: Map<string, ActiveGeneration> = new Map();

  constructor(bumpersDir: string = path.join(envConfig.paths.temp, 'bumpers')) {
    this.bumpersDir = bumpersDir;
  }

  /**
   * Generate "Stream Starting" placeholder segments (pre-generated, reusable)
   * Returns directory path containing the segments and the number of segments generated
   */
  public async generateStreamStartingSegments(
    config: {
      segmentDuration: number;
      videoBitrate: number;
      audioBitrate: number;
      resolution: string;
      fps: number;
    }
  ): Promise<{ segmentsDir: string; segmentCount: number }> {
    const { segmentDuration, videoBitrate, audioBitrate, resolution, fps } = config;
    
    // Use a consistent name for stream starting segments (reusable across all channels with same settings)
    const segmentsDir = path.join(this.bumpersDir, 'stream_starting_segments');
    
    // Check if segments already exist (reusable)
    try {
      const files = await fs.readdir(segmentsDir);
      const segmentFiles = files.filter(f => f.endsWith('.m4s')).sort();
      if (segmentFiles.length >= 2) {
        logger.debug({ segmentsDir, segmentCount: segmentFiles.length }, 'Stream starting segments already exist, reusing');
        return { segmentsDir, segmentCount: segmentFiles.length };
      }
    } catch {
      // Directory doesn't exist, will create it
    }

    logger.info({ segmentsDir }, 'Generating Stream Starting placeholder segments');

    // Ensure segments directory exists
    await fs.mkdir(segmentsDir, { recursive: true });

    // Parse resolution
    const [width, height] = resolution.split('x').map(Number);

    return this.generateBumperSegmentsDirect(
      'Stream Starting',
      'Please wait...',
      segmentDuration, // Generate exactly 1 segment (15 seconds for 15s segments)
      segmentsDir,
      videoBitrate,
      audioBitrate,
      width,
      height,
      fps
    );
  }

  /**
   * Generate "Up Next" bumper HLS segments directly (no intermediate MP4)
   * Backwards compatible: accepts BumperConfig (original) or EnhancedBumperConfig (new)
   * Returns directory path containing the segments and the number of segments generated
   */
  public async generateUpNextBumperSegments(
    config: EnhancedBumperConfig & {
      videoBitrate: number;
      audioBitrate: number;
    }
  ): Promise<{ segmentsDir: string; segmentCount: number }> {
    const { showName, episodeName, duration, resolution, fps, videoBitrate, audioBitrate } = config;

    // Create unique bumper name based on content and config hash for caching
    const sanitizedShow = showName.replace(/[^a-z0-9]/gi, '_');
    const sanitizedEpisode = episodeName ? episodeName.replace(/[^a-z0-9]/gi, '_') : 'next';
    
    // Include enhanced features in cache key to avoid reusing wrong style
    const configHash = this.getConfigHash(config);
    const bumperName = `bumper_${sanitizedShow}_${sanitizedEpisode}_${configHash.substring(0, 8)}`;
    const segmentsDir = path.join(this.bumpersDir, `${bumperName}_segments`);
    
    // Check if segments already exist (cache)
    try {
      const files = await fs.readdir(segmentsDir);
      const segmentFiles = files.filter(f => f.endsWith('.m4s')).sort();
      if (segmentFiles.length > 0) {
        logger.debug({ segmentsDir, segmentCount: segmentFiles.length }, 'Bumper segments already exist, reusing cached version');
        return { segmentsDir, segmentCount: segmentFiles.length };
      }
    } catch {
      // Directory doesn't exist, will create it
    }

    logger.info(
      { showName, episodeName, duration, segmentsDir, hasBackground: !!config.backgroundImage, hasAudio: !!config.audioFile },
      'Generating Up Next bumper HLS segments'
    );

    // Ensure segments directory exists
    await fs.mkdir(segmentsDir, { recursive: true });

    // Parse resolution
    const [width, height] = resolution.split('x').map(Number);

    return this.generateBumperSegmentsDirect(
      showName,
      episodeName,
      duration,
      segmentsDir,
      videoBitrate,
      audioBitrate,
      width,
      height,
      fps,
      config // Pass enhanced config
    );
  }

  /**
   * Generate a single MP4 bumper file (for concat approach)
   * 
   * Overwrites the same file each time - the concat file always references the same path,
   * but we regenerate the content dynamically when each episode starts.
   * This ensures the "Up Next" bumper always shows the correct next episode.
   * 
   * @param config - Bumper configuration (showName/episodeName should be for the NEXT episode)
   * @param outputPath - Path to output MP4 file (will be overwritten with fresh content)
   * @returns Path to the generated bumper file
   */
  public async generateBumperMP4(
    config: EnhancedBumperConfig & {
      videoBitrate: number;
      audioBitrate: number;
    },
    outputPath: string
  ): Promise<string> {
    const { showName, episodeName, duration, resolution, fps, videoBitrate, audioBitrate } = config;
    
    logger.info(
      { showName, episodeName, duration, outputPath },
      'Generating bumper MP4 file for concat'
    );

    // Ensure output directory exists BEFORE starting FFmpeg
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Parse resolution
    const [width, height] = resolution.split('x').map(Number);

    // Generate the bumper as MP4 (reuse the segment generation logic but output as MP4)
    // We'll use the same filter complex but output to MP4 instead of segments
    return new Promise(async (resolve, reject) => {
      // Validate inputs
      const safeDuration = PathValidator.validateNumber(duration, 1, 60, 10);
      const safeWidth = PathValidator.validateNumber(width, 320, 7680, 1920);
      const safeHeight = PathValidator.validateNumber(height, 240, 4320, 1080);
      const safeFps = PathValidator.validateNumber(fps, 1, 120, 30);

      // Build text content
      const label = config.template?.text?.label || 'Up Next';
      const titleText = episodeName
        ? `${label}:\n${showName}\n${episodeName}`
        : `${label}:\n${showName}`;

      // Write text to temporary file (directory already created above)
      const textFilePath = path.join(outputDir, 'bumper_text.txt');
      try {
        await fs.writeFile(textFilePath, titleText, 'utf-8');
      } catch (error) {
        reject(new Error(`Failed to create text file: ${error}`));
        return;
      }
      
      // Build FFmpeg command (similar to generateBumperSegmentsDirect but output MP4)
      const args: string[] = [];
      const filterComplex: string[] = [];
      
      // Video input (solid black background)
      args.push('-f', 'lavfi', '-i', `color=c=black:s=${safeWidth}x${safeHeight}:d=${safeDuration}:r=${safeFps}`);
      // Use [0:v] directly as background (no need for null filter - just reference the stream)
      
      // Text overlay - draw text directly on [0:v] and output as [v]
      filterComplex.push(
        `[0:v]drawtext=textfile='${textFilePath}':fontsize=${safeHeight / 15}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[v]`
      );
      
      // Audio handling - add audio input BEFORE filter_complex
      let audioInputIndex = 1;
      if (config.audioFile) {
        try {
          const audioPath = PathValidator.validatePath(config.audioFile);
          await fs.access(audioPath);
          args.push('-i', audioPath);
          // Audio will be [1:a]
        } catch {
          // Audio file not found, generate silence
          args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${safeDuration}`);
          audioInputIndex = 1;
        }
      } else {
        // Generate silence for audio
        args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${safeDuration}`);
        audioInputIndex = 1;
      }
      
      // FFmpeg command
      // Map video from filter complex [v] (filter graph output) and audio from input 1:a (input stream, no brackets)
      const ffmpegArgs = [
        ...args,
        '-filter_complex', filterComplex.join(';'),
        '-map', '[v]',  // Filter graph output - use brackets
        '-map', `${audioInputIndex}:a`,  // Input stream - no brackets
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-b:v', videoBitrate.toString(),
        '-c:a', 'aac',
        '-b:a', audioBitrate.toString(),
        '-r', safeFps.toString(),
        '-t', safeDuration.toString(),
        '-y', // Overwrite output file
        outputPath
      ];
      
      // Use imported envConfig (not the function parameter 'config')
      const ffmpegPath = envConfig.ffmpeg?.path || 'ffmpeg';
      const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
      
      let stderr = '';
      let hasResolved = false;
      
      // Capture stderr for error diagnostics
      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      const timeoutId = setTimeout(() => {
        if (!hasResolved) {
          ffmpegProcess.kill('SIGKILL');
          hasResolved = true;
          const error = new Error(`Bumper MP4 generation timeout after ${(safeDuration + 30) * 1000}ms`);
          logger.error({ 
            error, 
            outputPath, 
            stderr: stderr.substring(stderr.length - 500) 
          }, 'Bumper MP4 generation timeout');
          reject(error);
        }
      }, (safeDuration + 30) * 1000);
      
      ffmpegProcess.on('close', async (code) => {
        clearTimeout(timeoutId);
        
        // Clean up text file
        try {
          await fs.unlink(textFilePath).catch(() => {});
        } catch {
          // Ignore cleanup errors
        }
        
        if (hasResolved) return;
        
        if (code === 0) {
          try {
            const stats = await fs.stat(outputPath);
            logger.info(
              { outputPath, sizeMB: (stats.size / 1024 / 1024).toFixed(2) },
              'Bumper MP4 generated successfully'
            );
            hasResolved = true;
            resolve(outputPath);
          } catch (error) {
            hasResolved = true;
            reject(new Error(`Failed to verify bumper MP4: ${error}`));
          }
        } else {
          hasResolved = true;
          const error = new Error(`FFmpeg exited with code ${code}: ${stderr.substring(stderr.length - 500)}`);
          logger.error({ 
            error, 
            outputPath, 
            exitCode: code, 
            stderr: stderr.substring(stderr.length - 500),
            ffmpegArgs: ffmpegArgs.slice(0, 10) // Log first 10 args for debugging
          }, 'Bumper MP4 generation FFmpeg error');
          reject(error);
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        clearTimeout(timeoutId);
        if (!hasResolved) {
          hasResolved = true;
          reject(new Error(`FFmpeg process error: ${error}`));
        }
      });
    });
  }

  /**
   * Generate a simple hash of config for cache key (excluding paths)
   */
  private getConfigHash(config: EnhancedBumperConfig): string {
    const hashable = {
      duration: config.duration,
      resolution: config.resolution,
      fps: config.fps,
      backgroundBlur: config.backgroundBlur || 0,
      overlayOpacity: config.overlayOpacity || 0.6,
      textAnimation: config.textAnimation || 'none',
      fontSize: config.fontSize || 72,
      fontColor: config.fontColor || 'white',
      showCountdown: config.showCountdown || false,
    };
    // Simple hash function
    return Buffer.from(JSON.stringify(hashable)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
  }

  /**
   * Generate HLS segments directly from lavfi inputs (no intermediate MP4)
   * Enhanced version with support for backgrounds, audio, animations, and countdown
   * Returns directory path containing the segments and the number of segments generated
   */
  private async generateBumperSegmentsDirect(
    showName: string,
    episodeName: string | undefined,
    duration: number,
    segmentsDir: string,
    videoBitrate: number,
    audioBitrate: number,
    width: number,
    height: number,
    fps: number,
    enhancedConfig?: EnhancedBumperConfig
  ): Promise<{ segmentsDir: string; segmentCount: number }> {
    // Check if generation is already in progress for this segmentsDir
    const existing = this.activeGenerations.get(segmentsDir);
    if (existing) {
      logger.warn(
        { segmentsDir, existingPid: existing.process.pid },
        'Bumper generation already in progress, killing previous attempt and starting new one'
      );
      
      // Kill previous attempt
      try {
        if (existing.process.pid) {
          process.kill(existing.process.pid, 'SIGTERM');
          setTimeout(() => {
            if (existing.process.pid) {
              process.kill(existing.process.pid, 'SIGKILL');
            }
          }, 2000);
        }
      } catch {
        // Process may already be dead
      }
      clearTimeout(existing.timeoutId);
      this.activeGenerations.delete(segmentsDir);
    }

    return new Promise(async (resolve, reject) => {
      // Validate and sanitize inputs
      const safeDuration = PathValidator.validateNumber(duration, 1, 60, 10);
      const safeWidth = PathValidator.validateNumber(width, 320, 7680, 1920);
      const safeHeight = PathValidator.validateNumber(height, 240, 4320, 1080);
      const safeFps = PathValidator.validateNumber(fps, 1, 120, 30);

      // Build text content
      const label = enhancedConfig?.template?.text?.label || 'Up Next';
      const titleText = episodeName
        ? `${label}:\n${showName}\n${episodeName}`
        : `${label}:\n${showName}`;

      // Write text to a temporary file to avoid escaping issues with special characters
      const textFilePath = path.join(segmentsDir, 'text.txt');
      try {
        await fs.mkdir(segmentsDir, { recursive: true });
        await fs.writeFile(textFilePath, titleText, 'utf-8');
      } catch (error) {
        reject(new Error(`Failed to create text file: ${error}`));
        return;
      }

      // Build FFmpeg command with enhanced features
      const args: string[] = [];
      const filterComplex: string[] = [];
      let hasBackgroundImage = false;
      let hasAudioFile = false;

      // ===== VIDEO INPUT =====
      let videoStreamLabel = '[0:v]'; // Track which stream is video
      if (enhancedConfig?.backgroundImage) {
        // Use background image if provided
        try {
          const bgPath = PathValidator.validatePath(enhancedConfig.backgroundImage);
          // Verify file exists
          await fs.access(bgPath);
          
          args.push('-loop', '1', '-i', bgPath);
          hasBackgroundImage = true;
          videoStreamLabel = '[0:v]';
          
          // Apply blur if requested
          const blur = PathValidator.validateNumber(enhancedConfig.backgroundBlur, 0, 10, 0);
          if (blur > 0) {
            filterComplex.push(`${videoStreamLabel}scale=iw*2:ih*2,boxblur=${blur}:${blur},scale=iw/2:ih/2[bg]`);
          } else {
            filterComplex.push(`${videoStreamLabel}scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=decrease,pad=${safeWidth}:${safeHeight}:(ow-iw)/2:(oh-ih)/2:black[bg]`);
          }
        } catch (error) {
          logger.warn({ error, path: enhancedConfig.backgroundImage }, 'Background image not found or invalid, falling back to solid color');
          // Fall back to solid color
          hasBackgroundImage = false;
          args.push('-f', 'lavfi', '-i', `color=c=black:s=${safeWidth}x${safeHeight}:d=${safeDuration}:r=${safeFps}`);
          videoStreamLabel = '[0:v]';
          filterComplex.push(`${videoStreamLabel}null[bg]`);
        }
      } else {
        // Default: solid black background
        args.push('-f', 'lavfi', '-i', `color=c=black:s=${safeWidth}x${safeHeight}:d=${safeDuration}:r=${safeFps}`);
        videoStreamLabel = '[0:v]';
        filterComplex.push(`${videoStreamLabel}null[bg]`);
      }

      // Add overlay if needed (only for background images)
      const overlayOpacity = PathValidator.validateNumber(enhancedConfig?.overlayOpacity, 0, 1, 0.6);
      let hasOverlay = false;
      if (overlayOpacity > 0 && hasBackgroundImage) {
        filterComplex.push(`color=c=black@${overlayOpacity}:s=${safeWidth}x${safeHeight}[overlay]`);
        filterComplex.push(`[bg][overlay]blend=all_mode=overlay[bgblur]`);
        hasOverlay = true;
      }

      // ===== AUDIO INPUT =====
      if (enhancedConfig?.audioFile) {
        try {
          const audioPath = PathValidator.validatePath(enhancedConfig.audioFile);
          await fs.access(audioPath);
          
          args.push('-i', audioPath);
          hasAudioFile = true;
        } catch (error) {
          logger.warn({ error, path: enhancedConfig.audioFile }, 'Audio file not found or invalid, using silence');
          // Fall back to silence
          args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${safeDuration}`);
        }
      } else {
        // Default: silence
        args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${safeDuration}`);
      }

      // ===== TEXT OVERLAY WITH ANIMATIONS =====
      const fontSize = PathValidator.validateNumber(enhancedConfig?.fontSize, 12, 200, 72);
      const fontColor = enhancedConfig?.fontColor || 'white';
      const textAnimation = enhancedConfig?.textAnimation || 'none';
      const animationDuration = PathValidator.validateNumber(enhancedConfig?.textAnimationDuration, 0.1, 2, 0.5);

      // Build drawtext filter with animation
      let drawtextFilter = `drawtext=textfile=${PathValidator.escapeFilterValue(textFilePath)}:fontcolor=${fontColor}:fontsize=${fontSize}:x=(w-text_w)/2:y=(h-text_h)/2:text_align=center`;

      // Add font file if provided
      if (enhancedConfig?.fontFamily) {
        try {
          const fontPath = PathValidator.validatePath(enhancedConfig.fontFamily);
          await fs.access(fontPath);
          drawtextFilter += `:fontfile=${PathValidator.escapeFilterValue(fontPath)}`;
        } catch (error) {
          logger.warn({ error, path: enhancedConfig.fontFamily }, 'Font file not found, using default');
        }
      }

      // Add text stroke if requested
      const strokeWidth = PathValidator.validateNumber(enhancedConfig?.textStrokeWidth, 0, 10, 0);
      if (strokeWidth > 0 && enhancedConfig?.textStrokeColor) {
        drawtextFilter += `:borderw=${strokeWidth}:bordercolor=${enhancedConfig.textStrokeColor}`;
      }

      // Add text box for readability
      drawtextFilter += `:box=1:boxcolor=black@0.5:boxborderw=10`;

      // Apply animation
      if (textAnimation === 'fadeIn' && animationDuration > 0) {
        // Fade in: alpha goes from 0 to 1 over animationDuration seconds
        drawtextFilter = drawtextFilter.replace(
          `:fontcolor=${fontColor}`,
          `:fontcolor=${fontColor}@\${min(1,t/${animationDuration})}`
        );
      } else if (textAnimation === 'slideUp' && animationDuration > 0) {
        // Slide up: y position animates from bottom
        drawtextFilter = drawtextFilter.replace(
          `:y=(h-text_h)/2`,
          `:y=\${h-((h-text_h)/2)*(1-min(1,t/${animationDuration}))}`
        );
      }
      // Note: 'zoom' animation would require scale filter, more complex

      // Add countdown timer if requested
      let countdownFilter = '';
      if (enhancedConfig?.showCountdown) {
        const position = enhancedConfig.countdownPosition || 'top-right';
        let countdownX = 'w-tw-20';
        let countdownY = '20';
        
        if (position === 'top-left') {
          countdownX = '20';
          countdownY = '20';
        } else if (position === 'bottom-right') {
          countdownX = 'w-tw-20';
          countdownY = 'h-th-20';
        } else if (position === 'bottom-left') {
          countdownX = '20';
          countdownY = 'h-th-20';
        }

        countdownFilter = `,drawtext=text='Starting in %{eif\\:${safeDuration}-t\\:d\\:2}s':fontcolor=white:fontsize=48:x=${countdownX}:y=${countdownY}`;
      }

      // Combine filters - use bgblur if we created overlay, otherwise use bg
      const bgSource = hasOverlay ? '[bgblur]' : '[bg]';
      const videoFilter = `${bgSource}${drawtextFilter}${countdownFilter},format=yuv420p[v]`;
      filterComplex.push(videoFilter);

      // ===== AUDIO PROCESSING =====
      // Audio is always at index 1 (after video input)
      const audioStreamLabel = '[1:a]';
      let audioFilter = '';
      let needsAudioFilter = false;
      
      if (hasAudioFile) {
        needsAudioFilter = true;
        const audioVolume = PathValidator.validateNumber(enhancedConfig?.audioVolume, 0, 1, 0.5);
        const fadeIn = enhancedConfig?.audioFadeIn !== false; // Default true
        const fadeOut = enhancedConfig?.audioFadeOut !== false; // Default true

        if (fadeIn && fadeOut) {
          // Fade in and out
          const fadeDuration = Math.min(0.5, safeDuration * 0.1); // 10% of duration or 0.5s max
          audioFilter = `${audioStreamLabel}volume=${audioVolume},afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${safeDuration - fadeDuration}:d=${fadeDuration}[a]`;
        } else if (fadeIn) {
          const fadeDuration = Math.min(0.5, safeDuration * 0.1);
          audioFilter = `${audioStreamLabel}volume=${audioVolume},afade=t=in:st=0:d=${fadeDuration}[a]`;
        } else if (fadeOut) {
          const fadeDuration = Math.min(0.5, safeDuration * 0.1);
          audioFilter = `${audioStreamLabel}volume=${audioVolume},afade=t=out:st=${safeDuration - fadeDuration}:d=${fadeDuration}[a]`;
        } else {
          audioFilter = `${audioStreamLabel}volume=${audioVolume}[a]`;
        }
      } else {
        // For silence (anullsrc), we don't need to process it through filter_complex
        // We'll map it directly in the command
        needsAudioFilter = false;
      }

      // Only add audio filter if we actually need to process it
      if (needsAudioFilter && audioFilter) {
        filterComplex.push(audioFilter);
      }

      // Build final FFmpeg command
      const outputSegmentPath = path.join(segmentsDir, 'bumper_000.ts');

      // Calculate GOP size to match segment duration (keyframes must align with segment boundaries)
      const gopSize = fps * duration;

      // Base FFmpeg arguments
      const baseArgs = [
        // Video codec
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        // Audio codec
        '-c:a', 'aac',
        '-b:a', audioBitrate.toString(),
        '-ar', '48000',
        '-ac', '2',
        // CRITICAL: Reset timestamps to 0 for seamless HLS playback
        '-fflags', '+genpts',
        '-avoid_negative_ts', 'make_zero',
        '-muxdelay', '0',
        '-muxpreload', '0',
        // Output as single MPEG-TS file
        '-f', 'mpegts',
        '-shortest',
        // Bitstream filters
        '-bsf:v', 'h264_mp4toannexb',
        '-bsf:a', 'aac_adtstoasc',
        // Video bitrate
        '-b:v', videoBitrate.toString(),
        '-maxrate', Math.floor(videoBitrate * 1.1).toString(),
        '-minrate', Math.floor(videoBitrate * 0.8).toString(),
        '-bufsize', '2000k',
        // Keyframes - CRITICAL: Match main stream keyframe interval for Roku compatibility
        // Roku expects consistent GOP structure
        // Main stream uses keyframes every segment duration, bumper must match
        // GOP = fps * duration (e.g., 30fps * 15s = 450 frames)
        '-force_key_frames', `expr:gte(t,n_forced*${duration})`,
        '-g', gopSize.toString(),
        '-keyint_min', gopSize.toString(),
        '-fps_mode', 'cfr',
        // Overwrite
        '-y',
        outputSegmentPath
      ];

      // Add filter_complex if we have filters
      if (filterComplex.length > 0) {
        args.push('-filter_complex', filterComplex.join(';'));
        // Map video from filter_complex
        args.push('-map', '[v]');
        // Map audio: either from filter_complex or directly from input
        if (needsAudioFilter) {
          args.push('-map', '[a]');
        } else {
          // Map audio directly from input (silence stream)
          args.push('-map', '1:a');
        }
      } else {
        // Fallback: simple drawtext without complex filters
        args.push('-vf', `drawtext=textfile=${PathValidator.escapeFilterValue(textFilePath)}:fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2:text_align=center:box=1:boxcolor=black@0.5:boxborderw=10,format=yuv420p`);
        // Map audio directly from input
        args.push('-map', '1:a');
      }

      args.push(...baseArgs);

      logger.debug({ 
        hasBackground: hasBackgroundImage, 
        hasAudio: hasAudioFile, 
        needsAudioFilter,
        animation: textAnimation,
        filterCount: filterComplex.length 
      }, 'Bumper segments FFmpeg command starting');

      const ffmpegProcess = spawn(envConfig.ffmpeg.path, args);

      let stderr = '';
      let hasResolved = false;
      
      // Track this generation
      const timeoutMs = 30000; // 30 seconds
      let timeoutId: NodeJS.Timeout;
      const activeGen: ActiveGeneration = {
        process: ffmpegProcess,
        segmentsDir,
        timeoutId: setTimeout(() => {}, 0) // Placeholder, will be set below
      };
      this.activeGenerations.set(segmentsDir, activeGen);

      // Timeout mechanism: Kill FFmpeg if it takes too long (30 seconds max)
      timeoutId = setTimeout(() => {
        if (!hasResolved && ffmpegProcess.pid) {
          logger.error(
            { 
              segmentsDir, 
              timeoutMs, 
              pid: ffmpegProcess.pid,
              stderr: stderr.substring(stderr.length - 500)
            },
            'Bumper generation timeout - killing FFmpeg process'
          );
          
          try {
            process.kill(ffmpegProcess.pid, 'SIGTERM');
            setTimeout(() => {
              try {
                if (ffmpegProcess.pid) {
                  process.kill(ffmpegProcess.pid, 'SIGKILL');
                }
              } catch {
                // Process already dead
              }
            }, 2000);
          } catch (killError) {
            logger.warn({ error: killError, pid: ffmpegProcess.pid }, 'Failed to kill stuck FFmpeg process');
          }
          
          if (!hasResolved) {
            hasResolved = true;
            const error = new Error(`Bumper generation timeout after ${timeoutMs}ms`);
            reject(error);
          }
        }
      }, timeoutMs);

      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Update timeoutId reference
      activeGen.timeoutId = timeoutId;

      ffmpegProcess.on('close', async (code) => {
        clearTimeout(timeoutId);
        this.activeGenerations.delete(segmentsDir);
        
        if (hasResolved) {
          return;
        }
        
        // Clean up text file
        try {
          await fs.unlink(textFilePath).catch(() => {});
        } catch {
          // Ignore cleanup errors
        }

        if (code === 0) {
          try {
            const outputSegmentPath = path.join(segmentsDir, 'bumper_000.ts');
            const stats = await fs.stat(outputSegmentPath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            
            const maxExpectedSize = 5 * 1024 * 1024; // 5MB
            if (stats.size > maxExpectedSize) {
              const error = new Error(`Bumper segment is abnormally large (${sizeMB}MB), possible corruption`);
              logger.error({ 
                error, 
                segmentsDir, 
                size: stats.size, 
                sizeMB,
                maxExpectedSize,
                outputPath: outputSegmentPath
              }, 'Bumper segment size validation failed');
              hasResolved = true;
              reject(error);
              return;
            }

            logger.info(
              { segmentsDir, segmentCount: 1, segmentFile: 'bumper_000.ts', sizeMB },
              'Bumper segment generation complete'
            );

            hasResolved = true;
            resolve({ segmentsDir, segmentCount: 1 });
          } catch (error) {
            logger.error({ error, segmentsDir }, 'Failed to verify bumper segment');
            hasResolved = true;
            reject(error);
          }
        } else {
          const error = new Error(`FFmpeg exited with code ${code}: ${stderr.substring(stderr.length - 500)}`);
          logger.error({ error, segmentsDir, exitCode: code, stderr: stderr.substring(stderr.length - 500) }, 'Bumper segments generation FFmpeg error');
          hasResolved = true;
          reject(error);
        }
      });

      ffmpegProcess.on('error', (err) => {
        clearTimeout(timeoutId);
        this.activeGenerations.delete(segmentsDir);
        if (!hasResolved) {
          logger.error({ error: err, segmentsDir }, 'Failed to spawn FFmpeg process for segments');
          hasResolved = true;
          reject(err);
        }
      });
    });
  }

  /**
   * Generate a single placeholder segment file (like beta version)
   * Creates a simple MPEG-TS file that can be referenced in a playlist loop
   */
  public async generateSinglePlaceholderSegment(
    outputPath: string,
    text: string,
    duration: number,
    width: number,
    height: number,
    fps: number,
    videoBitrate: number,
    audioBitrate: number
  ): Promise<void> {
    return new Promise(async (resolve, reject) => {
      logger.info({ outputPath, text, duration }, 'Generating single placeholder segment');

      // Validate output path
      try {
        const validatedPath = PathValidator.validatePath(outputPath);
        outputPath = validatedPath;
      } catch (error) {
        reject(new Error(`Invalid output path: ${error}`));
        return;
      }

      // Normalize text for drawtext (replace smart quotes, strip newlines)
      const normalized = String(text)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Use textfile approach to avoid escaping issues
      const textFilePath = outputPath + '.txt';
      try {
        await fs.writeFile(textFilePath, normalized, 'utf-8');
      } catch (error) {
        reject(new Error(`Failed to create text file: ${error}`));
        return;
      }

      const args = [
        '-f', 'lavfi',
        '-i', `color=c=black:s=${width}x${height}:r=${fps}`,
        '-t', duration.toString(),
        '-f', 'lavfi',
        '-i', `anullsrc=r=48000:cl=stereo`,
        '-t', duration.toString(),
        '-vf', `drawtext=textfile=${PathValidator.escapeFilterValue(textFilePath)}:fontsize=72:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=10,format=yuv420p`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', audioBitrate.toString(),
        '-ar', '48000',
        '-ac', '2',
        '-b:v', videoBitrate.toString(),
        '-g', '60',
        '-sc_threshold', '0',
        '-shortest',
        '-f', 'mpegts',
        '-y',
        outputPath
      ];

      const ffmpegProcess = spawn(envConfig.ffmpeg.path, args);
      let stderr = '';
      ffmpegProcess.stderr.on('data', (data) => { stderr += data.toString(); });

      ffmpegProcess.on('close', async (code) => {
        // Clean up text file
        try {
          await fs.unlink(textFilePath).catch(() => {});
        } catch {}

        if (code === 0) {
          logger.info({ outputPath }, 'Placeholder segment generated successfully');
          resolve();
        } else {
          const error = new Error(`FFmpeg exited with code ${code}: ${stderr}`);
          logger.error({ error, outputPath, stderr }, 'Placeholder segment generation failed');
          reject(error);
        }
      });

      ffmpegProcess.on('error', (err) => {
        logger.error({ error: err, outputPath }, 'Failed to spawn FFmpeg process for placeholder');
        reject(err);
      });
    });
  }

  /**
   * Kill all active bumper generation processes (for cleanup/shutdown)
   */
  public killAllActiveGenerations(): void {
    logger.info(
      { count: this.activeGenerations.size },
      'Killing all active bumper generation processes'
    );
    
    for (const [segmentsDir, activeGen] of this.activeGenerations.entries()) {
      try {
        clearTimeout(activeGen.timeoutId);
        if (activeGen.process.pid) {
          process.kill(activeGen.process.pid, 'SIGTERM');
          setTimeout(() => {
            if (activeGen.process.pid) {
              process.kill(activeGen.process.pid, 'SIGKILL');
            }
          }, 2000);
        }
        logger.debug({ segmentsDir, pid: activeGen.process.pid }, 'Killed active bumper generation process');
      } catch (error) {
        logger.warn({ error, segmentsDir }, 'Failed to kill active bumper generation process');
      }
    }
    
    this.activeGenerations.clear();
  }

  /**
   * Clean up old bumper segment directories
   * Note: Individual bumpers are cleaned up after use, this is for orphaned/stale directories
   */
  public async cleanupOldBumpers(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const files = await fs.readdir(this.bumpersDir);
      const now = Date.now();

      // Clean up segment directories (only directories, no MP4 files anymore)
      for (const file of files) {
        if (!file.endsWith('_segments')) continue;

        const segmentDirPath = path.join(this.bumpersDir, file);
        try {
          const stats = await fs.stat(segmentDirPath);
          // Check if it's a directory
          if (!stats.isDirectory()) continue;

          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            // Remove entire segment directory
            await fs.rm(segmentDirPath, { recursive: true, force: true });
            logger.debug({ file, ageHours: Math.round(age / 3600000) }, 'Cleaned up old bumper segments');
          }
        } catch {
          // Ignore errors
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Error cleaning up old bumpers');
    }
  }
}
