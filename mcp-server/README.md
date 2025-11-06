# HLS Streaming Server MCP Tool

Model Context Protocol (MCP) server for managing HLS streaming channels, media libraries, and dynamic playlists through AI assistants like Claude.

## Overview

This MCP server exposes the complete HLS Streaming Server API as tools that AI assistants can use to:

- **Manage Channels**: Create, configure, start/stop streaming channels
- **Organize Media**: Scan libraries, create buckets, assign content
- **Schedule Programming**: Build time-based dynamic playlists
- **Monitor Streaming**: Check channel status, current programs, EPG data
- **Control Playback**: Skip to next, restart channels, adjust settings

## Architecture

```
┌─────────────────┐
│  Claude / AI    │
│   Assistant     │
└────────┬────────┘
         │ MCP Protocol
         │
┌────────▼────────┐
│  MCP Server     │
│  (This Tool)    │
└────────┬────────┘
         │ HTTP REST API
         │
┌────────▼────────┐
│ HLS Streaming   │
│     Server      │
└─────────────────┘
```

## Installation

### Option 1: Local Installation

#### 1. Install Dependencies

```bash
cd mcp-server
npm install
npm run build
```

#### 2. Configure Environment

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required: Your HLS streaming server URL
HLS_SERVER_URL=http://localhost:8080

# Authentication (choose one method)
# Option 1: API Key (legacy)
HLS_API_KEY=your-api-key-here

# Option 2: Session Token (modern - preferred)
# Leave empty to use API key
HLS_SESSION_TOKEN=

# Option 3: Auto-login with credentials (will obtain session token)
# Leave empty if using API key or session token
HLS_USERNAME=admin
HLS_PASSWORD=your-password

# Debug logging
DEBUG=false
```

#### 3. Configure Claude Desktop

Add to your Claude Desktop configuration:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hls-streaming": {
      "command": "node",
      "args": ["/absolute/path/to/hls-streaming-server/mcp-server/dist/index.js"],
      "env": {
        "HLS_SERVER_URL": "http://localhost:8080",
        "HLS_API_KEY": "your-api-key"
      }
    }
  }
}
```

#### 4. Restart Claude Desktop

The MCP server will be available as tools in Claude.

**Note:** MCP servers run directly via stdio with MCP clients (like Claude Desktop), not as standalone Docker containers. They are launched by the MCP client process itself.

## Available Tools

### Channel Management (10 tools)
- `list_channels` - List all streaming channels
- `get_channel` - Get channel details with virtual time
- `create_channel` - Create new channel
- `update_channel` - Update channel settings
- `delete_channel` - Delete channel
- `start_channel` - Start streaming
- `stop_channel` - Stop streaming
- `restart_channel` - Restart channel
- `skip_to_next` - Skip to next media
- `get_channel_media` - Get channel playlist

### Library Management (6 tools)
- `list_libraries` - List all library folders
- `create_library` - Create new library
- `scan_library` - Scan specific library
- `scan_all_libraries` - Scan all enabled libraries
- `delete_library` - Delete library
- `get_library_stats` - Get library statistics

### Bucket Management (8 tools)
- `list_buckets` - List all buckets
- `create_bucket` - Create new bucket
- `get_bucket` - Get bucket details
- `update_bucket` - Update bucket
- `delete_bucket` - Delete bucket
- `add_media_to_bucket` - Add media files to bucket
- `assign_bucket_to_channel` - Link bucket to channel
- `assign_library_to_bucket` - Link library to bucket

### Schedule Management (4 tools)
- `list_schedule_blocks` - List schedule blocks
- `create_schedule_block` - Create time-based block
- `update_schedule_block` - Update schedule block
- `delete_schedule_block` - Delete schedule block

### Media Search (3 tools)
- `search_media` - Search across all media
- `list_series` - List all TV series
- `get_series` - Get series with seasons/episodes

### EPG Management (3 tools)
- `get_current_program` - Get current/next program
- `regenerate_epg` - Regenerate channel EPG
- `refresh_all_epg` - Refresh all EPG data

### System (1 tool)
- `get_health` - Check server health

**Total: 35 tools** covering the complete API surface

## Usage Examples

### Example 1: Basic Channel Setup

**User Prompt:**
> "Create a new channel called 'Comedy Central' with slug 'comedy' and start it streaming"

**Claude Actions:**
1. Calls `create_channel` with name and slug
2. Calls `start_channel` with the returned channel ID
3. Calls `get_channel` to verify it's streaming

### Example 2: Library Setup

**User Prompt:**
> "Add my movies folder at /media/movies as a library and scan it"

**Claude Actions:**
1. Calls `create_library` with path and category 'movies'
2. Calls `scan_library` with the returned library ID
3. Reports scan results (files found, duration, etc.)

### Example 3: Build a 24/7 Channel

**User Prompt:**
> "Create a 24/7 sitcom channel. Play Friends from 8am-12pm on weekdays, The Office from 12pm-6pm daily, and Seinfeld from 6pm-11pm"

**Claude Actions:**
1. Calls `create_channel` with `useDynamicPlaylist: true`
2. Calls `search_media` to find Friends episodes
3. Calls `create_bucket` for each show
4. Calls `add_media_to_bucket` for each bucket
5. Calls `create_schedule_block` three times:
   - Friends: Mon-Fri, 08:00-12:00
   - The Office: All days, 12:00-18:00
   - Seinfeld: All days, 18:00-23:00
6. Calls `start_channel`

### Example 4: Monitor Current Programming

**User Prompt:**
> "What's currently playing on all my channels?"

**Claude Actions:**
1. Calls `list_channels`
2. For each channel, calls `get_current_program` with the slug
3. Summarizes what's playing now and what's next

### Example 5: Quick Content Search

**User Prompt:**
> "Find all Star Wars movies and add them to a bucket called 'Star Wars Marathon'"

**Claude Actions:**
1. Calls `search_media` with search term "star wars"
2. Filters results to movies category
3. Calls `create_bucket` with name "Star Wars Marathon"
4. Calls `add_media_to_bucket` with all found media IDs

## Sample Prompts

### Channel Management
```
"Create a sports channel streaming at 720p with 2Mbps bitrate"

"List all my channels and show which ones are currently streaming"

"Stop the 'comedy' channel and restart it"

"Skip to the next episode on my sitcom channel"

"What's currently playing on my movie channel?"
```

### Library & Media
```
"Scan my entire media library for new files"

"Create a library for my anime folder at /media/anime"

"Show me all episodes of Breaking Bad organized by season"

"Find all movies in the action category"

"What are my library statistics?"
```

### Schedule & Programming
```
"Set up morning cartoons from 6am-9am on weekends"

"Create a prime-time block with drama shows from 8pm-11pm"

"Show me the schedule blocks for my main channel"

"Change the kids channel to play different content on weekdays vs weekends"

"Build a 24/7 news channel that loops the same content"
```

### Organization
```
"Create a bucket called 'Classic Movies' and add all movies from before 1990"

"Assign my 'Sitcoms' library to the comedy channel"

"Organize my content into buckets by genre"

"Link the 'Action Movies' bucket to my movie channel with high priority"

"Show me what buckets are assigned to the sports channel"
```

### EPG & IPTV
```
"Regenerate the EPG data for all channels"

"What's playing right now and what's coming next on each channel?"

"Give me the IPTV playlist URL"

"Refresh the program guide"
```

## Advanced Use Cases

### Use Case 1: Automated Content Curator

**Scenario:** Build an AI assistant that automatically organizes your media library

**Prompt:**
> "Analyze my entire media library and create themed buckets. Group content by: genre, decade, mood (action-packed, relaxing, comedy), and holiday themes. Then create suggested channel schedules based on typical viewer patterns."

**What Claude Does:**
1. Scans all libraries
2. Uses `search_media` extensively
3. Creates buckets based on metadata patterns
4. Generates schedule blocks for peak viewing times
5. Provides a complete programming strategy

### Use Case 2: Smart Channel Scheduler

**Scenario:** Dynamic programming based on time of day and day of week

**Prompt:**
> "Create a family-friendly channel with this schedule:
> - Weekday mornings (6am-9am): Kids cartoons
> - Weekday afternoons (3pm-6pm): Teen shows
> - Weekday evenings (8pm-10pm): Family movies
> - Weekend mornings (8am-12pm): Kids movies
> - Weekend evenings (7pm-11pm): Blockbuster movies"

**Claude Creates:**
- 5 different buckets for each content type
- 5 schedule blocks with appropriate day/time settings
- Configures priorities for overlapping times
- Enables dynamic playlist mode

### Use Case 3: Series Marathon Manager

**Scenario:** Set up binge-watching marathons

**Prompt:**
> "Create a Marvel Cinematic Universe marathon channel. Play all movies in chronological order, then restart. Also create a 'Best Episodes' channel with the top-rated episodes from Breaking Bad, Game of Thrones, and The Sopranos."

**Claude Creates:**
- Searches for all Marvel movies
- Creates ordered bucket with correct sequence
- Sets up sequential playback
- Creates second channel with curated episodes
- Configures both to loop infinitely

### Use Case 4: Live Sports Rotation

**Scenario:** Manage sports content library

**Prompt:**
> "Set up a sports channel that plays NBA games during basketball season (Oct-Apr) and NFL games during football season (Sep-Feb). Fill other times with classic games."

**Claude Creates:**
- Multiple buckets for different sports
- Schedule blocks with seasonal timing
- Fallback content for off-season
- Priority system for live vs classic content

### Use Case 5: Music Video Channel

**Scenario:** MTV-style music channel

**Prompt:**
> "Build a music video channel that plays different genres throughout the day: EDM in the morning (6am-10am), Pop during midday (10am-4pm), Rock in the afternoon (4pm-8pm), and Hip-Hop at night (8pm-2am)."

**Claude Creates:**
- Genre-based buckets from music library
- Time-of-day schedule blocks
- Shuffle playback mode for variety
- Smooth transitions between blocks

## Expansion Opportunities

### Phase 1: Enhanced Intelligence

**1. Predictive Scheduling**
```typescript
// New tool: analyze_viewership
// Analyzes viewer sessions and suggests optimal schedule times
```

**2. Content Recommendations**
```typescript
// New tool: recommend_content
// ML-based recommendations for what to add to channels
```

**3. Automated Quality Control**
```typescript
// New tool: validate_media
// Checks media files for corruption, codec issues, etc.
```

### Phase 2: Advanced Features

**4. Playlist Templates**
```typescript
// New tools:
// - save_schedule_template
// - apply_schedule_template
// - list_templates
// Pre-configured schedule patterns (e.g., "24hr news cycle", "sitcom rotation")
```

**5. Bulk Operations**
```typescript
// New tools:
// - bulk_create_channels
// - bulk_assign_buckets
// - bulk_import_from_csv
```

**6. Analytics Integration**
```typescript
// New tools:
// - get_channel_analytics
// - get_popular_content
// - get_viewer_trends
```

### Phase 3: External Integrations

**7. Metadata Enrichment**
```typescript
// New tools:
// - fetch_tmdb_metadata
// - fetch_tvdb_metadata
// - auto_enrich_library
// Integrate with TMDB/TVDB for better metadata
```

**8. Discord/Slack Notifications**
```typescript
// New tools:
// - configure_notifications
// - send_channel_alert
// Real-time alerts for channel issues
```

**9. Plex/Jellyfin Import**
```typescript
// New tools:
// - import_from_plex
// - import_from_jellyfin
// - sync_watch_history
```

### Phase 4: AI-Powered Features

**10. Natural Language Scheduling**
```typescript
// Enhanced create_schedule_block with NLP
// "Play comedies on Friday nights" → parses into schedule block
```

**11. Smart Content Matching**
```typescript
// New tool: smart_search
// "Find episodes where the main character gets married"
// Uses AI to understand plot points from descriptions
```

**12. Automated Highlight Reels**
```typescript
// New tools:
// - detect_highlights (finds exciting moments in sports)
// - create_compilation (builds custom highlight buckets)
```

### Phase 5: Multi-Server Support

**13. Distributed Channels**
```typescript
// New tools for managing multiple HLS servers:
// - list_servers
// - create_channel_on_server
// - load_balance_channels
```

**14. Content Replication**
```typescript
// New tools:
// - replicate_bucket_to_server
// - sync_libraries_between_servers
```

### Phase 6: Interactive Features

**15. Live Voting**
```typescript
// New tools:
// - create_poll (what to watch next)
// - get_poll_results
// - apply_vote_winner_to_channel
```

**16. Request System**
```typescript
// New tools:
// - submit_content_request
// - approve_request
// - add_request_to_queue
```

### Implementation Priority

**High Priority (Immediate Value):**
1. Playlist Templates (#4) - Save time on common schedules
2. Analytics Integration (#6) - Understand viewership
3. Metadata Enrichment (#7) - Better content organization

**Medium Priority (Nice to Have):**
4. Bulk Operations (#5) - Efficiency for large libraries
5. Automated Quality Control (#3) - Prevent streaming issues
6. Discord/Slack Notifications (#8) - Real-time monitoring

**Low Priority (Future Expansion):**
7. Multi-Server Support (#13, #14) - For large deployments
8. Interactive Features (#15, #16) - Community engagement
9. AI-Powered Features (#10, #11, #12) - Advanced capabilities

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev  # Watch mode with auto-rebuild
```

### Testing

```bash
# Test the MCP server directly
node dist/index.js

# It will run in stdio mode, waiting for MCP protocol messages
```

### Adding New Tools

1. Add the tool definition to `tools` array in `src/index.ts`
2. Add the API method to `HLSStreamingClient` in `src/client.ts`
3. Add the case handler in the `CallToolRequestSchema` handler
4. Rebuild with `npm run build`

## Troubleshooting

### Connection Issues

**Problem:** MCP server can't connect to HLS streaming server

**Solution:**
- Check `HLS_SERVER_URL` in your environment
- Verify the streaming server is running
- Test with curl: `curl http://localhost:8080/health`

### Authentication Failures

**Problem:** Getting 401 Unauthorized errors

**Solution:**
- Verify your `HLS_API_KEY` or `HLS_SESSION_TOKEN`
- Check the streaming server's authentication settings
- Try authenticating manually: `curl -H "X-API-Key: your-key" http://localhost:8080/api/channels`

### Claude Can't See Tools

**Problem:** MCP tools don't appear in Claude Desktop

**Solution:**
- Check Claude Desktop config file path
- Verify JSON syntax is valid
- Check Claude logs: `~/Library/Logs/Claude/mcp*.log`
- Restart Claude Desktop completely

### Tool Execution Errors

**Problem:** Tools return errors when called

**Solution:**
- Check the streaming server logs
- Verify the parameters match expected types
- Enable debug logging: `DEBUG=true` in `.env`
- Check network connectivity

## Contributing

Contributions welcome! Areas of interest:

- Additional tool implementations
- Better error handling
- Performance optimizations
- Documentation improvements
- Integration tests

## License

MIT License - See main project LICENSE file

## Resources

- [Model Context Protocol Docs](https://modelcontextprotocol.io/)
- [HLS Streaming Server API Docs](../openapi.yaml)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Claude Desktop MCP Setup Guide](https://docs.claude.com/claude/docs/mcp)
