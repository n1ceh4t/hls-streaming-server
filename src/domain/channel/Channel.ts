import { v4 as uuidv4 } from 'uuid';

export enum ChannelState {
  IDLE = 'idle',
  STARTING = 'starting',
  STREAMING = 'streaming',
  STOPPING = 'stopping',
  ERROR = 'error',
}

export interface ChannelConfig {
  name: string;
  slug: string;
  outputDir: string;
  videoBitrate: number;
  audioBitrate: number;
  resolution: string;
  fps: number;
  segmentDuration: number;
  autoStart?: boolean;
  /** Enable dynamic playlist resolution (schedule-based, overrides, etc.) */
  useDynamicPlaylist?: boolean;
  /** Include bumpers between files (default: true for backward compatibility) */
  includeBumpers?: boolean;
  /** Watermark image stored as base64 encoded PNG */
  watermarkImageBase64?: string;
  /** Watermark position on the video */
  watermarkPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
}

export interface ChannelMetadata {
  currentIndex: number;
  accumulatedTime: number;
  viewerCount: number;
  startedAt?: Date;
  lastError?: string;
  lastErrorAt?: Date;
}

/**
 * Channel aggregate - represents a streaming channel
 */
export class Channel {
  public readonly id: string;
  private state: ChannelState;
  private metadata: ChannelMetadata;

  constructor(
    public readonly config: ChannelConfig,
    id?: string,
    state?: ChannelState,
    metadata?: Partial<ChannelMetadata>
  ) {
    this.id = id || uuidv4();
    this.state = state || ChannelState.IDLE;
    this.metadata = {
      currentIndex: 0,
      accumulatedTime: 0,
      viewerCount: 0,
      ...metadata,
    };
  }

  // State machine methods
  public canTransitionTo(newState: ChannelState): boolean {
    const validTransitions: Record<ChannelState, ChannelState[]> = {
      [ChannelState.IDLE]: [ChannelState.STARTING],
      [ChannelState.STARTING]: [ChannelState.STREAMING, ChannelState.ERROR, ChannelState.IDLE],
      [ChannelState.STREAMING]: [ChannelState.STOPPING, ChannelState.ERROR],
      [ChannelState.STOPPING]: [ChannelState.IDLE, ChannelState.ERROR],
      [ChannelState.ERROR]: [ChannelState.IDLE, ChannelState.STARTING],
    };

    return validTransitions[this.state].includes(newState);
  }

  public transitionTo(newState: ChannelState): void {
    if (!this.canTransitionTo(newState)) {
      throw new Error(
        `Invalid state transition: ${this.state} -> ${newState} for channel ${this.id}`
      );
    }
    this.state = newState;

    // Update metadata based on state
    if (newState === ChannelState.STREAMING) {
      this.metadata.startedAt = new Date();
    }
  }

  // Getters
  public getState(): ChannelState {
    return this.state;
  }

  public getMetadata(): Readonly<ChannelMetadata> {
    return { ...this.metadata };
  }

  public isStreaming(): boolean {
    return this.state === ChannelState.STREAMING;
  }

  public isIdle(): boolean {
    return this.state === ChannelState.IDLE;
  }

  // Metadata updates
  public updateCurrentIndex(index: number): void {
    this.metadata.currentIndex = index;
  }

  public updateAccumulatedTime(time: number): void {
    this.metadata.accumulatedTime = time;
  }

  public incrementViewerCount(): void {
    this.metadata.viewerCount++;
  }

  public decrementViewerCount(): void {
    this.metadata.viewerCount = Math.max(0, this.metadata.viewerCount - 1);
  }

  public setError(error: string): void {
    this.metadata.lastError = error;
    this.metadata.lastErrorAt = new Date();
    this.state = ChannelState.ERROR;
  }

  public clearError(): void {
    this.metadata.lastError = undefined;
    this.metadata.lastErrorAt = undefined;
  }

  // Serialization
  public toJSON() {
    return {
      id: this.id,
      config: this.config,
      state: this.state,
      metadata: this.metadata,
    };
  }

  public static fromJSON(data: ReturnType<Channel['toJSON']>): Channel {
    return new Channel(data.config, data.id, data.state, data.metadata);
  }
}
