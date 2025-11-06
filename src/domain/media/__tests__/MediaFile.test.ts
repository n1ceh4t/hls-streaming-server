import { MediaFile, MediaFileMetadata, MediaFileInfo } from '../MediaFile';

describe('MediaFile', () => {
  const mockMetadata: MediaFileMetadata = {
    duration: 1440, // 24 minutes
    fileSize: 524288000, // 500 MB
    resolution: '1920x1080',
    codec: 'h264',
    bitrate: 2500000,
    fps: 24,
  };

  const mockInfo: MediaFileInfo = {
    showName: 'Breaking Bad',
    season: 1,
    episode: 1,
    title: 'Pilot',
  };

  const mockPath = '/media/shows/Breaking Bad/Season 01/Breaking.Bad.S01E01.Pilot.mkv';

  describe('initialization', () => {
    it('should create a media file with all properties', () => {
      const file = new MediaFile(mockPath, mockMetadata, mockInfo);

      expect(file.id).toBeDefined();
      expect(file.path).toBe(mockPath);
      expect(file.filename).toBe('Breaking.Bad.S01E01.Pilot.mkv');
      expect(file.metadata).toEqual(mockMetadata);
      expect(file.info).toEqual(mockInfo);
      expect(file.addedAt).toBeInstanceOf(Date);
    });

    it('should allow custom id and addedAt', () => {
      const customId = 'custom-id';
      const customDate = new Date('2023-01-01');

      const file = new MediaFile(mockPath, mockMetadata, mockInfo, customId, customDate);

      expect(file.id).toBe(customId);
      expect(file.addedAt).toEqual(customDate);
    });
  });

  describe('file extension detection', () => {
    it('should extract file extension', () => {
      const file = new MediaFile(mockPath, mockMetadata, mockInfo);
      expect(file.getExtension()).toBe('.mkv');
    });

    it('should detect video files', () => {
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

      videoExtensions.forEach((ext) => {
        const file = new MediaFile(`/test/file${ext}`, mockMetadata, mockInfo);
        expect(file.isVideo()).toBe(true);
      });
    });

    it('should reject non-video files', () => {
      const nonVideoExtensions = ['.txt', '.jpg', '.png', '.mp3', '.zip'];

      nonVideoExtensions.forEach((ext) => {
        const file = new MediaFile(`/test/file${ext}`, mockMetadata, mockInfo);
        expect(file.isVideo()).toBe(false);
      });
    });

    it('should handle case-insensitive extensions', () => {
      const file1 = new MediaFile('/test/file.MP4', mockMetadata, mockInfo);
      const file2 = new MediaFile('/test/file.MKV', mockMetadata, mockInfo);

      expect(file1.isVideo()).toBe(true);
      expect(file2.isVideo()).toBe(true);
    });
  });

  describe('display name generation', () => {
    it('should use title if provided', () => {
      const file = new MediaFile(mockPath, mockMetadata, mockInfo);
      expect(file.getDisplayName()).toBe('Pilot');
    });

    it('should generate name with season and episode', () => {
      const infoWithoutTitle: MediaFileInfo = {
        showName: 'Breaking Bad',
        season: 1,
        episode: 5,
      };

      const file = new MediaFile(mockPath, mockMetadata, infoWithoutTitle);
      expect(file.getDisplayName()).toBe('Breaking Bad S01E05');
    });

    it('should use show name only if no season/episode', () => {
      const infoBasic: MediaFileInfo = {
        showName: 'The Matrix',
      };

      const file = new MediaFile(mockPath, mockMetadata, infoBasic);
      expect(file.getDisplayName()).toBe('The Matrix');
    });

    it('should pad season and episode numbers', () => {
      const info: MediaFileInfo = {
        showName: 'Test Show',
        season: 2,
        episode: 15,
      };

      const file = new MediaFile(mockPath, mockMetadata, info);
      expect(file.getDisplayName()).toBe('Test Show S02E15');
    });
  });

  describe('duration formatting', () => {
    it('should format duration with hours', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        duration: 7265, // 2:01:05
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getDurationFormatted()).toBe('2:01:05');
    });

    it('should format duration without hours', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        duration: 1440, // 24:00
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getDurationFormatted()).toBe('24:00');
    });

    it('should format short durations', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        duration: 125, // 2:05
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getDurationFormatted()).toBe('2:05');
    });

    it('should pad minutes and seconds', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        duration: 65, // 1:05
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getDurationFormatted()).toBe('1:05');
    });
  });

  describe('file size formatting', () => {
    it('should format bytes', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        fileSize: 512,
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('512.00 B');
    });

    it('should format kilobytes', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        fileSize: 1536, // 1.5 KB
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('1.50 KB');
    });

    it('should format megabytes', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        fileSize: 1572864, // 1.5 MB
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('1.50 MB');
    });

    it('should format gigabytes', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        fileSize: 1610612736, // 1.5 GB
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('1.50 GB');
    });

    it('should format the provided file size correctly', () => {
      const file = new MediaFile(mockPath, mockMetadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('500.00 MB');
    });
  });

  describe('serialization', () => {
    it('should serialize to JSON', () => {
      const file = new MediaFile(mockPath, mockMetadata, mockInfo, 'test-id');
      const json = file.toJSON();

      expect(json).toEqual({
        id: 'test-id',
        path: mockPath,
        filename: 'Breaking.Bad.S01E01.Pilot.mkv',
        metadata: mockMetadata,
        info: mockInfo,
        addedAt: file.addedAt.toISOString(),
      });
    });

    it('should deserialize from JSON', () => {
      const originalFile = new MediaFile(mockPath, mockMetadata, mockInfo, 'test-id');
      const json = originalFile.toJSON();
      const restoredFile = MediaFile.fromJSON(json);

      expect(restoredFile.id).toBe(originalFile.id);
      expect(restoredFile.path).toBe(originalFile.path);
      expect(restoredFile.filename).toBe(originalFile.filename);
      expect(restoredFile.metadata).toEqual(originalFile.metadata);
      expect(restoredFile.info).toEqual(originalFile.info);
      expect(restoredFile.addedAt.toISOString()).toBe(originalFile.addedAt.toISOString());
    });

    it('should support round-trip serialization', () => {
      const file1 = new MediaFile(mockPath, mockMetadata, mockInfo);
      const json = file1.toJSON();
      const file2 = MediaFile.fromJSON(json);

      expect(file2.toJSON()).toEqual(json);
    });
  });

  describe('edge cases', () => {
    it('should handle files without extension', () => {
      const file = new MediaFile('/test/file', mockMetadata, mockInfo);
      expect(file.getExtension()).toBe('');
      expect(file.isVideo()).toBe(false);
    });

    it('should handle zero duration', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        duration: 0,
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getDurationFormatted()).toBe('0:00');
    });

    it('should handle zero file size', () => {
      const metadata: MediaFileMetadata = {
        ...mockMetadata,
        fileSize: 0,
      };

      const file = new MediaFile(mockPath, metadata, mockInfo);
      expect(file.getFileSizeFormatted()).toBe('0.00 B');
    });

    it('should handle optional metadata fields', () => {
      const minimalMetadata: MediaFileMetadata = {
        duration: 100,
        fileSize: 1000,
      };

      const file = new MediaFile(mockPath, minimalMetadata, mockInfo);

      expect(file.metadata.resolution).toBeUndefined();
      expect(file.metadata.codec).toBeUndefined();
      expect(file.metadata.bitrate).toBeUndefined();
      expect(file.metadata.fps).toBeUndefined();
    });
  });
});
