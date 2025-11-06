import request from 'supertest';
import express from 'express';
import { createChannelRoutes } from '../channels';
import { ChannelService } from '../../../services/channel/ChannelService';
import { FFmpegEngine } from '../../../infrastructure/ffmpeg/FFmpegEngine';
import { errorHandler } from '../../middleware/errorHandler';

// Mock dependencies
jest.mock('../../../infrastructure/ffmpeg/FFmpegEngine');
jest.mock('../../../config/env', () => ({
  config: {
    security: {
      apiKey: 'test-api-key',
      requireAuth: true,
    },
    logging: {
      level: 'silent',
      format: 'json',
    },
    ffmpeg: {
      path: 'ffmpeg',
      probePath: 'ffprobe',
    },
  },
}));

describe('Channels API', () => {
  let app: express.Application;
  let channelService: ChannelService;
  let mockFFmpegEngine: jest.Mocked<FFmpegEngine>;

  beforeEach(() => {
    mockFFmpegEngine = new FFmpegEngine() as jest.Mocked<FFmpegEngine>;
    mockFFmpegEngine.start = jest.fn().mockResolvedValue({ id: 'test' });
    mockFFmpegEngine.stop = jest.fn().mockResolvedValue(undefined);

    channelService = new ChannelService(mockFFmpegEngine);

    app = express();
    app.use(express.json());
    app.use('/api/channels', createChannelRoutes(channelService));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await channelService.cleanup();
    jest.clearAllMocks();
  });

  describe('GET /api/channels', () => {
    it('should return empty array when no channels exist', async () => {
      const response = await request(app).get('/api/channels');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        data: [],
      });
    });

    it('should return all channels', async () => {
      channelService.createChannel({
        name: 'Channel 1',
        slug: 'channel1',
        outputDir: './output1',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });

      const response = await request(app).get('/api/channels');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0].config.name).toBe('Channel 1');
    });
  });

  describe('GET /api/channels/:channelId', () => {
    it('should return channel by ID', async () => {
      const channel = channelService.createChannel({
        name: 'Test Channel',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });

      const response = await request(app).get(`/api/channels/${channel.id}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.id).toBe(channel.id);
      expect(response.body.data.mediaCount).toBe(0);
    });

    it('should return 404 for non-existent channel', async () => {
      const response = await request(app).get('/api/channels/non-existent');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/channels', () => {
    it('should require authentication', async () => {
      const response = await request(app).post('/api/channels').send({
        name: 'New Channel',
        slug: 'new',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_ERROR');
    });

    it('should create channel with valid API key', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'New Channel',
          slug: 'new',
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.config.name).toBe('New Channel');
      expect(response.body.data.config.slug).toBe('new');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should validate slug format', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'Invalid Slug',
          slug: 'Invalid Slug!',
        });

      expect(response.status).toBe(400);
    });

    it('should prevent duplicate slugs', async () => {
      await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'Channel 1',
          slug: 'test',
        });

      const response = await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'Channel 2',
          slug: 'test',
        });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('should use default values for optional fields', async () => {
      const response = await request(app)
        .post('/api/channels')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'Default Channel',
          slug: 'default',
        });

      expect(response.status).toBe(201);
      expect(response.body.data.config.videoBitrate).toBe(1500000);
      expect(response.body.data.config.resolution).toBe('1920x1080');
    });
  });

  describe('POST /api/channels/:channelId/start', () => {
    let channelId: string;

    beforeEach(() => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;

      // Add mock media
      channelService.setChannelMedia(channelId, [
        {
          id: '1',
          path: '/test.mp4',
          filename: 'test.mp4',
          metadata: { duration: 100, fileSize: 1000 },
          info: { showName: 'Test' },
          addedAt: new Date(),
        } as any,
      ]);
    });

    it('should require authentication', async () => {
      const response = await request(app).post(`/api/channels/${channelId}/start`);

      expect(response.status).toBe(401);
    });

    it('should start channel with valid API key', async () => {
      const response = await request(app)
        .post(`/api/channels/${channelId}/start`)
        .set('X-API-Key', 'test-api-key');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockFFmpegEngine.start).toHaveBeenCalled();
    });

    it('should return 404 for non-existent channel', async () => {
      const response = await request(app)
        .post('/api/channels/non-existent/start')
        .set('X-API-Key', 'test-api-key');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/channels/:channelId/stop', () => {
    let channelId: string;

    beforeEach(async () => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;

      channelService.setChannelMedia(channelId, [
        {
          id: '1',
          path: '/test.mp4',
          filename: 'test.mp4',
          metadata: { duration: 100, fileSize: 1000 },
          info: { showName: 'Test' },
          addedAt: new Date(),
        } as any,
      ]);

      await channelService.startChannel(channelId);
    });

    it('should stop channel', async () => {
      const response = await request(app)
        .post(`/api/channels/${channelId}/stop`)
        .set('X-API-Key', 'test-api-key');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockFFmpegEngine.stop).toHaveBeenCalled();
    });
  });

  describe('POST /api/channels/:channelId/restart', () => {
    let channelId: string;

    beforeEach(async () => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;

      channelService.setChannelMedia(channelId, [
        {
          id: '1',
          path: '/test.mp4',
          filename: 'test.mp4',
          metadata: { duration: 100, fileSize: 1000 },
          info: { showName: 'Test' },
          addedAt: new Date(),
        } as any,
      ]);

      await channelService.startChannel(channelId);
    });

    it('should restart channel', async () => {
      const response = await request(app)
        .post(`/api/channels/${channelId}/restart`)
        .set('X-API-Key', 'test-api-key');

      expect(response.status).toBe(200);
      expect(mockFFmpegEngine.stop).toHaveBeenCalled();
      expect(mockFFmpegEngine.start).toHaveBeenCalledTimes(2); // Once for start, once for restart
    });
  });

  describe('PUT /api/channels/:channelId/index', () => {
    let channelId: string;

    beforeEach(() => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;

      channelService.setChannelMedia(channelId, [
        { id: '1', path: '/test1.mp4' } as any,
        { id: '2', path: '/test2.mp4' } as any,
        { id: '3', path: '/test3.mp4' } as any,
      ]);
    });

    it('should update file index', async () => {
      const response = await request(app)
        .put(`/api/channels/${channelId}/index`)
        .set('X-API-Key', 'test-api-key')
        .send({ index: 2 });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const channel = channelService.getChannel(channelId);
      expect(channel.getMetadata().currentIndex).toBe(2);
    });

    it('should validate index is a number', async () => {
      const response = await request(app)
        .put(`/api/channels/${channelId}/index`)
        .set('X-API-Key', 'test-api-key')
        .send({ index: 'invalid' });

      expect(response.status).toBe(400);
    });

    it('should reject negative index', async () => {
      const response = await request(app)
        .put(`/api/channels/${channelId}/index`)
        .set('X-API-Key', 'test-api-key')
        .send({ index: -1 });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/channels/:channelId', () => {
    let channelId: string;

    beforeEach(() => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;
    });

    it('should delete channel', async () => {
      const response = await request(app)
        .delete(`/api/channels/${channelId}`)
        .set('X-API-Key', 'test-api-key');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Verify channel is deleted
      const getResponse = await request(app).get(`/api/channels/${channelId}`);
      expect(getResponse.status).toBe(404);
    });
  });

  describe('GET /api/channels/:channelId/media', () => {
    let channelId: string;

    beforeEach(() => {
      const channel = channelService.createChannel({
        name: 'Test',
        slug: 'test',
        outputDir: './output',
        videoBitrate: 1500000,
        audioBitrate: 128000,
        resolution: '1920x1080',
        fps: 30,
        segmentDuration: 6,
      });
      channelId = channel.id;
    });

    it('should return empty array when no media', async () => {
      const response = await request(app).get(`/api/channels/${channelId}/media`);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    it('should return channel media files', async () => {
      const mockMedia = [
        {
          id: '1',
          path: '/test.mp4',
          filename: 'test.mp4',
          metadata: { duration: 100, fileSize: 1000 },
          info: { showName: 'Test' },
          addedAt: new Date(),
          toJSON: () => ({
            id: '1',
            path: '/test.mp4',
            filename: 'test.mp4',
            metadata: { duration: 100, fileSize: 1000 },
            info: { showName: 'Test' },
            addedAt: new Date().toISOString(),
          }),
        } as any,
      ];

      channelService.setChannelMedia(channelId, mockMedia);

      const response = await request(app).get(`/api/channels/${channelId}/media`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].filename).toBe('test.mp4');
    });
  });
});
