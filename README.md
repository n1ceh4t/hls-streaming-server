# HLS Streaming Server

An HLS/IPTV streaming server for creating multi-channel streaming services from your media library.

## Features

- Multi-channel HLS streaming
- Dynamic playlists with schedule-based content switching
- Media buckets for organizing content into collections
- IPTV support with M3U playlists and XMLTV EPG generation
- Virtual time tracking for continuous playback
- Automatic media library scanning and organization
- API key and session-based authentication
- Docker deployment support

## Installation

### Prerequisites

- **Node.js 18+** and **npm 9+**
- **FFmpeg** installed and in PATH
- **PostgreSQL** (optional, for persistent state and advanced features)

### Quick Start

The fastest way to get started:

```bash
# Clone the repository
git clone <repository-url>
cd hls-streaming-server-v1.0

# Install dependencies
npm install --no-bin-links
# (Recommended: --no-bin-links avoids symlink issues on Windows/WSL/Docker)

# Run interactive setup (configures everything automatically)
npm run setup

# Build and start
npm run build
npm start
```

The interactive setup script (`npm run setup`) will guide you through:
- ? Media directory configuration
- ? API key generation
- ? Streaming quality settings
- ? Database setup (PostgreSQL)
- ? Automatic database migrations

### Installation Methods

#### Option 1: Docker

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd hls-streaming-server-v1.0
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```

3. Edit `docker-compose.yml` to mount your media directories:
   
   Open `docker-compose.yml` and update the volumes section:
   ```yaml
   volumes:
     # Mount your media directories here
     # Replace /path/to/your/media with your actual media paths
     - /media/movies:/media/movies:ro
     - /media/shows:/media/shows:ro
     - /home/user/Videos:/media/videos:ro
     
     # HLS output (persisted)
     - ./hls_output:/app/hls_output
     # Temp directory
     - ./temp:/app/temp
   ```
   
   **Important Notes:**
   - Use `:ro` (read-only) flag for media volumes to prevent accidental modifications
   - Use absolute paths on the host system (e.g., `/media/movies`, not `~/movies`)
   - On Windows, use Windows-style paths: `C:\Media\Movies:/media/movies:ro`
   - You can mount multiple directories by adding more volume entries

4. Edit `.env` file to match the mounted paths:
   ```env
   # Required: Media directories (comma-separated)
   # These paths should match the mount points inside the container
   MEDIA_DIRECTORIES=/media/movies,/media/shows,/media/videos
   
   # Required: API key (generate a secure random string)
   API_KEY=your-secure-random-api-key-here
   
   # Optional: Server port
   PORT=8080
   ```
   
   **Note:** The paths in `MEDIA_DIRECTORIES` should be the container paths (inside `/media`), not the host paths.

5. Start with Docker Compose:
   ```bash
   docker-compose up -d
   ```

6. View logs:
   ```bash
   docker-compose logs -f
   ```

**Example: Mounting Multiple Media Directories**

If you have media in different locations:
```yaml
volumes:
  - /mnt/nas/movies:/media/movies:ro
  - /mnt/nas/tv-shows:/media/shows:ro
  - /home/user/Downloads:/media/downloads:ro
  - ./hls_output:/app/hls_output
  - ./temp:/app/temp
```

Then in `.env`:
```env
MEDIA_DIRECTORIES=/media/movies,/media/shows,/media/downloads
```

#### Option 2: Local Installation

##### Quick Setup (Recommended)

The easiest way to get started is using the interactive setup script:

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd hls-streaming-server-v1.0
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```
   
   **Note:** If you encounter symlink permission errors (common on Windows or in Docker), use:
   ```bash
   npm install --no-bin-links
   ```

3. **Run interactive setup:**
   ```bash
   npm run setup
   ```
   
   This will guide you through:
   - Configuring media directories
   - Setting up API keys
   - Configuring streaming quality
   - Setting up PostgreSQL database (optional)
   - Running database migrations

4. **Build and start:**
   ```bash
   npm run build
   npm start
   ```

##### Manual Setup

If you prefer manual configuration:

1. **Clone and install:**
   ```bash
   git clone <repository-url>
   cd hls-streaming-server-v1.0
   npm install
   ```
   
   **Note:** If you encounter symlink permission errors (common on Windows, WSL, or in Docker), use:
   ```bash
   npm install --no-bin-links
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Build the application:**
   ```bash
   npm run build
   ```

4. **Run database migrations (optional):**
   ```bash
   npm run migrate
   ```
   
   **Note**: `npm run migrate` uses `migrate.sh` which works without building the application first. 
   For an alternative that uses the TypeScript Database class, use `npm run migrate:ts` (requires build first).

5. **Start the server:**
   ```bash
   npm start
   ```

   Or run in development mode with auto-reload:
   ```bash
   npm run dev
   ```

## Configuration

### Environment Configuration

The server uses a `.env` file for configuration. You can either:

1. **Use the interactive setup** (recommended for first-time setup):
   ```bash
   npm run setup
   ```

2. **Manually edit `.env`** (copy from `.env.example`)

### Essential Settings

Edit `.env` file with your configuration:

```env
# Media directories (comma-separated paths)
MEDIA_DIRECTORIES=/media/movies,/media/shows,/media/anime

# API key for authentication (generate a secure random string!)
API_KEY=your-secure-api-key-here

# Server port
PORT=8080
```

### Streaming Settings

```env
# Video quality
DEFAULT_VIDEO_BITRATE=1500000      # 1.5 Mbps
DEFAULT_AUDIO_BITRATE=128000       # 128 kbps
DEFAULT_RESOLUTION=1920x1080       # 1080p
DEFAULT_FPS=30
DEFAULT_SEGMENT_DURATION=6         # 6 seconds per segment

# Concurrent streams
MAX_CONCURRENT_STREAMS=8
```

### Hardware Acceleration

```env
# NVIDIA GPU
HW_ACCEL=nvenc

# Intel Quick Sync
HW_ACCEL=qsv

# Apple VideoToolbox (macOS)
HW_ACCEL=videotoolbox

# Software encoding (default)
HW_ACCEL=none
```

See `.env.example` for all available configuration options.

## Usage

### Access Points

Once running, access your server at:

- API: http://localhost:8080/api/channels
- Stream: http://localhost:8080/{channel-slug}/master.m3u8
- EPG: http://localhost:8080/epg.xml
- IPTV M3U: http://localhost:8080/iptv.m3u

### Creating a Channel

Using the API:

```bash
curl -X POST http://localhost:8080/api/channels \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Movies Channel",
    "slug": "movies",
    "resolution": "1920x1080",
    "videoBitrate": 2500000,
    "audioBitrate": 128000,
    "fps": 30,
    "segmentDuration": 6
  }'
```

### Starting a Channel

```bash
curl -X POST http://localhost:8080/api/channels/{channelId}/start \
  -H "X-API-Key: your-api-key"
```

### Playing Streams

VLC Media Player:
```
Media ? Open Network Stream ? http://localhost:8080/movies/master.m3u8
```

**IPTV Apps:**
- Jellyfin: Add as IPTV source
- Kodi: Install IPTV Simple Client addon
- TiviMate (Android): Add playlist URL
- Web Browser: Use hls.js or Video.js

Web Browser Example:
```html
<video id="video" controls></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  const video = document.getElementById('video');
  const hls = new Hls();
  hls.loadSource('http://localhost:8080/movies/master.m3u8');
  hls.attachMedia(video);
</script>
```

### Setting Up Media Libraries

1. Create a library:
```bash
curl -X POST http://localhost:8080/api/libraries \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Movies",
    "path": "/media/movies",
    "category": "movies",
    "enabled": true,
    "recursive": true
  }'
```

2. **Scan for media:**
```bash
curl -X POST http://localhost:8080/api/libraries/{libraryId}/scan \
  -H "X-API-Key: your-api-key"
```

### Creating Media Buckets

1. Create a bucket:
```bash
curl -X POST http://localhost:8080/api/buckets \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Action Movies",
    "bucketType": "global",
    "description": "High-octane action films"
  }'
```

2. **Add media to bucket:**
```bash
curl -X POST http://localhost:8080/api/buckets/{bucketId}/media \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "mediaIds": ["media-id-1", "media-id-2"]
  }'
```

3. Assign bucket to channel:
```bash
curl -X POST http://localhost:8080/api/channels/{channelId}/buckets \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "bucketId": "bucket-id"
  }'
```

### Dynamic Playlists (Schedule Blocks)

Create time-based programming:

```bash
curl -X POST http://localhost:8080/api/schedules \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "channelId": "channel-id",
    "name": "Morning Cartoons",
    "startTime": "06:00:00",
    "endTime": "12:00:00",
    "dayOfWeek": [0,1,2,3,4,5,6],
    "bucketId": "cartoons-bucket-id",
    "playbackMode": "sequential"
  }'
```

Then enable dynamic playlists on the channel:
```bash
curl -X PATCH http://localhost:8080/api/channels/{channelId} \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "useDynamicPlaylist": true
  }'
```

### Getting EPG Data

XMLTV Format (for IPTV players):
```bash
curl http://localhost:8080/epg.xml
```

JSON Format (for specific channel):
```bash
curl http://localhost:8080/api/epg/channels/{channel-slug}
```

## API Documentation

API documentation is available in OpenAPI format:

- OpenAPI Spec: `openapi.yaml`
- Interactive Docs: http://localhost:8080/api-docs (if enabled)

### Key Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/health` | Health check | No |
| GET | `/api/channels` | List channels | No |
| POST | `/api/channels` | Create channel | Yes |
| POST | `/api/channels/:id/start` | Start streaming | Yes |
| POST | `/api/channels/:id/stop` | Stop streaming | Yes |
| GET | `/epg.xml` | EPG (XMLTV) | No |
| GET | `/:slug/master.m3u8` | Master playlist | No |
| GET | `/iptv.m3u` | IPTV playlist | No |

## Development

```bash
# Install dependencies
npm install
# If you encounter symlink errors, use: npm install --no-bin-links

# Run in development mode (auto-reload)
npm run dev

# Run tests
npm test

# Build the application
npm run build

# Lint code
npm run lint

# Format code
npm run format
```

## Troubleshooting

### Stream Not Starting?

1. **Check FFmpeg is installed:**
   ```bash
   ffmpeg -version
   ```

2. Verify media directories exist and are readable

3. Check logs:
   ```bash
   # Docker
   docker-compose logs -f
   
   # Local
   # Check console output
   ```

4. Supported formats: `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.ts`, `.mpg`, `.mpeg`

### High CPU Usage?

- Lower video bitrate: `DEFAULT_VIDEO_BITRATE=1000000`
- Lower resolution: `DEFAULT_RESOLUTION=1280x720`
- Enable hardware acceleration if available: `HW_ACCEL=nvenc`

### Permission Errors?

- Ensure user has read access to media directories
- For Docker, check volume mount permissions

## AI Assistant Integration (MCP Server)

This project includes a Model Context Protocol (MCP) server that allows AI assistants to manage the streaming server through natural language commands.

### Quick Setup

```bash
cd mcp-server
npm install
npm run build
cp .env.example .env
# Edit .env with your HLS server URL and API key
```

Configure your MCP client (such as Claude Desktop) to use the MCP server. See [MCP_SERVER_SETUP.md](MCP_SERVER_SETUP.md) for detailed instructions.

The MCP server provides tools for:
- Creating and managing channels
- Organizing media into buckets
- Setting up schedule blocks
- Searching and managing media libraries

## License

MIT License - See [LICENSE](LICENSE) file

## Disclaimer

This software is provided as-is for development and educational purposes. It is not recommended for production use. Use at your own risk.

## Support

For issues, questions, or contributions, please refer to the project repository.
