#!/usr/bin/env node

/**
 * HLS Streaming Server MCP Server
 * Enables AI assistants to manage channels, libraries, and playlists
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HLSStreamingClient } from './client.js';
import { config } from './config.js';

// Initialize the MCP server
const server = new Server(
  {
    name: 'hls-streaming-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize the HLS client
const client = new HLSStreamingClient(
  config.serverUrl,
  config.apiKey,
  config.sessionToken
);

// Define available tools
const tools: Tool[] = [
  // === CHANNEL MANAGEMENT ===
  {
    name: 'list_channels',
    description: 'List all streaming channels with their current status and configuration',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_channel',
    description: 'Get detailed information about a specific channel including virtual time, current media, and playback status',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'UUID of the channel',
        },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'create_channel',
    description: 'Create a new streaming channel with specified configuration',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
        slug: { type: 'string', description: 'URL-safe identifier (alphanumeric and hyphens only)' },
        videoBitrate: { type: 'number', description: 'Video bitrate in bits/second (default: 1500000)' },
        audioBitrate: { type: 'number', description: 'Audio bitrate in bits/second (default: 128000)' },
        resolution: { type: 'string', description: 'Video resolution e.g. "1920x1080" (default: 1920x1080)' },
        fps: { type: 'number', description: 'Frames per second (default: 30)' },
        segmentDuration: { type: 'number', description: 'HLS segment duration in seconds (default: 6)' },
        autoStart: { type: 'boolean', description: 'Auto-start streaming on creation (default: false)' },
        useDynamicPlaylist: { type: 'boolean', description: 'Use schedule blocks for dynamic playlists (default: false)' },
        includeBumpers: { type: 'boolean', description: 'Include commercial bumpers (default: false)' },
      },
      required: ['name', 'slug'],
    },
  },
  {
    name: 'update_channel',
    description: 'Update channel settings',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
        useDynamicPlaylist: { type: 'boolean', description: 'Enable/disable dynamic playlists' },
        includeBumpers: { type: 'boolean', description: 'Enable/disable bumpers' },
        autoStart: { type: 'boolean', description: 'Enable/disable auto-start' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Delete a channel permanently',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'start_channel',
    description: 'Start streaming on a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'stop_channel',
    description: 'Stop streaming on a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'restart_channel',
    description: 'Restart a channel (stops and starts streaming)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'skip_to_next',
    description: 'Skip to the next media file in the channel playlist',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'get_channel_media',
    description: 'Get the current playlist for a channel (respects dynamic/static mode)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },

  // === LIBRARY MANAGEMENT ===
  {
    name: 'list_libraries',
    description: 'List all media library folders',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Filter by enabled status' },
        category: {
          type: 'string',
          description: 'Filter by category: movies, series, anime, sports, music, documentaries, standup, general',
          enum: ['movies', 'series', 'anime', 'sports', 'music', 'documentaries', 'standup', 'general'],
        },
      },
    },
  },
  {
    name: 'create_library',
    description: 'Create a new media library folder',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Library name' },
        path: { type: 'string', description: 'Filesystem path to media folder' },
        category: {
          type: 'string',
          description: 'Category type',
          enum: ['movies', 'series', 'anime', 'sports', 'music', 'documentaries', 'standup', 'general'],
        },
        enabled: { type: 'boolean', description: 'Enable library (default: true)' },
        recursive: { type: 'boolean', description: 'Scan subdirectories recursively (default: true)' },
      },
      required: ['name', 'path', 'category'],
    },
  },
  {
    name: 'scan_library',
    description: 'Scan a specific library for media files',
    inputSchema: {
      type: 'object',
      properties: {
        libraryId: { type: 'string', description: 'UUID of the library' },
      },
      required: ['libraryId'],
    },
  },
  {
    name: 'scan_all_libraries',
    description: 'Scan all enabled libraries for new media files',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'delete_library',
    description: 'Delete a library folder',
    inputSchema: {
      type: 'object',
      properties: {
        libraryId: { type: 'string', description: 'UUID of the library' },
        deleteMedia: { type: 'boolean', description: 'Also delete associated media records (default: false)' },
      },
      required: ['libraryId'],
    },
  },
  {
    name: 'get_library_stats',
    description: 'Get statistics for a library (file count, total duration, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        libraryId: { type: 'string', description: 'UUID of the library' },
      },
      required: ['libraryId'],
    },
  },

  // === BUCKET MANAGEMENT ===
  {
    name: 'list_buckets',
    description: 'List all media buckets (logical collections)',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by bucket type',
          enum: ['global', 'channel_specific'],
        },
      },
    },
  },
  {
    name: 'create_bucket',
    description: 'Create a new media bucket',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bucket name' },
        bucketType: {
          type: 'string',
          description: 'Bucket type',
          enum: ['global', 'channel_specific'],
        },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['name', 'bucketType'],
    },
  },
  {
    name: 'get_bucket',
    description: 'Get bucket details',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
      },
      required: ['bucketId'],
    },
  },
  {
    name: 'update_bucket',
    description: 'Update bucket information',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['bucketId'],
    },
  },
  {
    name: 'delete_bucket',
    description: 'Delete a bucket',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
      },
      required: ['bucketId'],
    },
  },
  {
    name: 'add_media_to_bucket',
    description: 'Add media files to a bucket',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
        mediaFileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of media file UUIDs',
        },
      },
      required: ['bucketId', 'mediaFileIds'],
    },
  },
  {
    name: 'assign_bucket_to_channel',
    description: 'Assign a bucket to a channel with priority',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
        channelId: { type: 'string', description: 'UUID of the channel' },
        priority: { type: 'number', description: 'Priority order (higher = more important)' },
      },
      required: ['bucketId', 'channelId', 'priority'],
    },
  },
  {
    name: 'assign_library_to_bucket',
    description: 'Assign an entire library to a bucket (auto-adds all media from library)',
    inputSchema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string', description: 'UUID of the bucket' },
        libraryFolderId: { type: 'string', description: 'UUID of the library' },
      },
      required: ['bucketId', 'libraryFolderId'],
    },
  },

  // === SCHEDULE BLOCKS ===
  {
    name: 'list_schedule_blocks',
    description: 'List all schedule blocks for a channel (for dynamic playlists)',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'create_schedule_block',
    description: 'Create a time-based schedule block for dynamic playlists',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
        name: { type: 'string', description: 'Block name' },
        dayOfWeek: {
          type: 'array',
          items: { type: 'number', minimum: 0, maximum: 6 },
          description: 'Days of week (0=Sunday, 6=Saturday), null for all days',
        },
        startTime: { type: 'string', description: 'Start time in HH:MM:SS format (24hr)' },
        endTime: { type: 'string', description: 'End time in HH:MM:SS format (24hr)' },
        bucketId: { type: 'string', description: 'UUID of bucket to use for this block' },
        playbackMode: {
          type: 'string',
          enum: ['sequential', 'random', 'shuffle'],
          description: 'How to play media from bucket',
        },
        priority: { type: 'number', description: 'Priority for overlapping blocks (higher = more important)' },
        enabled: { type: 'boolean', description: 'Enable this block (default: true)' },
      },
      required: ['channelId', 'name', 'startTime', 'endTime', 'bucketId', 'playbackMode', 'priority'],
    },
  },
  {
    name: 'update_schedule_block',
    description: 'Update a schedule block',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
        blockId: { type: 'string', description: 'UUID of the schedule block' },
        name: { type: 'string' },
        dayOfWeek: { type: 'array', items: { type: 'number' } },
        startTime: { type: 'string' },
        endTime: { type: 'string' },
        bucketId: { type: 'string' },
        playbackMode: { type: 'string', enum: ['sequential', 'random', 'shuffle'] },
        priority: { type: 'number' },
        enabled: { type: 'boolean' },
      },
      required: ['channelId', 'blockId'],
    },
  },
  {
    name: 'delete_schedule_block',
    description: 'Delete a schedule block',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
        blockId: { type: 'string', description: 'UUID of the schedule block' },
      },
      required: ['channelId', 'blockId'],
    },
  },

  // === MEDIA SEARCH ===
  {
    name: 'search_media',
    description: 'Search for media files across all libraries',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term for filename/show name' },
        category: { type: 'string', description: 'Filter by category' },
        libraryId: { type: 'string', description: 'Filter by library UUID' },
        limit: { type: 'number', description: 'Maximum results (default: 50)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      },
    },
  },
  {
    name: 'list_series',
    description: 'List all TV series available in the media library',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_series',
    description: 'Get all seasons and episodes for a specific TV series',
    inputSchema: {
      type: 'object',
      properties: {
        seriesName: { type: 'string', description: 'Name of the series' },
      },
      required: ['seriesName'],
    },
  },

  // === EPG (Electronic Program Guide) ===
  {
    name: 'get_current_program',
    description: 'Get the current and next program for a channel',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Channel slug' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'regenerate_epg',
    description: 'Regenerate EPG data for a specific channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'UUID of the channel' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'refresh_all_epg',
    description: 'Refresh EPG data for all channels',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // === SYSTEM ===
  {
    name: 'get_health',
    description: 'Check server health and status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// Handle tool list requests
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;

    switch (name) {
      // Channel operations
      case 'list_channels':
        result = await client.listChannels();
        break;
      case 'get_channel':
        result = await client.getChannel((args?.channelId as string) || '');
        break;
      case 'create_channel':
        result = await client.createChannel(args || {});
        break;
      case 'update_channel':
        result = await client.updateChannel((args?.channelId as string) || '', args || {});
        break;
      case 'delete_channel':
        result = await client.deleteChannel((args?.channelId as string) || '');
        break;
      case 'start_channel':
        result = await client.startChannel((args?.channelId as string) || '');
        break;
      case 'stop_channel':
        result = await client.stopChannel((args?.channelId as string) || '');
        break;
      case 'restart_channel':
        result = await client.restartChannel((args?.channelId as string) || '');
        break;
      case 'skip_to_next':
        result = await client.skipToNext((args?.channelId as string) || '');
        break;
      case 'get_channel_media':
        result = await client.getChannelMedia((args?.channelId as string) || '');
        break;

      // Library operations
      case 'list_libraries':
        result = await client.listLibraries(args as any);
        break;
      case 'create_library':
        result = await client.createLibrary(args || {});
        break;
      case 'scan_library':
        result = await client.scanLibrary((args?.libraryId as string) || '');
        break;
      case 'scan_all_libraries':
        result = await client.scanAllLibraries();
        break;
      case 'delete_library':
        result = await client.deleteLibrary((args?.libraryId as string) || '', (args?.deleteMedia as boolean) || false);
        break;
      case 'get_library_stats':
        result = await client.getLibraryStats((args?.libraryId as string) || '');
        break;

      // Bucket operations
      case 'list_buckets':
        result = await client.listBuckets((args?.type as any) || undefined);
        break;
      case 'create_bucket':
        result = await client.createBucket(args || {});
        break;
      case 'get_bucket':
        result = await client.getBucket((args?.bucketId as string) || '');
        break;
      case 'update_bucket':
        result = await client.updateBucket((args?.bucketId as string) || '', args || {});
        break;
      case 'delete_bucket':
        result = await client.deleteBucket((args?.bucketId as string) || '');
        break;
      case 'add_media_to_bucket':
        result = await client.addMediaToBucket((args?.bucketId as string) || '', (args?.mediaFileIds as string[]) || []);
        break;
      case 'assign_bucket_to_channel':
        result = await client.assignBucketToChannel(
          (args?.bucketId as string) || '',
          (args?.channelId as string) || '',
          (args?.priority as number) || 0
        );
        break;
      case 'assign_library_to_bucket':
        result = await client.assignLibraryToBucket((args?.bucketId as string) || '', (args?.libraryFolderId as string) || '');
        break;

      // Schedule operations
      case 'list_schedule_blocks':
        result = await client.listScheduleBlocks((args?.channelId as string) || '');
        break;
      case 'create_schedule_block':
        result = await client.createScheduleBlock((args?.channelId as string) || '', args || {});
        break;
      case 'update_schedule_block':
        result = await client.updateScheduleBlock(
          (args?.channelId as string) || '',
          (args?.blockId as string) || '',
          args || {}
        );
        break;
      case 'delete_schedule_block':
        result = await client.deleteScheduleBlock((args?.channelId as string) || '', (args?.blockId as string) || '');
        break;

      // Media search
      case 'search_media':
        result = await client.searchMedia(args as any);
        break;
      case 'list_series':
        result = await client.listSeries();
        break;
      case 'get_series':
        result = await client.getSeries((args?.seriesName as string) || '');
        break;

      // EPG
      case 'get_current_program':
        result = await client.getCurrentProgram((args?.slug as string) || '');
        break;
      case 'regenerate_epg':
        result = await client.regenerateEPG((args?.channelId as string) || '');
        break;
      case 'refresh_all_epg':
        result = await client.refreshAllEPG();
        break;

      // System
      case 'get_health':
        result = await client.getHealth();
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: {
              code: 'TOOL_EXECUTION_ERROR',
              message: error instanceof Error ? error.message : 'Unknown error',
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('HLS Streaming MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
