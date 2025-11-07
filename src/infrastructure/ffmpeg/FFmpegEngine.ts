import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';
import { config } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { FFmpegError } from '../../utils/errors';

const logger = createLogger('FFmpegEngine');

// Set FFmpeg paths
ffmpeg.setFfmpegPath(config.ffmpeg.path);
ffmpeg.setFfprobePath(config.ffmpeg.probePath);

export interface StreamConfig {
  inputFile: string; // Single file path
  outputDir: string;
  videoBitrate: number;
  audioBitrate: number;
  resolution: string;
  fps: number;
  segmentDuration: number;
  startPosition?: number; // seconds (for resuming mid-file)
}

export interface StreamHandle {
  id: string;
  process: FfmpegCommand;
  config: StreamConfig;
  startedAt: Date;
  onFileEnd?: () => void; // Callback when file finishes
  onFirstSegment?: () => void; // Callback when first segment is written (for merge operations)
}

export class FFmpegEngine {
  private activeStreams: Map<string, StreamHandle> = new Map();
  // With append_list flag: FFmpeg automatically manages segment numbering from existing playlist
  // With discont_start flag: FFmpeg automatically adds EXT-X-DISCONTINUITY tags at transitions

  /**
   * Start HLS streaming for a channel (one file at a time)
   * @param onFileEnd - Callback when the current file finishes playing (for transitioning to next file)
   */
  public async start(
    channelId: string,
    streamConfig: StreamConfig,
    onFileEnd?: () => void
  ): Promise<StreamHandle> {
    logger.info({ channelId, file: streamConfig.inputFile }, 'Starting FFmpeg stream for single file');

    try {
      // Ensure output directory exists
      await fs.mkdir(streamConfig.outputDir, { recursive: true });
      
      // Remove starting.ts before FFmpeg starts to avoid "Duplicated segment filename" error
      // starting.ts is only for initial starts (PlaylistService adds it dynamically)
      // During transitions, FFmpeg should not see starting.ts in the output directory
      const startingTsPath = path.join(streamConfig.outputDir, 'starting.ts');
      try {
        await fs.unlink(startingTsPath);
        logger.debug({ channelId }, 'Removed starting.ts before FFmpeg start (PlaylistService will add it dynamically)');
      } catch (error) {
        // starting.ts might not exist, that's OK
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.debug({ channelId, error }, 'Note: Could not remove starting.ts');
        }
      }
      
      // Check if playlist exists (determines if this is a transition or initial start)
      const playlistPath = path.join(streamConfig.outputDir, 'stream.m3u8');
      let isTransition = false;

      try {
        await fs.access(playlistPath);
        const playlistContent = await fs.readFile(playlistPath, 'utf-8');
        const hasSegments = /stream_\d+\.ts/.test(playlistContent);

        if (hasSegments) {
          isTransition = true;
          logger.debug({ channelId }, 'Detected existing playlist - this is a transition');
        }
      } catch {
        // Playlist doesn't exist yet, will be created by FFmpeg
      }

    // Verify input file exists before starting FFmpeg
    try {
      await fs.access(streamConfig.inputFile);
    } catch (error) {
      logger.error({ channelId, inputFile: streamConfig.inputFile }, 'Input file does not exist');
      throw new FFmpegError(`Input file not found: ${streamConfig.inputFile}`);
    }

    // CRITICAL: Stop any existing stream before starting new one
    // Otherwise both FFmpeg processes will write to the same playlist causing loops!
    if (this.activeStreams.has(channelId)) {
      const existingHandle = this.activeStreams.get(channelId);
      logger.warn(
        { channelId },
        'Stopping existing FFmpeg process before starting new stream (preventing dual-process conflict)'
      );
      try {
        existingHandle?.process.kill('SIGKILL'); // Force kill immediately
        this.activeStreams.delete(channelId);
      } catch (error) {
        logger.warn({ channelId, error }, 'Failed to kill existing FFmpeg process');
      }
      // Small delay to ensure process fully terminates
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Use fast preset for initial/transition starts to reduce segment generation time
    const useFastPreset = isTransition;

    // Create FFmpeg command for single file
    const command = this.createCommand(streamConfig, useFastPreset);

      // Create stream handle
      const handle: StreamHandle = {
        id: channelId,
        process: command,
        config: streamConfig,
        startedAt: new Date(),
        onFileEnd,
      };

      // Set up event handlers
      this.setupEventHandlers(channelId, command, handle);

      // Start the process
      command.run();

      // Store handle
      this.activeStreams.set(channelId, handle);

      // Wait for stream to start (check for playlist file)
      // Use 20 seconds for transitions to allow 2 segments to generate (6s each + processing)
      // For initial starts, wait 30 seconds to ensure segments are generated
      // Note: We don't throw on timeout - just log a warning and let the stream continue
      const streamStarted = await this.waitForStreamStart(streamConfig.outputDir, isTransition ? 20000 : 30000, isTransition, channelId);

      if (streamStarted) {
        logger.info({ channelId, isTransition }, 'FFmpeg stream started successfully');
      } else {
        logger.warn({ channelId, isTransition }, 'FFmpeg stream started but segments not detected yet (continuing anyway)');
      }

      return handle;
    } catch (error) {
      logger.error({ error, channelId }, 'Failed to start FFmpeg stream');
      throw new FFmpegError(`Failed to start stream: ${error}`);
    }
  }

  /**
   * Stop streaming
   */
  public async stop(channelId: string): Promise<void> {
    const handle = this.activeStreams.get(channelId);
    if (!handle) {
      logger.warn({ channelId }, 'No active stream to stop (may have already stopped/errored)');
      // Process may have already ended due to error - that's OK, just resolve immediately
      return;
    }

    logger.info({ channelId }, 'Stopping FFmpeg stream');

    return new Promise((resolve) => {
      // Set up one-time end handler
      // If process already ended, this will fire immediately
      const onEnd = () => {
        this.activeStreams.delete(channelId);
        logger.info({ channelId }, 'FFmpeg stream stopped');
        resolve();
      };

      handle.process.once('end', onEnd);

      // Send quit signal (graceful)
      // If process already ended, this is a no-op
      try {
        handle.process.kill('SIGTERM');
      } catch (error) {
        // Process might already be dead, that's OK
        logger.debug({ channelId, error }, 'Error sending SIGTERM (process may already be dead)');
      }

      // Force kill after timeout (or resolve if already ended)
      setTimeout(() => {
        if (this.activeStreams.has(channelId)) {
          logger.warn({ channelId }, 'Force killing FFmpeg process');
          try {
            handle.process.kill('SIGKILL');
          } catch (error) {
            // Process might already be dead
            logger.debug({ channelId, error }, 'Error sending SIGKILL (process may already be dead)');
          }
          this.activeStreams.delete(channelId);
          resolve();
        }
      }, 5000);
    });
  }

  /**
   * Stream a bumper segment (separate FFmpeg process)
   * Beta approach: Start fresh with segment 0, delete_segments handles cleanup
   */
  public async streamBumper(
    channelId: string,
    bumperSegmentPath: string,
    streamConfig: StreamConfig
  ): Promise<void> {
    logger.info({ channelId, bumperPath: bumperSegmentPath }, 'Starting bumper stream (stream copy mode)');

    // Ensure output directory exists
    await fs.mkdir(streamConfig.outputDir, { recursive: true });

    const outputPattern = path.join(streamConfig.outputDir, 'stream');
    const playlistPath = `${outputPattern}.m3u8`;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(bumperSegmentPath);

      // CRITICAL: Use stream copy mode - bumper is already encoded!
      // Pre-generated bumpers are already perfect HLS segments, no re-encoding needed
      command.inputOptions([
        '-fflags', '+genpts+igndts',
        '-avoid_negative_ts', 'make_zero',
        '-re', // CRITICAL: Real-time mode to maintain proper timing
      ]);

      // Stream copy - no re-encoding (bumper is already perfectly encoded)
      command.videoCodec('copy');
      command.audioCodec('copy');

      command.outputOptions([
        // HLS Output - stream copy mode (no re-encoding parameters needed)
        '-f', 'hls',
        '-hls_time', streamConfig.segmentDuration.toString(),
        '-hls_list_size', '30', // Match main streaming (30 segments)
        // Continuous streaming: append_list maintains MEDIA-SEQUENCE across file→bumper→file transitions
        // discont_start: FFmpeg automatically adds EXT-X-DISCONTINUITY tags at bumper transitions
        '-hls_flags', 'append_list+discont_start+delete_segments+program_date_time+independent_segments+omit_endlist',
        // No -start_number: FFmpeg automatically continues from last segment
        '-hls_segment_filename', `${outputPattern}_%03d.ts`,
        '-hls_segment_type', 'mpegts',
        '-bsf:v', 'h264_mp4toannexb', // Still need bitstream filter for HLS

        '-y' // Overwrite output files
      ]);

      command.output(playlistPath);

      command.on('start', async (commandLine) => {
        logger.debug({ channelId, command: commandLine }, 'Bumper FFmpeg command (stream copy mode)');
        
        // CRITICAL: Wait for bumper to start writing segments, then detect transition point
        // This avoids race condition of predicting segment numbers
        // Wait for bumper stream to start
        // FFmpeg's discont_start flag will automatically add discontinuity tags
        try {
          await this.waitForStreamStart(streamConfig.outputDir, 5000, true, channelId);
          logger.info({ channelId }, 'Bumper stream started (FFmpeg handles discontinuity tags automatically)');
        } catch (error) {
          logger.warn({ channelId, error }, 'Failed to detect bumper start (bumper may be very short)');
        }
      });

      command.on('end', () => {
        logger.info({ channelId }, 'Bumper stream finished (stream copy mode)');
        resolve();
      });

      command.on('error', (err, _stdout, stderr) => {
        logger.error({ channelId, error: err.message, stderr }, 'Bumper stream error');
        reject(new FFmpegError(`Bumper stream failed: ${err.message}`));
      });

      command.run();
    });
  }

  /**
   * Check if stream is active
   */
  public isActive(channelId: string): boolean {
    return this.activeStreams.has(channelId);
  }

  /**
   * Get active stream handle
   */
  public getHandle(channelId: string): StreamHandle | undefined {
    return this.activeStreams.get(channelId);
  }


  /**
   * Create FFmpeg command for HLS streaming (single file mode)
   * With append_list flag, FFmpeg automatically continues segment numbering from existing playlist
   */
  private createCommand(
    streamConfig: StreamConfig,
    useFastPreset: boolean = false
  ): FfmpegCommand {
    // Single file input
    const command = ffmpeg(streamConfig.inputFile);
    
    // Prepare input options
    const inputOptions: string[] = [
      '-fflags', '+genpts+igndts+flush_packets', // Critical for different codecs
      '-avoid_negative_ts', 'make_zero', // Handle timestamp issues
      '-analyzeduration', '10000000', // 10 seconds - better codec detection
      '-probesize', '10000000', // Larger probe size for better detection
    ];
    
    // Hardware acceleration (before seek position)
    if (config.ffmpeg.hwAccel !== 'none') {
      inputOptions.push('-hwaccel', config.ffmpeg.hwAccel);
    }
    
    // Apply seeking if we need to resume mid-file
    if (streamConfig.startPosition && streamConfig.startPosition > 0) {
      // Input seeking (-ss before -i) - faster but less accurate (~keyframe accuracy)
      inputOptions.unshift('-ss', streamConfig.startPosition.toString());
      logger.debug({ startPosition: streamConfig.startPosition }, 'Seeking to position in file');
    }

    // Add -re flag for real-time encoding (CRITICAL for proper timing)
    // Without -re, GPU encodes entire file in seconds, breaking bumper timing
    // With -re: 81-second file takes 81 wall-clock seconds ? bumper pre-gen works correctly
    inputOptions.push('-re');

    command.inputOptions(inputOptions);

    // Video codec (we'll set bitrate via outputOptions for consistency)
    command.videoCodec('libx264');
    command.fps(streamConfig.fps);

    // Use configurable encoder preset (from environment variable FFMPEG_PRESET)
    // Valid presets: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
    // Trade-off: faster presets = lower quality but faster encoding, slower = better quality but slower
    const encoderPreset = config.ffmpeg.preset;
    command.outputOptions(['-preset', encoderPreset]);
    logger.debug(
      { preset: encoderPreset, isTransition: useFastPreset },
      'FFmpeg encoder preset configured'
    );

    // Audio codec (we'll set bitrate and channels via outputOptions to avoid duplicates)
    command.audioCodec('aac');

    // Explicit stream mapping (map only video and audio, skip subtitles)
    // This helps avoid issues with files that have subtitle streams
    command.outputOptions(['-map', '0:v:0', '-map', '0:a?', '-sn']);

    // HLS options
    const playlistPath = path.join(streamConfig.outputDir, 'stream.m3u8');
    const segmentPattern = path.join(streamConfig.outputDir, 'stream_%03d.ts');

        // Segment pattern - always start from 0 for each new file

    // Parse resolution for video filter
    const [width, height] = streamConfig.resolution.split('x').map(Number);

    // Calculate display aspect ratio from target resolution (not hardcoded)
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(width, height);
    const darWidth = width / divisor;
    const darHeight = height / divisor;

    command
      .outputOptions([
        // Force 8-bit pixel format for hardware encoder compatibility
        '-pix_fmt', 'yuv420p',

        // Smart video filtering - ensure proper dimensions and format
        // Scale to target resolution maintaining aspect ratio, pad with black if needed
        // Using lanczos resampling algorithm for better quality when upscaling
        // flags=lanczos provides better quality than default (bicubic) for upscaling
        // DAR calculated dynamically from resolution (not hardcoded to 16:9)
        '-vf', `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,setdar=${darWidth}/${darHeight}`,
        
        // HLS Output Settings
        '-f', 'hls',
        '-hls_time', streamConfig.segmentDuration.toString(),
        // Keep 30 segments in playlist (~3 minutes at 6s/segment) to prevent premature deletion
        // CRITICAL: Players (especially Roku) may buffer/lag behind FFmpeg generation
        // Larger window prevents 410 Gone errors during transitions and normal playback
        '-hls_list_size', '30',
        // Continuous streaming flags with append_list for seamless transitions:
        // append_list: Append new segments to existing playlist (maintains MEDIA-SEQUENCE continuity)
        // delete_segments: Auto-clean old segments (sliding window) - safe with 30-segment buffer
        // independent_segments: Better player compatibility
        // program_date_time: Include timestamps for sync
        // omit_endlist: Keep stream open (no #EXT-X-ENDLIST)
        // discont_start: FFmpeg automatically adds EXT-X-DISCONTINUITY tags at file transitions (built-in!)
        '-hls_flags', 'append_list+discont_start+independent_segments+program_date_time+delete_segments+omit_endlist',
        // No -start_number: FFmpeg automatically continues from last segment in existing playlist
        '-hls_segment_filename', segmentPattern,
        '-hls_segment_type', 'mpegts',

        // Bitstream filters for codec compatibility
        // h264_mp4toannexb: Convert H.264 from MP4 format to Annex B (required for HLS)
        // Note: No audio filter needed - AAC in MPEGTS uses ADTS format naturally
        '-bsf:v', 'h264_mp4toannexb',

        // Live playlist mode for better segment handling
        '-segment_list_flags', 'live',
        // No playlist type - let PlaylistService handle this
        '-hls_allow_cache', '0', // Disable caching
        '-hls_base_url', '', // No base URL
        
        // Audio settings (set explicitly here to control format)
        // audioBitrate is in bps (e.g., 128000 = 128 kbps)
        '-b:a', streamConfig.audioBitrate.toString(),
        '-ac', '2', // Stereo
        '-ar', '48000', // High sample rate
        
        // Keyframe management for better seeking
        // GOP size = 2 seconds (fps * 2) - ensures keyframe at least every 2 seconds
        // This aligns with segment boundaries for better seeking
        '-force_key_frames', `expr:gte(t,n_forced*${streamConfig.segmentDuration})`, // Force keyframes at segment boundaries
        '-g', (streamConfig.fps * 2).toString(), // GOP size: 2 seconds worth of frames
        '-keyint_min', (streamConfig.fps * 2).toString(), // Minimum keyframe interval matches GOP
        // Frame rate mode for smooth playback
        '-fps_mode', 'cfr', // Constant frame rate for smooth playback
        
        // Video bitrate settings (VBR encoding for better quality/efficiency)
        // videoBitrate is in bps (e.g., 1500000 = 1.5 Mbps)
        '-b:v', streamConfig.videoBitrate.toString(),
        // maxrate caps peak bitrate to prevent spikes (2x average for VBR headroom)
        '-maxrate', Math.floor(streamConfig.videoBitrate * 2).toString(),
        // bufsize controls VBR variance (1-2 seconds of max bitrate)
        '-bufsize', Math.floor(streamConfig.videoBitrate * 2).toString(),
        // NO minrate = true VBR, saves bitrate on simple scenes
        
        // Muxing and buffer settings for stability
        '-movflags', '+faststart',
        '-max_muxing_queue_size', '8192', // Much larger muxing queue for stability
        '-strict', '-2',
        
        // Threading optimization (only for CPU encoding, hardware handles its own)
        ...(config.ffmpeg.hwAccel === 'none' ? ['-threads', '0', '-thread_type', 'slice'] : []),
        
        // Log level: 'warning' to capture errors but reduce noise
        // Changed from 'error' to get more diagnostic info
        '-loglevel', 'warning',
      ])
      .output(playlistPath);

    return command;
  }

  /**
   * Set up FFmpeg event handlers
   */
  private setupEventHandlers(channelId: string, command: FfmpegCommand, handle: StreamHandle): void {
    // Buffer stderr lines to capture error details
    const stderrLines: string[] = [];

    command
      .on('start', (commandLine) => {
        logger.info({ channelId, commandLine }, 'FFmpeg command started');
      })
      .on('progress', async (progress) => {
        logger.debug({ channelId, progress }, 'FFmpeg progress');
        // With append_list, no need to detect first segment for merging
        // FFmpeg automatically appends to existing playlist
      })
      .on('stderr', (line: string) => {
        // Capture all stderr lines for error debugging
        if (typeof line === 'string') {
          const l = line.trim();
          stderrLines.push(l);
          // Log important FFmpeg messages for debugging
          if (l && /Error|error|ERROR|warning|Warning|WARNING|failed|Failed|FAILED|invalid|Invalid|INVALID/i.test(l)) {
            logger.warn({ channelId, line: l }, '[ffmpeg stderr]');
          } else if (l && /Audio|aac|map|mux|segment|hls|pts|dts/i.test(l)) {
            logger.debug({ channelId, line: l }, '[ffmpeg]');
          }
        }
      })
      .on('end', async () => {
        logger.info({ channelId }, 'File stream ended');

        // With append_list, FFmpeg automatically manages segment numbering
        // No manual tracking needed - each next FFmpeg process reads the playlist and continues

        this.activeStreams.delete(channelId);

        // Notify that file finished - ChannelService will start next file/bumper
        if (handle.onFileEnd) {
          logger.info({ channelId }, 'Triggering transition to next file');
          handle.onFileEnd();
        }
      })
      .on('error', (err, stdout, stderr) => {
        // Get error details
        const errorCode = (err as any).code;
        const errorSignal = (err as any).signal;
        
        // Collect all stderr output (from both callback and buffered lines)
        const fullStderr = (stderr || '') + (stderrLines.length > 0 ? '\n' + stderrLines.join('\n') : '');
        const fullStdout = stdout || '';
        
        // SIGTERM/SIGKILL are normal terminations (we initiated them)
        // Exit code 255 is an error, not normal termination
        if (errorSignal === 'SIGTERM' || errorSignal === 'SIGKILL') {
          logger.debug({ channelId, signal: errorSignal }, 'FFmpeg terminated normally');
        } else {
          // Exit code 255 typically means FFmpeg command syntax error or file issue
          logger.error(
            {
              error: err,
              channelId,
              errorCode,
              errorSignal,
              errorMessage: err.message,
              inputFile: handle.config.inputFile,
              stdout: fullStdout || '(empty)',
              stderr: fullStderr || '(empty)',
              stderrLast50Lines: stderrLines.slice(-50).join('\n'),
            },
            'FFmpeg error'
          );
        }
        
        this.activeStreams.delete(channelId);

        // On error (not normal termination), try to transition to next file if callback exists
        // This allows recovery from codec issues, missing files, etc.
        if (errorSignal !== 'SIGTERM' && errorSignal !== 'SIGKILL' && handle.onFileEnd) {
          logger.info({ channelId, errorCode, errorSignal }, 'FFmpeg error, attempting to transition to next file');
          setTimeout(() => {
            if (handle.onFileEnd) {
              handle.onFileEnd();
            }
          }, 1000);
        }
      });
  }

  /**
   * Wait for stream to start (check for playlist file)
   * @param outputDir - Output directory for the stream
   * @param timeout - Maximum time to wait
   * @param isTransition - If true, this is a file transition (playlist already exists, reduce wait time)
   * @param channelId - Channel ID for logging (optional)
   * @returns true if stream started successfully, false if timeout
   */
  private async waitForStreamStart(outputDir: string, timeout: number, isTransition: boolean = false, channelId?: string): Promise<boolean> {
    const playlistPath = path.join(outputDir, 'stream.m3u8');
    const startTime = Date.now();

    // Get baseline last segment NUMBER before FFmpeg starts (for transitions)
    // CRITICAL: Track segment NUMBER, not count! hls_list_size=30 keeps count constant!
    let baselineLastSegment = -1;
    if (isTransition) {
      try {
        const baselineContent = await fs.readFile(playlistPath, 'utf-8');
        const segments = baselineContent.match(/stream_(\d+)\.ts/g) || [];
        if (segments.length > 0) {
          const lastSegMatch = segments[segments.length - 1].match(/stream_(\d+)\.ts/);
          if (lastSegMatch) {
            baselineLastSegment = parseInt(lastSegMatch[1], 10);
          }
        }
        logger.debug(
          { channelId: channelId || 'unknown', baselineLastSegment, segmentCount: segments.length },
          'Baseline last segment number before transition (tracking number, not count)'
        );
      } catch {
        // Playlist doesn't exist or can't be read, baseline stays -1
      }
    }

    // For transitions, check every 200ms for segment growth (matching beta version)
    // For initial starts, check every 500ms
    const checkInterval = isTransition ? 200 : 500;

    while (Date.now() - startTime < timeout) {
      try {
        await fs.access(playlistPath);

        // For transitions, verify that last segment NUMBER is increasing
        // CRITICAL: Track segment number, not count! hls_list_size=30 keeps count constant!
        if (isTransition) {
          const content = await fs.readFile(playlistPath, 'utf-8');
          const allSegments = content.match(/stream_(\d+)\.ts/g) || [];
          
          if (allSegments.length > 0) {
            // Get current last segment number
            const lastSegMatch = allSegments[allSegments.length - 1].match(/stream_(\d+)\.ts/);
            if (lastSegMatch) {
              const currentLastSegment = parseInt(lastSegMatch[1], 10);
              
              // If last segment number increased, transition occurred!
              if (currentLastSegment > baselineLastSegment) {
                // Find the first NEW segment (first one after baseline)
                // This is where we inject the discontinuity tag
                let firstNewSegmentNumber = baselineLastSegment + 1;
                
                // Verify this segment actually exists in the playlist
                const hasNewSegment = allSegments.some(seg => {
                  const match = seg.match(/stream_(\d+)\.ts/);
                  return match && parseInt(match[1], 10) === firstNewSegmentNumber;
                });
                
                if (hasNewSegment && channelId) {
                  // Transition detected - FFmpeg's discont_start flag will handle discontinuity tags automatically
                  logger.info(
                    { 
                      channelId, 
                      firstNewSegmentNumber, 
                      baselineLastSegment,
                      currentLastSegment,
                      totalSegments: allSegments.length,
                      elapsed: Date.now() - startTime
                    },
                    'Transition complete: new segment detected (tracked by number, not count)'
                  );
                  return true;
                }
              }
            }
          }

          // Wait a bit before next check
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
          continue; // Continue loop to check again
        }

        // For initial starts, verify at least 1 segment exists
        const content = await fs.readFile(playlistPath, 'utf-8');
        const totalSegmentCount = (content.match(/stream_\d+\.ts/g) || []).length;
        if (totalSegmentCount >= 1) {
          logger.info(
            {
              channelId: channelId || 'unknown',
              totalSegmentCount,
              elapsed: Date.now() - startTime
            },
            'Initial stream started: segments detected'
          );
          return true;
        }

        // Wait before checking again
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      } catch {
        // File doesn't exist yet, wait and retry
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    // Timeout reached - log warning but don't throw error
    logger.warn(
      {
        channelId: channelId || 'unknown',
        timeout,
        isTransition,
        elapsed: Date.now() - startTime
      },
      'Timeout waiting for stream segments (stream may still start)'
    );
    return false;
  }

  /**
   * Cleanup all streams on shutdown
   */
  public async cleanup(): Promise<void> {
    logger.info('Cleaning up all FFmpeg streams');
    const channelIds = Array.from(this.activeStreams.keys());
    await Promise.all(channelIds.map((id) => this.stop(id)));
  }

  /**
   * Find and kill orphaned FFmpeg processes writing to HLS output directories
   * Orphaned processes are those not tracked in activeStreams
   * 
   * @param hlsOutputDir - HLS output directory to check (defaults to config.paths.hlsOutput)
   * @returns Number of processes killed
   */
  public killOrphanedProcesses(hlsOutputDir?: string): number {
    const outputDir = hlsOutputDir || config.paths.hlsOutput;
    const outputDirAbs = path.resolve(outputDir);
    
    logger.info({ outputDir: outputDirAbs }, 'Searching for orphaned FFmpeg processes');
    
    let killedCount = 0;
    
    try {
      // Find FFmpeg processes writing to our HLS output directory
      // Note: We kill all FFmpeg processes accessing our output directory.
      // Active streams are managed via this.activeStreams and should be stopped properly,
      // but if they become orphaned (e.g., after a crash), this will clean them up.
      // Use lsof to find processes with open files in our output directory
      try {
        const lsofOutput = execSync(
          `lsof +D "${outputDirAbs}" 2>/dev/null | grep -i ffmpeg || true`,
          { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        ).trim();
        
        if (!lsofOutput) {
          logger.debug('No FFmpeg processes found accessing HLS output directory');
          return 0;
        }
        
        // Parse PIDs from lsof output (second column)
        const pids = new Set<number>();
        for (const line of lsofOutput.split('\n')) {
          const match = line.trim().split(/\s+/);
          if (match.length >= 2) {
            const pid = parseInt(match[1], 10);
            if (!isNaN(pid) && pid > 0) {
              pids.add(pid);
            }
          }
        }
        
        // Alternative: Also check ps for FFmpeg processes with our output directory in command line
        try {
          const psOutput = execSync(
            `ps aux | grep -E '[f]fmpeg.*${outputDirAbs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' || true`,
            { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
          ).trim();
          
          for (const line of psOutput.split('\n')) {
            const match = line.trim().split(/\s+/);
            if (match.length >= 2) {
              const pid = parseInt(match[1], 10);
              if (!isNaN(pid) && pid > 0) {
                pids.add(pid);
              }
            }
          }
        } catch (error) {
          logger.debug({ error }, 'Could not check ps for FFmpeg processes');
        }
        
        // Kill orphaned processes (not in activePids)
        for (const pid of pids) {
          try {
            // Verify it's actually an FFmpeg process and accessing our files
            const procInfo = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
            if (procInfo && procInfo.toLowerCase().includes('ffmpeg')) {
              logger.warn({ pid, outputDir: outputDirAbs }, 'Killing orphaned FFmpeg process');
              
              // Try graceful kill first
              try {
                process.kill(pid, 'SIGTERM');
                
                // Wait a moment, then force kill if still running
                setTimeout(() => {
                  try {
                    process.kill(pid, 0); // Check if still exists
                    logger.warn({ pid }, 'Force killing orphaned FFmpeg process (SIGTERM did not work)');
                    process.kill(pid, 'SIGKILL');
                  } catch {
                    // Process already dead, ignore
                  }
                }, 2000);
                
                killedCount++;
              } catch (error: any) {
                if (error.code !== 'ESRCH') {
                  // ESRCH means process doesn't exist, which is fine
                  logger.warn({ error, pid }, 'Error killing orphaned FFmpeg process');
                }
              }
            }
          } catch (error) {
            logger.debug({ error, pid }, 'Could not verify/kill process');
          }
        }
        
      } catch (error: any) {
        // lsof might not be available or might error
        if (error.code !== 'ENOENT') {
          logger.debug({ error }, 'Error searching for orphaned processes (lsof may not be available)');
        }
        
        // Fallback: Use pgrep to find FFmpeg processes with our output directory
        try {
          const pgrepOutput = execSync(
            `pgrep -f "ffmpeg.*${outputDirAbs}" || true`,
            { encoding: 'utf-8' }
          ).trim();
          
          if (pgrepOutput) {
            const pids = pgrepOutput.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
            
            for (const pid of pids) {
              try {
                logger.warn({ pid, outputDir: outputDirAbs }, 'Killing orphaned FFmpeg process (found via pgrep)');
                process.kill(pid, 'SIGTERM');
                
                setTimeout(() => {
                  try {
                    process.kill(pid, 0);
                    process.kill(pid, 'SIGKILL');
                  } catch {
                    // Process already dead
                  }
                }, 2000);
                
                killedCount++;
              } catch (error: any) {
                if (error.code !== 'ESRCH') {
                  logger.warn({ error, pid }, 'Error killing orphaned process');
                }
              }
            }
          }
        } catch (pgrepError) {
          logger.debug({ error: pgrepError }, 'pgrep also failed');
        }
      }
      
      if (killedCount > 0) {
        logger.info({ killedCount, outputDir: outputDirAbs }, 'Killed orphaned FFmpeg processes');
      } else {
        logger.debug({ outputDir: outputDirAbs }, 'No orphaned FFmpeg processes found');
      }
      
    } catch (error) {
      logger.error({ error, outputDir: outputDirAbs }, 'Error during orphaned process cleanup');
    }
    
    return killedCount;
  }
}
