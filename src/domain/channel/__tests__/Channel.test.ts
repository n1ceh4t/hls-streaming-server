import { Channel, ChannelState } from '../Channel';

describe('Channel State Machine', () => {
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

  describe('State Transitions', () => {
    it('should start in IDLE state', () => {
      const channel = new Channel(defaultConfig);
      expect(channel.getState()).toBe(ChannelState.IDLE);
      expect(channel.isIdle()).toBe(true);
      expect(channel.isStreaming()).toBe(false);
    });

    it('should transition IDLE -> STARTING -> STREAMING', () => {
      const channel = new Channel(defaultConfig);
      
      channel.transitionTo(ChannelState.STARTING);
      expect(channel.getState()).toBe(ChannelState.STARTING);
      
      channel.transitionTo(ChannelState.STREAMING);
      expect(channel.getState()).toBe(ChannelState.STREAMING);
      expect(channel.isStreaming()).toBe(true);
      expect(channel.getMetadata().startedAt).toBeDefined();
    });

    it('should transition STREAMING -> STOPPING -> IDLE', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      
      channel.transitionTo(ChannelState.STOPPING);
      expect(channel.getState()).toBe(ChannelState.STOPPING);
      
      channel.transitionTo(ChannelState.IDLE);
      expect(channel.getState()).toBe(ChannelState.IDLE);
      expect(channel.isIdle()).toBe(true);
    });

    it('should transition to ERROR from any state', () => {
      const channel = new Channel(defaultConfig);
      
      // From IDLE -> STARTING -> ERROR
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.ERROR);
      expect(channel.getState()).toBe(ChannelState.ERROR);
      
      // Reset and test from STREAMING -> ERROR
      channel.transitionTo(ChannelState.IDLE);
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      channel.transitionTo(ChannelState.ERROR);
      expect(channel.getState()).toBe(ChannelState.ERROR);
    });

    it('should transition ERROR -> IDLE -> STARTING', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.ERROR);
      
      channel.transitionTo(ChannelState.IDLE);
      expect(channel.getState()).toBe(ChannelState.IDLE);
      
      channel.transitionTo(ChannelState.STARTING);
      expect(channel.getState()).toBe(ChannelState.STARTING);
    });

    it('should reject invalid transitions', () => {
      const channel = new Channel(defaultConfig);
      
      // IDLE cannot go directly to STREAMING
      expect(() => {
        channel.transitionTo(ChannelState.STREAMING);
      }).toThrow();
      
      // STREAMING cannot go directly to STARTING
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      expect(() => {
        channel.transitionTo(ChannelState.STARTING);
      }).toThrow();
    });

    it('should allow STARTING -> IDLE (abort scenario)', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      
      channel.transitionTo(ChannelState.IDLE);
      expect(channel.getState()).toBe(ChannelState.IDLE);
    });
  });

  describe('Metadata Management', () => {
    it('should initialize with default metadata', () => {
      const channel = new Channel(defaultConfig);
      const metadata = channel.getMetadata();
      
      expect(metadata.currentIndex).toBe(0);
      expect(metadata.accumulatedTime).toBe(0);
      expect(metadata.viewerCount).toBe(0);
      expect(metadata.startedAt).toBeUndefined();
      expect(metadata.lastError).toBeUndefined();
    });

    it('should update current index', () => {
      const channel = new Channel(defaultConfig);
      
      channel.updateCurrentIndex(5);
      expect(channel.getMetadata().currentIndex).toBe(5);
      
      channel.updateCurrentIndex(0);
      expect(channel.getMetadata().currentIndex).toBe(0);
    });

    it('should update accumulated time', () => {
      const channel = new Channel(defaultConfig);
      
      channel.updateAccumulatedTime(100);
      expect(channel.getMetadata().accumulatedTime).toBe(100);
      
      channel.updateAccumulatedTime(250);
      expect(channel.getMetadata().accumulatedTime).toBe(250);
    });

    it('should manage viewer count', () => {
      const channel = new Channel(defaultConfig);
      
      channel.incrementViewerCount();
      expect(channel.getMetadata().viewerCount).toBe(1);
      
      channel.incrementViewerCount();
      channel.incrementViewerCount();
      expect(channel.getMetadata().viewerCount).toBe(3);
      
      channel.decrementViewerCount();
      expect(channel.getMetadata().viewerCount).toBe(2);
      
      // Should not go below 0
      channel.decrementViewerCount();
      channel.decrementViewerCount();
      channel.decrementViewerCount();
      expect(channel.getMetadata().viewerCount).toBe(0);
    });

    it('should set and clear errors', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      
      channel.setError('Test error message');
      expect(channel.getState()).toBe(ChannelState.ERROR);
      expect(channel.getMetadata().lastError).toBe('Test error message');
      expect(channel.getMetadata().lastErrorAt).toBeDefined();
      
      channel.clearError();
      expect(channel.getMetadata().lastError).toBeUndefined();
      expect(channel.getMetadata().lastErrorAt).toBeUndefined();
    });

    it('should set startedAt when transitioning to STREAMING', () => {
      const channel = new Channel(defaultConfig);
      const before = new Date();
      
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      
      const after = new Date();
      const startedAt = channel.getMetadata().startedAt;
      
      expect(startedAt).toBeDefined();
      expect(startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(startedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      channel.updateCurrentIndex(5);
      
      const json = channel.toJSON();
      
      expect(json.id).toBe(channel.id);
      expect(json.config).toEqual(defaultConfig);
      expect(json.state).toBe(ChannelState.STREAMING);
      expect(json.metadata.currentIndex).toBe(5);
      expect(json.metadata.startedAt).toBeDefined();
    });

    it('should deserialize from JSON', () => {
      const original = new Channel(defaultConfig, 'test-id', ChannelState.STREAMING, {
        currentIndex: 3,
        accumulatedTime: 1000,
        viewerCount: 5,
      });
      
      const json = original.toJSON();
      const restored = Channel.fromJSON(json);
      
      expect(restored.id).toBe(original.id);
      expect(restored.config).toEqual(original.config);
      expect(restored.getState()).toBe(ChannelState.STREAMING);
      expect(restored.getMetadata().currentIndex).toBe(3);
      expect(restored.getMetadata().accumulatedTime).toBe(1000);
      expect(restored.getMetadata().viewerCount).toBe(5);
    });

    it('should preserve state through serialization', () => {
      const states = [
        ChannelState.IDLE,
        ChannelState.STARTING,
        ChannelState.STREAMING,
        ChannelState.STOPPING,
        ChannelState.ERROR,
      ];
      
      states.forEach((state) => {
        const channel = new Channel(defaultConfig, 'test-id', state);
        const json = channel.toJSON();
        const restored = Channel.fromJSON(json);
        
        expect(restored.getState()).toBe(state);
      });
    });
  });

  describe('canTransitionTo', () => {
    it('should return true for valid transitions', () => {
      const channel = new Channel(defaultConfig);
      
      expect(channel.canTransitionTo(ChannelState.STARTING)).toBe(true);
      expect(channel.canTransitionTo(ChannelState.STOPPING)).toBe(false);
      expect(channel.canTransitionTo(ChannelState.STREAMING)).toBe(false);
    });

    it('should return false for invalid transitions', () => {
      const channel = new Channel(defaultConfig);
      channel.transitionTo(ChannelState.STARTING);
      channel.transitionTo(ChannelState.STREAMING);
      
      expect(channel.canTransitionTo(ChannelState.STARTING)).toBe(false);
      expect(channel.canTransitionTo(ChannelState.IDLE)).toBe(false);
      expect(channel.canTransitionTo(ChannelState.STOPPING)).toBe(true);
      expect(channel.canTransitionTo(ChannelState.ERROR)).toBe(true);
    });
  });
});
