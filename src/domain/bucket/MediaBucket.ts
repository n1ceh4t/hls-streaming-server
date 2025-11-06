/**
 * Media Bucket Domain Model
 * Represents an organized collection of media files (shows, movies, etc.)
 */

export type BucketType = 'global' | 'channel_specific';

export interface MediaBucketConfig {
  id?: string;
  name: string;
  bucketType: BucketType;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class MediaBucket {
  private readonly id: string;
  private name: string;
  private bucketType: BucketType;
  private description: string | undefined;
  private readonly createdAt: Date;
  private updatedAt: Date;

  constructor(config: MediaBucketConfig) {
    this.id = config.id || '';
    this.name = config.name;
    this.bucketType = config.bucketType;
    this.description = config.description;
    this.createdAt = config.createdAt || new Date();
    this.updatedAt = config.updatedAt || new Date();
  }

  // Getters
  public getId(): string {
    return this.id;
  }

  public getName(): string {
    return this.name;
  }

  public getBucketType(): BucketType {
    return this.bucketType;
  }

  public getDescription(): string | undefined {
    return this.description;
  }

  public getCreatedAt(): Date {
    return this.createdAt;
  }

  public getUpdatedAt(): Date {
    return this.updatedAt;
  }

  // Mutations
  public updateName(name: string): void {
    this.name = name;
    this.updatedAt = new Date();
  }

  public updateDescription(description: string | undefined): void {
    this.description = description;
    this.updatedAt = new Date();
  }

  // Business logic
  public isGlobal(): boolean {
    return this.bucketType === 'global';
  }

  public isChannelSpecific(): boolean {
    return this.bucketType === 'channel_specific';
  }

  // Serialization
  public toJSON() {
    return {
      id: this.id,
      name: this.name,
      bucketType: this.bucketType,
      description: this.description,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  public static fromDatabase(row: any): MediaBucket {
    return new MediaBucket({
      id: row.id,
      name: row.name,
      bucketType: row.bucket_type,
      description: row.description,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
}
