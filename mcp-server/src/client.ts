/**
 * API Client for HLS Streaming Server
 * Handles all HTTP communication with the streaming server
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export class HLSStreamingClient {
  private baseUrl: string;
  private apiKey?: string;
  private sessionToken?: string;

  constructor(baseUrl: string, apiKey?: string, sessionToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.sessionToken = sessionToken;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    // Add authentication
    if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json() as ApiResponse<T>;
      return data;
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  // Authentication
  async login(username: string, password: string): Promise<ApiResponse> {
    return this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  async checkSetupRequired(): Promise<ApiResponse<{ setupRequired: boolean }>> {
    return this.request('/api/auth/setup-required');
  }

  // Channels
  async listChannels(): Promise<ApiResponse> {
    return this.request('/api/channels');
  }

  async getChannel(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}`);
  }

  async createChannel(data: any): Promise<ApiResponse> {
    return this.request('/api/channels', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateChannel(channelId: string, data: any): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteChannel(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}`, {
      method: 'DELETE',
    });
  }

  async startChannel(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}/start`, {
      method: 'POST',
    });
  }

  async stopChannel(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}/stop`, {
      method: 'POST',
    });
  }

  async restartChannel(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}/restart`, {
      method: 'POST',
    });
  }

  async skipToNext(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}/next`, {
      method: 'POST',
    });
  }

  async getChannelMedia(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/channels/${channelId}/media`);
  }

  // Libraries
  async listLibraries(params?: { enabled?: boolean; category?: string }): Promise<ApiResponse> {
    const query = new URLSearchParams();
    if (params?.enabled !== undefined) query.append('enabled', String(params.enabled));
    if (params?.category) query.append('category', params.category);

    const queryString = query.toString();
    return this.request(`/api/libraries${queryString ? '?' + queryString : ''}`);
  }

  async createLibrary(data: any): Promise<ApiResponse> {
    return this.request('/api/libraries', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async scanLibrary(libraryId: string): Promise<ApiResponse> {
    return this.request(`/api/libraries/${libraryId}/scan`, {
      method: 'POST',
    });
  }

  async scanAllLibraries(): Promise<ApiResponse> {
    return this.request('/api/libraries/scan-all', {
      method: 'POST',
    });
  }

  async deleteLibrary(libraryId: string, deleteMedia: boolean = false): Promise<ApiResponse> {
    const query = deleteMedia ? '?deleteMedia=true' : '';
    return this.request(`/api/libraries/${libraryId}${query}`, {
      method: 'DELETE',
    });
  }

  async getLibraryStats(libraryId: string): Promise<ApiResponse> {
    return this.request(`/api/libraries/${libraryId}/stats`);
  }

  // Buckets
  async listBuckets(type?: 'global' | 'channel_specific'): Promise<ApiResponse> {
    const query = type ? `?type=${type}` : '';
    return this.request(`/api/buckets${query}`);
  }

  async createBucket(data: any): Promise<ApiResponse> {
    return this.request('/api/buckets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getBucket(bucketId: string): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}`);
  }

  async updateBucket(bucketId: string, data: any): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteBucket(bucketId: string): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}`, {
      method: 'DELETE',
    });
  }

  async addMediaToBucket(bucketId: string, mediaFileIds: string[]): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}/media`, {
      method: 'POST',
      body: JSON.stringify({ mediaFileIds }),
    });
  }

  async assignBucketToChannel(bucketId: string, channelId: string, priority: number): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}/channels/${channelId}`, {
      method: 'POST',
      body: JSON.stringify({ priority }),
    });
  }

  async assignLibraryToBucket(bucketId: string, libraryFolderId: string): Promise<ApiResponse> {
    return this.request(`/api/buckets/${bucketId}/libraries`, {
      method: 'POST',
      body: JSON.stringify({ libraryFolderId }),
    });
  }

  // Schedule Blocks
  async listScheduleBlocks(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/schedules/channels/${channelId}/blocks`);
  }

  async createScheduleBlock(channelId: string, data: any): Promise<ApiResponse> {
    return this.request(`/api/schedules/channels/${channelId}/blocks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateScheduleBlock(channelId: string, blockId: string, data: any): Promise<ApiResponse> {
    return this.request(`/api/schedules/channels/${channelId}/blocks/${blockId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteScheduleBlock(channelId: string, blockId: string): Promise<ApiResponse> {
    return this.request(`/api/schedules/channels/${channelId}/blocks/${blockId}`, {
      method: 'DELETE',
    });
  }

  // Media Search
  async searchMedia(params: {
    search?: string;
    category?: string;
    libraryId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse> {
    const query = new URLSearchParams();
    if (params.search) query.append('search', params.search);
    if (params.category) query.append('category', params.category);
    if (params.libraryId) query.append('libraryId', params.libraryId);
    if (params.limit) query.append('limit', String(params.limit));
    if (params.offset) query.append('offset', String(params.offset));

    const queryString = query.toString();
    return this.request(`/api/media${queryString ? '?' + queryString : ''}`);
  }

  async listSeries(): Promise<ApiResponse> {
    return this.request('/api/media/series');
  }

  async getSeries(seriesName: string): Promise<ApiResponse> {
    return this.request(`/api/media/series/${encodeURIComponent(seriesName)}`);
  }

  // EPG
  async getCurrentProgram(slug: string): Promise<ApiResponse> {
    return this.request(`/api/epg/channels/${slug}/current`);
  }

  async regenerateEPG(channelId: string): Promise<ApiResponse> {
    return this.request(`/api/epg/channels/${channelId}/regenerate`, {
      method: 'POST',
    });
  }

  async refreshAllEPG(): Promise<ApiResponse> {
    return this.request('/api/epg/refresh', {
      method: 'POST',
    });
  }

  // Health
  async getHealth(): Promise<ApiResponse> {
    return this.request('/health');
  }
}
