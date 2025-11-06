import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs/promises';
import { config } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { MediaFileMetadata } from '../../domain/media/MediaFile';
import { FFmpegError } from '../../utils/errors';

const logger = createLogger('MetadataExtractor');

// Set FFmpeg paths
ffmpeg.setFfmpegPath(config.ffmpeg.path);
ffmpeg.setFfprobePath(config.ffmpeg.probePath);

export class MetadataExtractor {
  /**
   * Extract metadata from media file using ffprobe
   */
  public async extract(filePath: string): Promise<MediaFileMetadata> {
    try {
      // Check if file exists
      const stats = await fs.stat(filePath);

      // Get metadata using ffprobe
      const metadata = await this.probe(filePath);

      // Extract relevant information
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const duration = parseFloat(String(metadata.format.duration || '0'));
      const fileSize = stats.size;

      return {
        duration,
        fileSize,
        resolution: videoStream
          ? `${videoStream.width}x${videoStream.height}`
          : undefined,
        codec: videoStream?.codec_name,
        bitrate: metadata.format.bit_rate
          ? parseInt(String(metadata.format.bit_rate), 10)
          : undefined,
        fps: this.extractFPS(videoStream),
      };
    } catch (error) {
      logger.error({ error, file: filePath }, 'Failed to extract metadata');
      throw new FFmpegError(`Failed to extract metadata: ${error}`);
    }
  }

  /**
   * Probe file using ffprobe
   */
  private probe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          resolve(metadata);
        }
      });
    });
  }

  /**
   * Extract FPS from video stream
   */
  private extractFPS(stream: any): number | undefined {
    if (!stream) return undefined;

    // Try r_frame_rate first (most accurate)
    if (stream.r_frame_rate) {
      const parts = stream.r_frame_rate.split('/');
      if (parts.length === 2) {
        const fps = parseInt(parts[0], 10) / parseInt(parts[1], 10);
        if (!isNaN(fps) && fps > 0) {
          return Math.round(fps * 100) / 100;
        }
      }
    }

    // Fallback to avg_frame_rate
    if (stream.avg_frame_rate) {
      const parts = stream.avg_frame_rate.split('/');
      if (parts.length === 2) {
        const fps = parseInt(parts[0], 10) / parseInt(parts[1], 10);
        if (!isNaN(fps) && fps > 0) {
          return Math.round(fps * 100) / 100;
        }
      }
    }

    return undefined;
  }
}
