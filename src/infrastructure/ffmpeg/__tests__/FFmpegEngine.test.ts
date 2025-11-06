import { FFmpegEngine, StreamConfig } from '../FFmpegEngine';
import * as fs from 'fs/promises';
import path from 'path';

// Mock dependencies
jest.mock('fluent-ffmpeg');
jest.mock('fs/promises');
jest.mock('../../../utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock('../../../config/env', () => ({
  config: {
    ffmpeg: {
      path: '/usr/bin/ffmpeg',
      probePath: '/usr/bin/ffprobe',
      hwAccel: 'none',
    },
    logging: {
      level: 'error',
      format: 'json',
    },
  },
}));

describe('FFmpegEngine', () => {
  let ffmpegEngine: FFmpegEngine;
  let mockFfmpeg: any;
  let mockCommand: any;

  const createStreamConfig = (): StreamConfig => ({
    inputFile: '/path/to/video.mp4',
    outputDir: './test_output',
    videoBitrate: 1500000,
    audioBitrate: 128000,
    resolution: '1920x1080',
    fps: 30,
    segmentDuration: 6,
  });

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Mock fs operations - use jest.spyOn instead
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
    jest.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    
    // Mock waitForStreamStart by creating playlist file immediately
    jest.spyOn(fs, 'access').mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('stream.m3u8')) {
        return Promise.resolve(undefined); // File exists
      }
      return Promise.reject(new Error('Not found'));
    });
    
    // Mock fluent-ffmpeg
    mockCommand = {
      inputOptions: jest.fn().mockReturnThis(),
      videoCodec: jest.fn().mockReturnThis(),
      videoBitrate: jest.fn().mockReturnThis(),
      fps: jest.fn().mockReturnThis(),
      audioCodec: jest.fn().mockReturnThis(),
      audioBitrate: jest.fn().mockReturnThis(),
      audioChannels: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      output: jest.fn().mockReturnThis(),
      on: jest.fn().mockReturnThis(),
      run: jest.fn(),
      kill: jest.fn(),
    };

    mockFfmpeg = jest.fn().mockReturnValue(mockCommand);
    
    const ffmpegModule = require('fluent-ffmpeg');
    ffmpegModule.setFfmpegPath = jest.fn();
    ffmpegModule.setFfprobePath = jest.fn();
    ffmpegModule.mockImplementation(mockFfmpeg);
    
    ffmpegEngine = new FFmpegEngine();
  });

  describe('Stream Start', () => {
    it('should create output directory', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(fs.mkdir).toHaveBeenCalledWith(config.outputDir, { recursive: true });
    });

    it('should create playlist file if it does not exist', async () => {
      const config = createStreamConfig();
      jest.spyOn(fs, 'access').mockRejectedValueOnce(new Error('File not found'));
      
      await ffmpegEngine.start('channel-1', config);
      
      const playlistPath = path.join(config.outputDir, 'stream.m3u8');
      expect(fs.writeFile).toHaveBeenCalledWith(
        playlistPath,
        expect.stringContaining('#EXTM3U'),
        'utf-8'
      );
    });

    it('should use existing playlist if it exists', async () => {
      const config = createStreamConfig();
      jest.spyOn(fs, 'access').mockResolvedValue(undefined);
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should create FFmpeg command with correct input file', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockFfmpeg).toHaveBeenCalledWith(config.inputFile);
    });

    it('should add input options including -re flag', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.inputOptions).toHaveBeenCalled();
      const inputOptions = (mockCommand.inputOptions as jest.Mock).mock.calls[0][0];
      expect(inputOptions).toContain('-re');
      expect(inputOptions).toContain('-fflags');
      expect(inputOptions).toContain('+genpts+igndts+flush_packets');
    });

    it('should add seek position if provided', async () => {
      const config = { ...createStreamConfig(), startPosition: 10 };
      
      await ffmpegEngine.start('channel-1', config);
      
      const inputOptions = (mockCommand.inputOptions as jest.Mock).mock.calls[0][0];
      expect(inputOptions).toContain('-ss');
      expect(inputOptions).toContain('10');
    });

    it('should configure video codec and settings', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.videoCodec).toHaveBeenCalledWith('libx264');
      expect(mockCommand.videoBitrate).toHaveBeenCalledWith(config.videoBitrate);
      expect(mockCommand.fps).toHaveBeenCalledWith(config.fps);
    });

    it('should configure audio codec and settings', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.audioCodec).toHaveBeenCalledWith('aac');
      expect(mockCommand.audioBitrate).toHaveBeenCalledWith(config.audioBitrate);
      expect(mockCommand.audioChannels).toHaveBeenCalledWith(2);
    });

    it('should add stream mapping options', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.outputOptions).toHaveBeenCalledWith(
        expect.arrayContaining(['-map', '0:v:0', '-map', '0:a?', '-sn'])
      );
    });

    it('should configure HLS output options', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      // outputOptions is called with an array of strings
      const outputOptionsCalls = (mockCommand.outputOptions as jest.Mock).mock.calls;
      expect(outputOptionsCalls.length).toBeGreaterThan(0);
      
      // Flatten all options from all calls
      const allOptions = outputOptionsCalls.flat();
      
      expect(allOptions).toContain('-f');
      expect(allOptions).toContain('hls');
      expect(allOptions).toContain(`-hls_time ${config.segmentDuration}`);
      expect(allOptions).toContain('-hls_list_size');
      expect(allOptions.join(' ')).toContain('append_list');
      expect(allOptions.join(' ')).toContain('discont_start');
    });

    it('should add video filter for scaling', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      const allOptions = (mockCommand.outputOptions as jest.Mock).mock.calls.flat();
      expect(allOptions).toContain('-vf');
    });

    it('should add bitstream filters', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      const allOptions = (mockCommand.outputOptions as jest.Mock).mock.calls.flat();
      expect(allOptions).toContain('-bsf:v');
      expect(allOptions).toContain('h264_mp4toannexb');
      expect(allOptions).toContain('-bsf:a');
      expect(allOptions).toContain('aac_adtstoasc');
    });

    it('should set up event handlers', async () => {
      const config = createStreamConfig();
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.on).toHaveBeenCalledWith('start', expect.any(Function));
      expect(mockCommand.on).toHaveBeenCalledWith('progress', expect.any(Function));
      expect(mockCommand.on).toHaveBeenCalledWith('stderr', expect.any(Function));
      expect(mockCommand.on).toHaveBeenCalledWith('end', expect.any(Function));
      expect(mockCommand.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should call run to start FFmpeg', async () => {
      const config = createStreamConfig();
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      
      await ffmpegEngine.start('channel-1', config);
      
      expect(mockCommand.run).toHaveBeenCalled();
    });

    it('should return stream handle', async () => {
      const config = createStreamConfig();
      
      const handle = await ffmpegEngine.start('channel-1', config);
      
      expect(handle).toBeDefined();
      expect(handle.id).toBe('channel-1');
      expect(handle.process).toBe(mockCommand);
      expect(handle.config).toBe(config);
    });

    it('should trigger onFileEnd callback when file ends', async () => {
      const config = createStreamConfig();
      const onFileEnd = jest.fn();
      
      await ffmpegEngine.start('channel-1', config, onFileEnd);
      
      // Get the end event handler
      const endHandler = (mockCommand.on as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === 'end'
      )?.[1];
      
      expect(endHandler).toBeDefined();
      endHandler();
      
      expect(onFileEnd).toHaveBeenCalled();
    });

    it('should trigger onFileEnd on error if callback exists', async () => {
      const config = createStreamConfig();
      const onFileEnd = jest.fn();
      
      await ffmpegEngine.start('channel-1', config, onFileEnd);
      
      // Get the error event handler
      const errorHandler = (mockCommand.on as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === 'error'
      )?.[1];
      
      expect(errorHandler).toBeDefined();
      
      const mockError = new Error('FFmpeg error');
      errorHandler(mockError);
      
      // Wait for setTimeout
      await new Promise((resolve) => setTimeout(resolve, 1100));
      
      expect(onFileEnd).toHaveBeenCalled();
    });
  });

  describe('Stream Stop', () => {
    it('should stop active stream', async () => {
      const config = createStreamConfig();
      await ffmpegEngine.start('channel-1', config);
      
      // Get the end handler
      const endHandler = (mockCommand.on as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === 'end'
      )?.[1];
      
      // Simulate graceful stop by calling end handler immediately
      const stopPromise = ffmpegEngine.stop('channel-1');
      
      // Trigger end handler to simulate FFmpeg ending gracefully
      setTimeout(() => {
        if (endHandler) {
          endHandler();
        }
      }, 10);
      
      await stopPromise;
      
      expect(mockCommand.kill).toHaveBeenCalledWith('SIGTERM');
    }, 10000);

    it('should force kill if graceful stop times out', async () => {
      const config = createStreamConfig();
      await ffmpegEngine.start('channel-1', config);
      
      // Don't trigger end handler, let timeout happen
      const stopPromise = ffmpegEngine.stop('channel-1');
      
      // Wait for timeout + a bit (5 second timeout + buffer)
      await new Promise((resolve) => setTimeout(resolve, 5100));
      
      expect(mockCommand.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockCommand.kill).toHaveBeenCalledWith('SIGKILL');
      
      await stopPromise;
    }, 10000);

    it('should handle stopping non-existent stream', async () => {
      await expect(ffmpegEngine.stop('non-existent')).resolves.not.toThrow();
    });
  });

  describe('Stream Status', () => {
    it('should return true for active stream', async () => {
      const config = createStreamConfig();
      await ffmpegEngine.start('channel-1', config);
      
      expect(ffmpegEngine.isActive('channel-1')).toBe(true);
    });

    it('should return false for inactive stream', () => {
      expect(ffmpegEngine.isActive('channel-1')).toBe(false);
    });

    it('should return handle for active stream', async () => {
      const config = createStreamConfig();
      const handle = await ffmpegEngine.start('channel-1', config);
      
      const retrieved = ffmpegEngine.getHandle('channel-1');
      expect(retrieved).toBe(handle);
    });

    it('should return undefined for non-existent stream', () => {
      expect(ffmpegEngine.getHandle('non-existent')).toBeUndefined();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup all active streams', async () => {
      await ffmpegEngine.start('channel-1', createStreamConfig());
      await ffmpegEngine.start('channel-2', createStreamConfig());
      
      // Get end handlers
      const endHandlers = (mockCommand.on as jest.Mock).mock.calls
        .filter((call: any[]) => call[0] === 'end')
        .map((call: any[]) => call[1]);
      
      const cleanupPromise = ffmpegEngine.cleanup();
      
      // Trigger end handlers immediately to avoid timeouts
      setTimeout(() => {
        endHandlers.forEach((handler) => handler && handler());
      }, 10);
      
      await cleanupPromise;
      
      expect(mockCommand.kill).toHaveBeenCalledTimes(2);
    }, 10000);
  });

  describe('Segment Numbering', () => {
    it('should start from 0 when playlist does not exist', async () => {
      const config = createStreamConfig();
      // Mock that playlist doesn't exist, but then exists after creation
      jest.spyOn(fs, 'access').mockImplementation((path) => {
        if (typeof path === 'string' && path.includes('stream.m3u8')) {
          // First call fails (file doesn't exist), subsequent calls succeed
          const callCount = (fs.access as jest.Mock).mock.calls.length;
          if (callCount === 0) {
            return Promise.reject(new Error('Not found'));
          }
          return Promise.resolve(undefined);
        }
        return Promise.reject(new Error('Not found'));
      });
      
      await ffmpegEngine.start('channel-1', config);
      
      const allOptions = (mockCommand.outputOptions as jest.Mock).mock.calls.flat();
      const startNumberIndex = allOptions.indexOf('-start_number');
      expect(startNumberIndex).toBeGreaterThan(-1);
      expect(allOptions[startNumberIndex + 1]).toBe('0');
    });
  });
});

