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
  inputFile?: string; // Single file path (legacy, for backwards compatibility)
  concatFile?: string; // Concat file path (new approach)
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
  // All files are re-encoded to identical parameters, so discontinuity tags may not be needed

  /**
   * Start HLS streaming for a channel
   * Uses concat demuxer for seamless transitions between files
   * @param onFileEnd - Callback when stream ends (legacy, not used with concat)
   */
  public async start(
    channelId: string,
    streamConfig: StreamConfig,
    onFileEnd?: () => void
  ): Promise<StreamHandle> {
    if (streamConfig.concatFile) {
      logger.info({ channelId, concatFile: streamConfig.concatFile }, 'Starting FFmpeg stream with concat file');
    } else if (streamConfig.inputFile) {
      logger.info({ channelId, file: streamConfig.inputFile }, 'Starting FFmpeg stream for single file (legacy mode)');
    } else {
      throw new FFmpegError('Either inputFile or concatFile must be provided');
    }

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

    // Verify input file exists before starting FFmpeg (only for legacy single-file mode)
    if (streamConfig.inputFile) {
      try {
        await fs.access(streamConfig.inputFile);
      } catch (error) {
        logger.error({ channelId, inputFile: streamConfig.inputFile }, 'Input file does not exist');
        throw new FFmpegError(`Input file not found: ${streamConfig.inputFile}`);
      }
    }

    // Verify concat file exists and is valid before starting FFmpeg (for concat mode)
    if (streamConfig.concatFile) {
      try {
        await fs.access(streamConfig.concatFile);
        const content = await fs.readFile(streamConfig.concatFile, 'utf-8');
        if (!content.trim()) {
          throw new FFmpegError('Concat file is empty');
        }
        logger.debug(
          { channelId, concatFile: streamConfig.concatFile, lines: content.split('\n').length },
          'Validated concat file'
        );
      } catch (error) {
        if (error instanceof FFmpegError) {
          throw error;
        }
        logger.error(
          { channelId, concatFile: streamConfig.concatFile, error },
          'Concat file validation failed'
        );
        throw new FFmpegError(`Concat file not found or invalid: ${streamConfig.concatFile}`);
      }
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
      // Use 35 seconds for transitions to allow 2 segments to generate (15s each + processing)
      // For initial starts, wait 45 seconds to ensure segments are generated
      // Note: We don't throw on timeout - just log a warning and let the stream continue
      const streamStarted = await this.waitForStreamStart(streamConfig.outputDir, isTransition ? 35000 : 45000, isTransition, channelId);

      if (streamStarted) {
        logger.info({ channelId, isTransition }, 'FFmpeg stream started successfully');
      } else {
        // Check if handle is still in activeStreams (indicates process is still active)
        const isStillActive = this.activeStreams.has(channelId);
        if (!isStillActive) {
          logger.error({ channelId, isTransition }, 'FFmpeg process is not active - stream may have failed to start');
        } else {
          logger.warn({ channelId, isTransition }, 'FFmpeg stream started but segments not detected yet (continuing anyway - process is active)');
        }
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

    // CRITICAL: Ensure previous stream is stopped before starting bumper
    // The previous file's FFmpeg must be fully stopped so bumper can append to playlist
    if (this.activeStreams.has(channelId)) {
      logger.warn({ channelId }, 'Previous stream still active, stopping before bumper');
      await this.stop(channelId);
      // Give it a moment to fully stop and release file handles
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    
    // Also ensure no orphaned FFmpeg processes are writing to the playlist
    // This prevents file lock conflicts when bumper tries to append
    const playlistCheckPath = path.join(streamConfig.outputDir, 'stream.m3u8');
    try {
      // Try to access the playlist file to ensure it's not locked
      await fs.access(playlistCheckPath);
    } catch {
      // Playlist doesn't exist yet, that's OK - bumper will create it
    }

    // Ensure output directory exists
    await fs.mkdir(streamConfig.outputDir, { recursive: true });

    const outputPattern = path.join(streamConfig.outputDir, 'stream');
    const playlistPath = `${outputPattern}.m3u8`;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(bumperSegmentPath);

      // CRITICAL: Must RE-ENCODE bumpers to reset PTS/DTS timestamps!
      // Stream copy preserves original timestamps which break continuity in live streams
      // Roku is VERY strict about timestamp continuity
      command.inputOptions([
        '-fflags', '+genpts+igndts',
        '-avoid_negative_ts', 'make_zero',
        '-re', // Real-time mode
      ]);

      // Re-encode to reset timestamps (not stream copy!)
      command.videoCodec('libx264');
      command.audioCodec('aac');
      // Map streams - audio is optional (use ? to handle files without audio)
      command.outputOptions(['-map', '0:v:0', '-map', '0:a?', '-sn']);
      // Don't use command.fps() - let -fps_mode cfr handle frame rate

      // Parse resolution
      const [width, height] = streamConfig.resolution.split('x').map(Number);
      const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
      const divisor = gcd(width, height);
      const darWidth = width / divisor;
      const darHeight = height / divisor;

      command.outputOptions([
        '-preset', 'ultrafast', // Fast encoding for bumpers
        '-pix_fmt', 'yuv420p',
        '-vf', `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,setdar=${darWidth}/${darHeight}`,
        '-f', 'hls',
        '-hls_time', streamConfig.segmentDuration.toString(),
        '-hls_list_size', '30',
        // Calculate delete threshold to keep ~10 minutes of segments total (same as main stream)
        '-hls_delete_threshold', Math.max(1, Math.ceil((600 / streamConfig.segmentDuration) - 30)).toString(),
        // split_by_time: Only cut segments at proper time boundaries (prevents partial segments during transitions)
        // temp_file: Write segments atomically (prevents partial/corrupted segments if process is killed)
        // NOTE: removed 'independent_segments' - incompatible with split_by_time in newer FFmpeg versions
        '-hls_flags', 'append_list+delete_segments+program_date_time+omit_endlist+split_by_time+temp_file',
        '-hls_segment_filename', `${outputPattern}_%03d.ts`,
        '-hls_segment_type', 'mpegts',
        '-bsf:v', 'h264_mp4toannexb',
        // CRITICAL: Mark as LIVE stream to match main stream mode
        '-segment_list_flags', 'live',
        '-hls_allow_cache', '0',
        '-hls_base_url', '',
        // Audio (only if audio stream exists - the ? in -map 0:a? makes it optional)
        '-b:a', streamConfig.audioBitrate.toString(),
        '-ac', '2',
        '-ar', '48000',
        // Note: If input has no audio, -b:a will be ignored (that's OK)
        // Video - CRITICAL: Match main stream exactly!
        '-b:v', streamConfig.videoBitrate.toString(),
        '-maxrate', Math.floor(streamConfig.videoBitrate * 2).toString(),
        '-bufsize', Math.floor(streamConfig.videoBitrate * 2).toString(),
        // Keyframes - CRITICAL: Must align with segment boundaries!
        // GOP = fps * segmentDuration ensures keyframes ONLY at segment boundaries
        '-force_key_frames', `expr:gte(t,n_forced*${streamConfig.segmentDuration})`,
        '-g', (streamConfig.fps * streamConfig.segmentDuration).toString(),
        '-keyint_min', (streamConfig.fps * streamConfig.segmentDuration).toString(),
        '-fps_mode', 'cfr',
        // Explicitly set output frame rate (required when using -fps_mode cfr)
        '-r', streamConfig.fps.toString(),
        '-y'
      ]);

      command.output(playlistPath);

      command.on('start', async (commandLine) => {
        logger.debug({ channelId, command: commandLine }, 'Bumper FFmpeg command (stream copy mode)');
        
        // CRITICAL: Wait for bumper to start writing segments, then detect transition point
        // This avoids race condition of predicting segment numbers
        // Wait for bumper stream to start
        // For 15-second bumpers (1 segment), use shorter timeout and don't fail if timeout
        try {
          await this.waitForStreamStart(streamConfig.outputDir, 3000, true, channelId);
          logger.info({ channelId }, 'Bumper stream started');
        } catch (error) {
          // For very short bumpers (15 seconds = 1 segment), timeout is expected
          // The bumper will still stream correctly, we just couldn't detect the first segment in time
          logger.debug({ channelId, error }, 'Bumper start detection timeout (expected for 15s bumpers, continuing anyway)');
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
   * Create FFmpeg command for HLS streaming
   * Uses concat demuxer for seamless transitions, or single file input (legacy)
   */
  private createCommand(
    streamConfig: StreamConfig,
    useFastPreset: boolean = false
  ): FfmpegCommand {
    // Use concat file if provided, otherwise fall back to single file input (legacy)
    let command: FfmpegCommand;
    
    if (streamConfig.concatFile) {
      // Concat demuxer approach - seamless transitions
      command = ffmpeg();
      command.input(streamConfig.concatFile);
      command.inputOptions([
        '-stream_loop', '-1', // Loop concat playlist infinitely for 24/7 streaming
        '-f', 'concat',
        '-safe', '0', // Allow absolute paths
        // Note: inpoint in concat file seeks to nearest keyframe - not frame-accurate
        // For more accurate seeking, consider using -ss on individual files before concat
      ]);
    } else if (streamConfig.inputFile) {
      // Legacy single file input
      command = ffmpeg(streamConfig.inputFile);
    } else {
      throw new FFmpegError('Either inputFile or concatFile must be provided');
    }
    
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
    // CRITICAL: Don't use command.fps() when using -fps_mode cfr
    // command.fps() sets -r which can conflict with -fps_mode cfr
    // Instead, let -fps_mode cfr handle frame rate conversion
    // command.fps(streamConfig.fps); // REMOVED: Conflicts with -fps_mode cfr

    // Use configurable encoder preset (from environment variable FFMPEG_PRESET)
    // For transitions, use ultrafast to reduce encoding delay
    // Valid presets: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
    // Trade-off: faster presets = lower quality but faster encoding, slower = better quality but slower
    const encoderPreset = useFastPreset ? 'ultrafast' : config.ffmpeg.preset;
    command.outputOptions(['-preset', encoderPreset]);
    logger.debug(
      { preset: encoderPreset, isTransition: useFastPreset, originalPreset: config.ffmpeg.preset },
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
        // Keep 30 segments in playlist (~7.5 minutes at 15s/segment) to prevent premature deletion
        // CRITICAL: Players (especially Roku) may buffer/lag behind FFmpeg generation
        // Larger window prevents 410 Gone errors during transitions and normal playback
        '-hls_list_size', '30',
        // Calculate delete threshold to keep ~10 minutes of segments total
        // Total segments for 10 minutes = 600 seconds / segmentDuration
        // Threshold = total segments - playlist size (keeps unreferenced segments on disk)
        // This gives players more time to request older segments before they're deleted
        '-hls_delete_threshold', Math.max(1, Math.ceil((600 / streamConfig.segmentDuration) - 30)).toString(),
        // HLS flags for continuous streaming:
        // program_date_time: Include timestamps for sync
        // delete_segments: Auto-clean old segments (sliding window) - safe with 30-segment buffer + threshold
        // omit_endlist: Keep stream open (no #EXT-X-ENDLIST)
        // split_by_time: Only cut segments at proper time boundaries (prevents partial segments)
        // temp_file: Write segments atomically (prevents partial/corrupted segments if process is killed)
        // NOTE: No append_list needed - concat handles seamless transitions automatically
        '-hls_flags', 'program_date_time+delete_segments+omit_endlist+split_by_time+temp_file',
        // Start from segment 0 (concat creates a fresh stream)
        '-hls_start_number_source', 'generic',
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
        
        // Keyframe management - CRITICAL: GOP must match segment duration for Roku
        // GOP = fps * segmentDuration ensures keyframes align with discontinuity tags
        '-force_key_frames', `expr:gte(t,n_forced*${streamConfig.segmentDuration})`, // Force keyframes at segment boundaries
        '-g', (streamConfig.fps * streamConfig.segmentDuration).toString(), // GOP size: 15 seconds worth of frames (450 at 30fps)
        '-keyint_min', (streamConfig.fps * streamConfig.segmentDuration).toString(), // Minimum keyframe interval matches GOP
        // Frame rate mode for smooth playback
        '-fps_mode', 'cfr', // Constant frame rate for smooth playback
        // Explicitly set output frame rate (required when using -fps_mode cfr)
        '-r', streamConfig.fps.toString(),
        
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

        // Notify that file finished - ChannelService will start next file/bumper
        // CRITICAL: Call onFileEnd() BEFORE deleting activeStream
        // Otherwise isStreaming() returns false and transition is skipped
        if (handle.onFileEnd) {
          logger.info({ channelId }, 'Triggering transition to next file');
          handle.onFileEnd();
        }

        // Clean up after transition handler has run
        this.activeStreams.delete(channelId);
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
    // CRITICAL: Get baseline AFTER a small delay to ensure previous FFmpeg has fully released the playlist file
    let baselineLastSegment = -1;
    if (isTransition) {
      // Small delay to ensure file system is consistent after previous FFmpeg process ended
      await new Promise((resolve) => setTimeout(resolve, 300));
      
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
        logger.warn({ channelId: channelId || 'unknown' }, 'Could not read baseline playlist for transition detection');
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
              if (baselineLastSegment >= 0 && currentLastSegment > baselineLastSegment) {
                // Find the first NEW segment (first one after baseline)
                // This is where we inject the discontinuity tag
                let firstNewSegmentNumber = baselineLastSegment + 1;
                
                // Verify this segment actually exists in the playlist
                const hasNewSegment = allSegments.some(seg => {
                  const match = seg.match(/stream_(\d+)\.ts/);
                  return match && parseInt(match[1], 10) === firstNewSegmentNumber;
                });
                
                if (hasNewSegment && channelId) {
                  // Transition detected - discontinuity tags will be injected manually in PlaylistService
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
              } else if (baselineLastSegment < 0) {
                // Baseline wasn't captured, but we have segments - assume transition succeeded
                // This can happen if playlist was read before baseline was set
                logger.info(
                  { 
                    channelId: channelId || 'unknown',
                    currentLastSegment,
                    totalSegments: allSegments.length,
                    elapsed: Date.now() - startTime,
                    note: 'Baseline not captured, but segments exist - assuming transition succeeded'
                  },
                  'Transition detected (fallback: segments exist without baseline)'
                );
                return true;
              }
            }
          } else if (baselineLastSegment >= 0) {
            // Playlist exists but has no segments - this is unusual for a transition
            // Wait a bit longer for segments to appear
            logger.debug(
              { channelId: channelId || 'unknown', baselineLastSegment, elapsed: Date.now() - startTime },
              'Transition: playlist exists but no segments yet, waiting...'
            );
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

    // Timeout reached - check if process is still active
    const isStillActive = channelId && this.activeStreams.has(channelId);
    logger.warn(
      {
        channelId: channelId || 'unknown',
        timeout,
        isTransition,
        elapsed: Date.now() - startTime,
        isStillActive,
        baselineLastSegment
      },
      isStillActive 
        ? 'Timeout waiting for stream segments (process is active, segments may appear soon)'
        : 'Timeout waiting for stream segments (process may have failed)'
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
