/**
 * Library Folder Domain Model
 * Represents a media library location (like Jellyfin libraries)
 */

export type LibraryCategory = 'movies' | 'series' | 'anime' | 'sports' | 'music' | 'documentaries' | 'standup' | 'general';

export interface LibraryFolderConfig {
  id?: string;
  name: string;
  path: string;
  category: LibraryCategory;
  enabled?: boolean;
  recursive?: boolean;
  lastScanAt?: Date;
  lastScanDurationMs?: number;
  lastScanFileCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class LibraryFolder {
  private readonly id: string;
  private name: string;
  private path: string;
  private category: LibraryCategory;
  private enabled: boolean;
  private recursive: boolean;
  private lastScanAt: Date | undefined;
  private lastScanDurationMs: number | undefined;
  private lastScanFileCount: number;
  private readonly createdAt: Date;
  private updatedAt: Date;

  constructor(config: LibraryFolderConfig) {
    this.id = config.id || '';
    this.name = config.name;
    this.path = config.path;
    this.category = config.category;
    this.enabled = config.enabled !== false;
    this.recursive = config.recursive !== false;
    this.lastScanAt = config.lastScanAt;
    this.lastScanDurationMs = config.lastScanDurationMs;
    this.lastScanFileCount = config.lastScanFileCount || 0;
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

  public getPath(): string {
    return this.path;
  }

  public getCategory(): LibraryCategory {
    return this.category;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public isRecursive(): boolean {
    return this.recursive;
  }

  public getLastScanAt(): Date | undefined {
    return this.lastScanAt;
  }

  public getLastScanDurationMs(): number | undefined {
    return this.lastScanDurationMs;
  }

  public getLastScanFileCount(): number {
    return this.lastScanFileCount;
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

  public updatePath(path: string): void {
    this.path = path;
    this.updatedAt = new Date();
  }

  public updateCategory(category: LibraryCategory): void {
    this.category = category;
    this.updatedAt = new Date();
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.updatedAt = new Date();
  }

  public setRecursive(recursive: boolean): void {
    this.recursive = recursive;
    this.updatedAt = new Date();
  }

  public recordScan(durationMs: number, fileCount: number): void {
    this.lastScanAt = new Date();
    this.lastScanDurationMs = durationMs;
    this.lastScanFileCount = fileCount;
    this.updatedAt = new Date();
  }

  // Serialization
  public toJSON() {
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      category: this.category,
      enabled: this.enabled,
      recursive: this.recursive,
      lastScanAt: this.lastScanAt?.toISOString(),
      lastScanDurationMs: this.lastScanDurationMs,
      lastScanFileCount: this.lastScanFileCount,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  public static fromDatabase(row: any): LibraryFolder {
    return new LibraryFolder({
      id: row.id,
      name: row.name,
      path: row.path,
      category: row.category,
      enabled: row.enabled,
      recursive: row.recursive,
      lastScanAt: row.last_scan_at ? new Date(row.last_scan_at) : undefined,
      lastScanDurationMs: row.last_scan_duration_ms,
      lastScanFileCount: row.last_scan_file_count,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
}
