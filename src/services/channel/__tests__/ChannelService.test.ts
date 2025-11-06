import { ChannelService } from '../ChannelService';
import { FFmpegEngine, StreamConfig } from '../../../infrastructure/ffmpeg/FFmpegEngine';
import { Channel, ChannelState } from '../../../domain/channel/Channel';
import { MediaFile } from '../../../domain/media/MediaFile';
import { NotFoundError, ConflictError, ValidationError } from '../../../utils/errors';

// Mock FFmpegEngine
jest.mock('../../../infrastructure/ffmpeg/FFmpegEngine');
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
    paths: {
      hlsOutput: './hls_output',
    },
  },
}));

describe('ChannelService', () => {
  let channelService: ChannelService;
  let mockFFmpegEngine: jest.Mocked<FFmpegEngine>;

  const defaultConfig = {
    name: 'Test Channel',
    slug: 'test',
    outputDir: './output',
    videoBitrate: 1500000,
    audioBitrate: 128000,
    resolution: '1920x1080',
    fps: 30,
    segmentDuration: 6,
  };

  const createMockMediaFile = (index: number): MediaFile => ({
    id: `file-${index}`,
    path: `/path/to/file${index}.mp4`,
    filename: `file${index}.mp4`,
    metadata: {
      duration: 100,
      fileSize: 1000000,
    },
    info: {
      showName: `Show ${index}`,
    },
    addedAt: new Date(),
    getExtension: jest.fn().mockReturnValue('mp4'),
    isVideo: jest.fn().mockReturnValue(true),
    getDisplayName: jest.fn().mockReturnValue(`Show ${index}`),
    getDurationFormatted: jest.fn().mockReturnValue('01:40'),
    getFileSizeFormatted: jest.fn().mockReturnValue('1 MB'),
    toJSON: jest.fn().mockReturnValue({
      id: `file-${index}`,
      path: `/path/to/file${index}.mp4`,
      filename: `file${index}.mp4`,
    }),
  } as any);

  beforeEach(() => {
    mockFFmpegEngine = {
      start: jest.fn().mockResolvedValue({
        id: 'stream-handle',
        process: {} as any,
        config: {} as StreamConfig,
        startedAt: new Date(),
      }),
      stop: jest.fn().mockResolvedValue(undefined),
      isActive: jest.fn().mockReturnValue(false),
      getHandle: jest.fn().mockReturnValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    } as any;

    channelService = new ChannelService(mockFFmpegEngine as any);
  });

  afterEach(async () => {
    await channelService.cleanup();
    jest.clearAllMocks();
  });

  describe('Channel Creation', () => {
    it('should create a channel', () => {
      const channel = channelService.createChannel(defaultConfig);
      
      expect(channel).toBeDefined();
      expect(channel.config.name).toBe('Test Channel');
      expect(channel.config.slug).toBe('test');
      expect(channel.getState()).toBe(ChannelState.IDLE);
    });

    it('should prevent duplicate slugs', () => {
      channelService.createChannel(defaultConfig);
      
      expect(() => {
        channelService.createChannel(defaultConfig);
      }).toThrow(ConflictError);
    });

    it('should allow different slugs', () => {
      const channel1 = channelService.createChannel(defaultConfig);
      const channel2 = channelService.createChannel({
        ...defaultConfig,
        slug: 'test2',
        name: 'Channel 2',
      });
      
      expect(channel1.id).not.toBe(channel2.id);
      expect(channelService.getAllChannels()).toHaveLength(2);
    });
  });

  describe('Channel Retrieval', () => {
    it('should get channel by ID', () => {
      const channel = channelService.createChannel(defaultConfig);
      const retrieved = channelService.getChannel(channel.id);
      
      expect(retrieved.id).toBe(channel.id);
    });

    it('should throw NotFoundError for non-existent channel', () => {
      expect(() => {
        channelService.getChannel('non-existent');
      }).toThrow(NotFoundError);
    });

    it('should find channel by slug', () => {
      const channel = channelService.createChannel(defaultConfig);
      const found = channelService.findChannelBySlug('test');
      
      expect(found).toBeDefined();
      expect(found?.id).toBe(channel.id);
    });

    it('should return undefined for non-existent slug', () => {
      const found = channelService.findChannelBySlug('non-existent');
      expect(found).toBeUndefined();
    });

    it('should get all channels', () => {
      expect(channelService.getAllChannels()).toHaveLength(0);
      
      channelService.createChannel(defaultConfig);
      channelService.createChannel({ ...defaultConfig, slug: 'test2', name: 'Channel 2' });
      
      expect(channelService.getAllChannels()).toHaveLength(2);
    });
  });

  describe('Media Management', () => {
    let channelId: string;

    beforeEach(() => {
      const channel = channelService.createChannel(defaultConfig);
      channelId = channel.id;
    });

    it('should set media files for channel', () => {
      const media = [createMockMediaFile(1), createMockMediaFile(2)];
      
      channelService.setChannelMedia(channelId, media);
      
      expect(channelService.getChannelMedia(channelId)).toHaveLength(2);
      expect(channelService.getChannelMedia(channelId)[0].filename).toBe('file1.mp4');
    });

    it('should return empty array when no media set', () => {
      expect(channelService.getChannelMedia(channelId)).toEqual([]);
    });

    it('should throw NotFoundError when setting media for non-existent channel', () => {
      expect(() => {
        channelService.setChannelMedia('non-existent', []);
      }).toThrow(NotFoundError);
    });

    it('should replace existing media', () => {
      channelService.setChannelMedia(channelId, [createMockMediaFile(1)]);
      expect(channelService.getChannelMedia(channelId)).toHaveLength(1);
      
      channelService.setChannelMedia(channelId, [
        createMockMediaFile(2),
        createMockMediaFile(3),
      ]);
      expect(channelService.getChannelMedia(channelId)).toHaveLength(2);
      expect(channelService.getChannelMedia(channelId)[0].filename).toBe('file2.mp4');
    });
  });

  describe('Starting Channels', () => {
    let channelId: string;
    let media: MediaFile[];

    beforeEach(() => {
      const channel = channelService.createChannel(defaultConfig);
      channelId = channel.id;
      media = [
        createMockMediaFile(1),
        createMockMediaFile(2),
        createMockMediaFile(3),
      ];
      channelService.setChannelMedia(channelId, media);
    });

    it('should start channel with first file', async () => {
      await channelService.startChannel(channelId);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getState()).toBe(ChannelState.STREAMING);
      expect(channel.getMetadata().currentIndex).toBe(0);
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(1);
    });

    it('should start channel from specific index', async () => {
      await channelService.startChannel(channelId, 1);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getState()).toBe(ChannelState.STREAMING);
      expect(channel.getMetadata().currentIndex).toBe(1);
      
      const callArgs = (mockFFmpegEngine.start as jest.Mock).mock.calls[0];
      expect(callArgs[1].inputFile).toBe(media[1].path);
    });

    it('should throw ValidationError when no media files', async () => {
      channelService.setChannelMedia(channelId, []);
      
      await expect(channelService.startChannel(channelId)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid start index', async () => {
      await expect(channelService.startChannel(channelId, 10)).rejects.toThrow(ValidationError);
      await expect(channelService.startChannel(channelId, -1)).rejects.toThrow(ValidationError);
    });

    it('should throw ConflictError when already streaming', async () => {
      await channelService.startChannel(channelId);
      
      await expect(channelService.startChannel(channelId)).rejects.toThrow(ConflictError);
    });

    it('should transition through STARTING state', async () => {
      const channel = channelService.getChannel(channelId);
      
      const startPromise = channelService.startChannel(channelId);
      
      // Check state during transition
      expect(channel.getState()).toBe(ChannelState.STARTING);
      
      await startPromise;
      expect(channel.getState()).toBe(ChannelState.STREAMING);
    });
  });

  describe('Stopping Channels', () => {
    let channelId: string;

    beforeEach(async () => {
      const channel = channelService.createChannel(defaultConfig);
      channelId = channel.id;
      channelService.setChannelMedia(channelId, [createMockMediaFile(1)]);
      await channelService.startChannel(channelId);
    });

    it('should stop streaming channel', async () => {
      await channelService.stopChannel(channelId);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getState()).toBe(ChannelState.IDLE);
      expect(mockFFmpegEngine.stop).toHaveBeenCalledWith(channelId);
    });

    it('should not throw when stopping idle channel', async () => {
      await channelService.stopChannel(channelId);
      await channelService.stopChannel(channelId); // Already stopped
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getState()).toBe(ChannelState.IDLE);
    });
  });

  describe('File Transitions', () => {
    let channelId: string;
    let media: MediaFile[];
    let onFileEndCallback: (() => void) | undefined;

    beforeEach(() => {
      const channel = channelService.createChannel(defaultConfig);
      channelId = channel.id;
      media = [
        createMockMediaFile(1),
        createMockMediaFile(2),
        createMockMediaFile(3),
      ];
      channelService.setChannelMedia(channelId, media);
      
      // Capture the onFileEnd callback
      (mockFFmpegEngine.start as jest.Mock).mockImplementation((id, config, onFileEnd) => {
        onFileEndCallback = onFileEnd;
        return Promise.resolve({
          id,
          process: {} as any,
          config,
          startedAt: new Date(),
          onFileEnd,
        });
      });
    });

    it('should transition to next file when current ends', async () => {
      await channelService.startChannel(channelId, 0);
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(1);
      
      // Simulate file end
      if (onFileEndCallback) {
        await onFileEndCallback();
      }
      
      // Should start next file
      await new Promise((resolve) => setTimeout(resolve, 600)); // Wait for delay + transition
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(2);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getMetadata().currentIndex).toBe(1);
    });

    it('should loop back to first file after last file', async () => {
      await channelService.startChannel(channelId, 2); // Start at last file
      
      // Simulate file end
      if (onFileEndCallback) {
        await onFileEndCallback();
      }
      
      await new Promise((resolve) => setTimeout(resolve, 600));
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getMetadata().currentIndex).toBe(0); // Looped back
    });

    it('should handle transition when channel no longer exists', async () => {
      await channelService.startChannel(channelId);
      
      // Delete channel before file ends
      await channelService.deleteChannel(channelId);
      
      // Simulate file end - should not crash
      if (onFileEndCallback) {
        await expect(onFileEndCallback()).resolves.not.toThrow();
      }
    });

    it('should not transition if channel is no longer streaming', async () => {
      await channelService.startChannel(channelId);
      
      // Stop channel before file ends
      await channelService.stopChannel(channelId);
      
      // Simulate file end - should not start new file
      const callCountBefore = (mockFFmpegEngine.start as jest.Mock).mock.calls.length;
      if (onFileEndCallback) {
        await onFileEndCallback();
      }
      
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(callCountBefore);
    });
  });

  describe('Channel Operations', () => {
    let channelId: string;

    beforeEach(async () => {
      const channel = channelService.createChannel(defaultConfig);
      channelId = channel.id;
      channelService.setChannelMedia(channelId, [
        createMockMediaFile(1),
        createMockMediaFile(2),
        createMockMediaFile(3),
      ]);
      await channelService.startChannel(channelId);
    });

    it('should restart channel', async () => {
      const channel = channelService.getChannel(channelId);
      const originalIndex = channel.getMetadata().currentIndex;
      
      await channelService.restartChannel(channelId);
      
      expect(mockFFmpegEngine.stop).toHaveBeenCalled();
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(2); // Initial + restart
      expect(channel.getMetadata().currentIndex).toBe(originalIndex);
    });

    it('should move to next file', async () => {
      await channelService.nextFile(channelId);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getMetadata().currentIndex).toBe(1);
    });

    it('should loop to first file when moving next from last', async () => {
      const channel = channelService.getChannel(channelId);
      channel.updateCurrentIndex(2); // Last file
      
      await channelService.nextFile(channelId);
      
      expect(channel.getMetadata().currentIndex).toBe(0);
    });

    it('should set file index', async () => {
      await channelService.setFileIndex(channelId, 2);
      
      const channel = channelService.getChannel(channelId);
      expect(channel.getMetadata().currentIndex).toBe(2);
    });

    it('should throw ValidationError for invalid index', async () => {
      await expect(channelService.setFileIndex(channelId, 10)).rejects.toThrow(ValidationError);
      await expect(channelService.setFileIndex(channelId, -1)).rejects.toThrow(ValidationError);
    });
  });

  describe('Channel Deletion', () => {
    it('should delete idle channel', async () => {
      const channel = channelService.createChannel(defaultConfig);
      const channelId = channel.id;
      
      await channelService.deleteChannel(channelId);
      
      expect(() => channelService.getChannel(channelId)).toThrow(NotFoundError);
    });

    it('should stop and delete streaming channel', async () => {
      const channel = channelService.createChannel(defaultConfig);
      const channelId = channel.id;
      channelService.setChannelMedia(channelId, [createMockMediaFile(1)]);
      await channelService.startChannel(channelId);
      
      await channelService.deleteChannel(channelId);
      
      expect(mockFFmpegEngine.stop).toHaveBeenCalled();
      expect(() => channelService.getChannel(channelId)).toThrow(NotFoundError);
    });
  });

  describe('State Restoration', () => {
    it('should restore channel from saved state', async () => {
      const channel = channelService.createChannel(defaultConfig);
      const channelId = channel.id;
      
      // Simulate state change
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      channel.updateCurrentIndex(2);
      
      // Get the channel state and metadata before deletion
      const channelState = ChannelState.STREAMING; // What we want to restore
      const channelMetadata = channel.getMetadata();
      
      // Manually remove from service (simulating restore scenario)
      // Don't call deleteChannel as it stops the stream and changes state
      channelService['channels'].delete(channelId);
      
      // Restore with the desired state
      const restoredChannel = new Channel(defaultConfig, channelId, channelState, {
        currentIndex: channelMetadata.currentIndex,
      });
      channelService.restoreChannel(restoredChannel);
      
      const retrieved = channelService.getChannel(channelId);
      expect(retrieved.id).toBe(channelId);
      expect(retrieved.getState()).toBe(channelState);
      expect(retrieved.getMetadata().currentIndex).toBe(channelMetadata.currentIndex);
    });

    it('should skip restore if channel already exists', () => {
      const channel = channelService.createChannel(defaultConfig);
      
      channelService.restoreChannel(channel);
      
      expect(channelService.getAllChannels()).toHaveLength(1);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup all channels', async () => {
      const channel1 = channelService.createChannel(defaultConfig);
      const channel2 = channelService.createChannel({
        ...defaultConfig,
        slug: 'test2',
        name: 'Channel 2',
      });
      
      channelService.setChannelMedia(channel1.id, [createMockMediaFile(1)]);
      channelService.setChannelMedia(channel2.id, [createMockMediaFile(2)]);
      
      await channelService.startChannel(channel1.id);
      await channelService.startChannel(channel2.id);
      
      await channelService.cleanup();
      
      expect(mockFFmpegEngine.stop).toHaveBeenCalledTimes(2);
    });
  });
});
