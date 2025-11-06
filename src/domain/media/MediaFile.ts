import { v4 as uuidv4 } from 'uuid';
import path from 'path';

export interface MediaFileMetadata {
  duration: number; // seconds
  fileSize: number; // bytes
  resolution?: string;
  codec?: string;
  bitrate?: number;
  fps?: number;
}

export interface MediaFileInfo {
  showName: string;
  season?: number;
  episode?: number;
  title?: string;
}

/**
 * Media file entity
 */
export class MediaFile {
  public readonly id: string;
  public readonly path: string;
  public readonly filename: string;
  public readonly metadata: MediaFileMetadata;
  public readonly info: MediaFileInfo;
  public readonly addedAt: Date;

  constructor(
    filePath: string,
    metadata: MediaFileMetadata,
    info: MediaFileInfo,
    id?: string,
    addedAt?: Date
  ) {
    this.id = id || uuidv4();
    this.path = filePath;
    this.filename = path.basename(filePath);
    this.metadata = metadata;
    this.info = info;
    this.addedAt = addedAt || new Date();
  }

  // Helper methods
  public getExtension(): string {
    return path.extname(this.path).toLowerCase();
  }

  public isVideo(): boolean {
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];
    return videoExtensions.includes(this.getExtension());
  }

  public getDisplayName(): string {
    if (this.info.title) {
      return this.info.title;
    }

    let name = this.info.showName;
    if (this.info.season && this.info.episode) {
      name += ` S${String(this.info.season).padStart(2, '0')}E${String(this.info.episode).padStart(2, '0')}`;
    }
    return name;
  }

  public getDurationFormatted(): string {
    const hours = Math.floor(this.metadata.duration / 3600);
    const minutes = Math.floor((this.metadata.duration % 3600) / 60);
    const seconds = Math.floor(this.metadata.duration % 60);

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  public getFileSizeFormatted(): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = this.metadata.fileSize;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  // Serialization
  public toJSON() {
    return {
      id: this.id,
      path: this.path,
      filename: this.filename,
      metadata: this.metadata,
      info: this.info,
      addedAt: this.addedAt.toISOString(),
    };
  }

  public static fromJSON(data: ReturnType<MediaFile['toJSON']>): MediaFile {
    return new MediaFile(
      data.path,
      data.metadata,
      data.info,
      data.id,
      new Date(data.addedAt)
    );
  }
}
