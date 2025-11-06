# HLS/IPTV Streaming Server

A production-ready, feature-rich HLS/IPTV streaming server built with TypeScript and Node.js. Transform your media library into a professional IPTV service with multi-channel support, dynamic playlists, EPG generation, and more.

## ✨ Features

### Core Streaming
- 🎬 **HLS Streaming** - Industry-standard HTTP Live Streaming (HLS) protocol
- 📺 **Multi-Channel Support** - Create and manage unlimited streaming channels
- 🔄 **Dynamic Playlists** - Schedule-based content switching with time blocks
- 📊 **Media Buckets** - Organize content into collections (like Jellyfin)
- 🎯 **Virtual Time Tracking** - 24/7 continuous streaming simulation

### Media Management
- 📁 **Library Management** - Scan and organize media from multiple directories
- 🔍 **Auto Discovery** - Automatic media file scanning and cataloging
- 🎞️ **Show Parser** - Intelligent TV show episode detection and organization
- 📦 **Media Buckets** - Create collections and assign to channels
- 🎨 **Bumper Support** - Automatic transition bumpers between content

### EPG & IPTV
- 📺 **EPG Generation** - XMLTV format Electronic Program Guide
- ⏰ **48-Hour Lookahead** - See what's playing now and next
- 📡 **IPTV M3U Export** - Generate M3U playlists for IPTV players
- 🎭 **Dynamic EPG** - EPG updates based on schedule blocks

### Advanced Features
- 🔐 **Authentication** - API key and session-based authentication
- 💾 **State Persistence** - Survives restarts, auto-resumes channels
- 📈 **Analytics** - Track viewer sessions and channel statistics
- 🔌 **WebSocket Support** - Real-time updates and control
- 🐳 **Docker Ready** - One-command deployment with Docker Compose

## Quick Start

### Prerequisites

- **Node.js** 18+ and npm 9+
- **FFmpeg** installed and in PATH
- **PostgreSQL** (optional, for advanced features)

### Installation

#### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/yourusername/hls-iptv-server.git
cd hls-iptv-server

# Copy environment template
cp .env.example .env

# Edit .env and configure:
# - MEDIA_DIRECTORIES: Paths to your media files
# - API_KEY: A secure random string

# Start with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f
```

#### Option 2: Local Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/hls-iptv-server.git
cd hls-iptv-server

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Build the application
npm run build

# Run database migrations (if using PostgreSQL)
npm run migrate

# Start the server
npm start

# Or run in development mode with auto-reload
npm run dev
```

### First Steps

1. **Configure Media Directories**
   ```bash
   # Edit .env
   MEDIA_DIRECTORIES=/path/to/movies,/path/to/shows
   ```

2. **Set API Key**
   ```bash
   # Generate a secure random string
   API_KEY=your-secure-random-api-key-here
   ```

3. **Start the Server**
   ```bash
   npm start
   # or
   docker-compose up -d
   ```

4. **Access Your Stream**
   - API: http://localhost:8080/api/channels
   - Stream: http://localhost:8080/default/master.m3u8
   - Admin Panel: http://localhost:8080/admin/
   - EPG: http://localhost:8080/epg.xml

## ⚙️ Configuration

All configuration is done via environment variables in the `.env` file.

### Essential Settings

```bash
# Media directories (comma-separated)
MEDIA_DIRECTORIES=/media/movies,/media/shows,/media/anime

# API key (generate a secure random string!)
API_KEY=your-secure-api-key-here

# Server port
PORT=8080
```

### Streaming Configuration

```bash
# Video quality
DEFAULT_VIDEO_BITRATE=1500000      # 1.5 Mbps
DEFAULT_AUDIO_BITRATE=128000       # 128 kbps
DEFAULT_RESOLUTION=1920x1080       # 1080p
DEFAULT_FPS=30
DEFAULT_SEGMENT_DURATION=6         # 6 seconds per segment

# Concurrent streams
MAX_CONCURRENT_STREAMS=8
```

### Security

```bash
# Enable authentication
REQUIRE_AUTH=true

# Rate limiting
RATE_LIMIT_MAX=1000
RATE_LIMIT_WINDOW_MS=900000        # 15 minutes
```

### Hardware Acceleration

```bash
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

## 📖 Usage

### Playing Streams

**VLC Media Player:**
```
Media → Open Network Stream → http://localhost:8080/default/master.m3u8
```

**IPTV Apps:**
- **Jellyfin**: Add as IPTV source
- **Kodi**: Install IPTV Simple Client addon
- **TiviMate** (Android): Add playlist URL
- **GSE SMART IPTV** (iOS): Add playlist URL

**Web Browser:**
Use [hls.js](https://github.com/video-dev/hls.js/) or Video.js:
```html
<video id="video" controls></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
  const video = document.getElementById('video');
  const hls = new Hls();
  hls.loadSource('http://localhost:8080/default/master.m3u8');
  hls.attachMedia(video);
</script>
```

### API Examples

**List Channels:**
```bash
curl http://localhost:8080/api/channels
```

**Create Channel:**
```bash
curl -X POST http://localhost:8080/api/channels \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Movies Channel",
    "slug": "movies",
    "resolution": "1920x1080",
    "videoBitrate": 2500000
  }'
```

**Start Streaming:**
```bash
curl -X POST http://localhost:8080/api/channels/{channelId}/start \
  -H "X-API-Key: your-api-key"
```

**Get EPG:**
```bash
curl http://localhost:8080/epg.xml
```

### Dynamic Playlists

Create schedule blocks for time-based content switching:

```bash
# Create a schedule block (e.g., "Morning Cartoons" 6AM-12PM)
curl -X POST http://localhost:8080/api/schedules \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "channelId": "your-channel-id",
    "name": "Morning Cartoons",
    "startTime": "06:00:00",
    "endTime": "12:00:00",
    "dayOfWeek": [0,1,2,3,4,5,6],
    "bucketId": "cartoons-bucket-id"
  }'
```

### Media Buckets

Organize content into collections:

```bash
# Create a bucket
curl -X POST http://localhost:8080/api/buckets \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Action Movies",
    "description": "High-octane action films"
  }'

# Add media to bucket
curl -X POST http://localhost:8080/api/buckets/{bucketId}/media \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "mediaIds": ["media-id-1", "media-id-2"]
  }'

# Assign bucket to channel
curl -X POST http://localhost:8080/api/channels/{channelId}/buckets \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "bucketId": "bucket-id"
  }'
```

## 📚 API Documentation

Full API documentation is available in OpenAPI format:

- **OpenAPI Spec**: `openapi.yaml`
- **Interactive Docs**: http://localhost:8080/api-docs (if enabled)

### Key Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/health` | Health check | No |
| GET | `/api/channels` | List channels | No |
| GET | `/api/channels/:id` | Get channel | No |
| POST | `/api/channels` | Create channel | Yes |
| POST | `/api/channels/:id/start` | Start streaming | Yes |
| POST | `/api/channels/:id/stop` | Stop streaming | Yes |
| GET | `/epg.xml` | EPG (XMLTV) | No |
| GET | `/api/epg/channels/:slug` | Channel EPG (JSON) | No |
| GET | `/:slug/master.m3u8` | Master playlist | No |
| GET | `/:slug/stream.m3u8` | Stream playlist | No |

## 🏗️ Project Structure

```
hls-streaming-server/
├── src/
│   ├── api/              # REST API routes
│   ├── config/           # Configuration management
│   ├── domain/           # Domain models
│   ├── infrastructure/   # External integrations (FFmpeg, DB)
│   ├── services/         # Business logic
│   │   ├── channel/      # Channel management
│   │   ├── epg/         # EPG generation
│   │   ├── library/     # Media library management
│   │   ├── bucket/      # Media bucket management
│   │   ├── playlist/    # Playlist resolution
│   │   └── virtual-time/ # Virtual time tracking
│   └── utils/            # Utilities
├── database/
│   └── migrations/       # Database migrations
├── scripts/              # Utility scripts
├── .env.example          # Configuration template
├── Dockerfile            # Docker image
└── docker-compose.yml    # Docker Compose setup
```

## 🔧 Development

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format

# Build for production
npm run build
```

## Deployment

### Docker Deployment

1. **Edit `docker-compose.yml`** to mount your media directories:
   ```yaml
   volumes:
     - /your/media/path:/media:ro
   ```

2. **Set environment variables** (either in `docker-compose.yml` or `.env`)

3. **Deploy:**
   ```bash
   docker-compose up -d
   ```

### Systemd Service (Linux)

Create `/etc/systemd/system/hls-server.service`:

```ini
[Unit]
Description=HLS/IPTV Streaming Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/hls-streaming-server-v1.0
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable hls-server
sudo systemctl start hls-server
sudo systemctl status hls-server
```

## 🐛 Troubleshooting

### Stream Not Starting?

1. **Check FFmpeg is installed:**
   ```bash
   ffmpeg -version
   ```

2. **Verify media directories exist and are readable**

3. **Check logs:**
   ```bash
   # Docker
   docker-compose logs -f
   
   # Local
   # Check console output
   ```

4. **Supported formats:** `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.ts`, `.mpg`, `.mpeg`

### Permission Errors?

- Ensure user has read access to media directories
- For Docker, check volume mount permissions

### High CPU Usage?

- Lower video bitrate: `DEFAULT_VIDEO_BITRATE=1000000`
- Lower resolution: `DEFAULT_RESOLUTION=1280x720`
- Enable hardware acceleration if available: `HW_ACCEL=nvenc`

### npm install Fails with Symlink Errors?

If you see `EPERM: operation not permitted, symlink` errors:
```bash
npm install --no-bin-links
npm run build
npm start
```

This commonly happens on:
- Network drives or external storage
- Filesystems that don't support symlinks (FAT32, some NFS mounts)
- Windows with restricted permissions

## 🤖 AI Assistant Integration (MCP Server)

This project includes a **Model Context Protocol (MCP) server** that enables AI assistants like Claude to manage your streaming server through natural language.

### What is MCP?

MCP (Model Context Protocol) is a protocol that allows AI assistants to interact with external tools and services. The included MCP server exposes **35 tools** covering the complete HLS Streaming Server API.

### Features

- **35 Tools** - Complete API coverage for channels, libraries, buckets, schedules, EPG, and more
- **Natural Language Control** - Ask Claude to manage your streaming server in plain English
- **Full Automation** - Create channels, organize media, set up schedules - all through conversation

### Quick Example

Instead of manually using curl commands, you can simply ask Claude:

> "Create a 24/7 sitcom channel that plays Friends from 8am-12pm on weekdays, The Office from 12pm-6pm daily, and Seinfeld from 6pm-11pm"

Claude will:
1. Create the channel with dynamic playlists enabled
2. Search for episodes of each show
3. Create buckets for each show
4. Set up schedule blocks with the specified times
5. Start the channel streaming

### Available Tools

**Channel Management** (10 tools):
- List, create, update, delete channels
- Start, stop, restart streaming
- Skip to next media, get channel media

**Library Management** (6 tools):
- Create libraries, scan for media
- Get library statistics

**Bucket Management** (8 tools):
- Create and organize media buckets
- Assign buckets to channels
- Link libraries to buckets

**Schedule Management** (4 tools):
- Create time-based schedule blocks
- Manage dynamic playlist programming

**Media Search** (3 tools):
- Search across all media
- List TV series with seasons/episodes

**EPG Management** (3 tools):
- Get current/next programs
- Regenerate EPG data

**System** (1 tool):
- Health checks

### Installation

See the [MCP Server README](mcp-server/README.md) for detailed installation instructions.

**Quick Setup:**
```bash
cd mcp-server
npm install
npm run build
cp .env.example .env
# Edit .env with your HLS server URL and API key
```

Then configure Claude Desktop to use the MCP server - see `mcp-server/README.md` for platform-specific instructions.

**Note:** MCP servers run directly via stdio with MCP clients (like Claude Desktop), not as standalone Docker containers. They are launched by the MCP client process itself, so no Docker containerization is needed.

## 📊 Features in Detail

### Dynamic Playlists

Create time-based schedule blocks that automatically switch content:

- **Schedule Blocks**: Define time windows (e.g., 6AM-12PM)
- **Bucket Assignment**: Assign different media buckets to each block
- **Day of Week**: Schedule specific days or all week
- **Playback Modes**: Sequential, shuffle, or random
- **Automatic Transitions**: Content switches seamlessly at block boundaries

### EPG Generation

- **XMLTV Format**: Compatible with all IPTV players
- **48-Hour Lookahead**: See what's playing now and next
- **Dynamic Updates**: EPG reflects schedule block changes
- **Multiple Channels**: Generate EPG for all channels
- **Cache Support**: Efficient caching for performance

### Virtual Time Tracking

- **24/7 Simulation**: Channels maintain timeline even without viewers
- **Position Tracking**: Know exactly where each channel is in playback
- **Auto-Resume**: Channels resume from correct position after restart
- **EPG Sync**: EPG matches actual playback position

### Media Management

- **Library Scanning**: Automatic discovery of media files
- **Show Parsing**: Intelligent TV show episode detection
- **Bucket Organization**: Create collections of related content
- **Metadata Extraction**: Automatic metadata extraction from files
- **Search & Browse**: Full-text search and filtering

## 🔒 Security Best Practices

1. **Change default API key** to a strong, random string
2. **Enable authentication** in production: `REQUIRE_AUTH=true`
3. **Use HTTPS** with reverse proxy (nginx, Caddy, Traefik)
4. **Restrict API access** to trusted IPs via firewall
5. **Keep dependencies updated**: `npm audit` and `npm update`
6. **Use environment variables** for sensitive data
7. **Regular backups** of database and configuration

## 🙏 Acknowledgments

Built with:
- [Node.js](https://nodejs.org/)
- [TypeScript](https://www.typescriptlang.org/)
- [Express](https://expressjs.com/)
- [FFmpeg](https://ffmpeg.org/)
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- [PostgreSQL](https://www.postgresql.org/)

---

**Made with ❤️ for the home media streaming community**
