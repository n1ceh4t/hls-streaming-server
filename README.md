# HLS Streaming Server

An HLS/IPTV streaming server for creating multi-channel streaming services from your media library.

<img width="1280" height="720" alt="Screenshot_20251112_224236" src="https://github.com/user-attachments/assets/96cd5a6f-7524-4611-9f86-2f2b33e3cbf3" />

<details>
   
   <summary>More Images</summary>
   <pre>
       <img width="1920" height="986" alt="Screenshot_20251112_224331" src="https://github.com/user-attachments/assets/cad9baed-4070-4c1f-ab3c-8136056657d9" />
       <img width="1917" height="991" alt="Screenshot_20251112_224140" src="https://github.com/user-attachments/assets/1f602d83-c2c1-4c2b-b50f-df031e8e9854" />
       <img width="1920" height="986" alt="Screenshot_20251112_225041" src="https://github.com/user-attachments/assets/ed840f5f-7382-4072-b53d-d1bc6c61d070" />

   </pre>
</details>




## Features

- Multi-channel HLS streaming
- Jellyfin compatibility a priority; channel guide implemented
- Dynamic playlists with schedule-based content switching
- Media buckets for organizing content into collections
- Schedule blocks for time-based programming (e.g., morning cartoons, prime time movies)
- Progressive playback mode for sequential series progression across days
- IPTV support with M3U playlists and XMLTV EPG generation
- Schedule time tracking for continuous playback positioning
- Manual and automatic media library scanning (automatic scanning disabled by default)
- API key and session-based authentication
- Admin web interface for channel and media management
- Docker deployment support

## Architecture Overview

### Core Components

**Channels**: The main streaming entities. Each channel has:
- A unique slug (URL identifier)
- Streaming configuration (resolution, bitrate, FPS)
- Media assigned via buckets or direct assignment
- Schedule blocks for time-based programming
- EPG (Electronic Program Guide) generation

**Media Buckets**: Collections of media files that can be assigned to channels. Buckets support:
- Global buckets (shared across channels)
- Channel-specific buckets
- Media filtering and organization

**Schedule Blocks**: Time-based programming rules that:
- Define when specific content plays (time ranges, days of week)
- Link buckets to time slots
- Support multiple playback modes (sequential, shuffle, random)
- Enable progressive playback for series (single-series buckets only)

**Progressive Playback**: Tracks playback position within sequential series:
- Works only with buckets containing a single series
- Continues across days (Day 1: s1e1, s1e2... Day 2: s1e4, s1e5...)
- Persists across EPG regenerations
- Automatically disabled for multi-series buckets

**EPG (Electronic Program Guide)**: Generates XMLTV-compatible program listings:
- Projects virtual timeline onto real-world time
- Uses `schedule_start_time` as the reference point
- Updates dynamically based on current playback position
- Supports 48-hour lookahead by default

**Database Schema**: PostgreSQL stores:
- Channel configurations and state
- Media file metadata and library information
- Bucket definitions and media assignments
- Schedule block configurations
- EPG cache and progression tracking
- User sessions and authentication

### Data Flow

1. **Media Scanning**: Media files are scanned and metadata extracted
2. **Bucket Assignment**: Media is organized into buckets
3. **Channel Configuration**: Channels are created and buckets assigned
4. **Schedule Setup**: Schedule blocks define time-based programming
5. **Stream Generation**: FFmpeg creates HLS segments from media files
6. **EPG Generation**: EPG is generated based on schedule and current position
7. **Playback**: Clients request HLS playlists and segments

## Installation

### Prerequisites

- **Node.js 18+** and **npm 9+**
- **FFmpeg** installed and in PATH
- **PostgreSQL** (required - all features including channels, media management, scheduling, and EPG depend on it)

### Quick Start Checklist

Before starting, ensure you have:

- [ ] **Node.js 18+** and **npm 9+** installed (`node --version`, `npm --version`)
- [ ] **FFmpeg** installed and in PATH (`ffmpeg -version`)
- [ ] **PostgreSQL** installed and running (`psql --version`)
- [ ] Database created (default: `hls_streaming`) or will be created during setup
- [ ] Media directories exist and are readable
- [ ] Port 8080 (or your chosen port) is available

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
- Media directory configuration
- API key generation
- Streaming quality settings
- Database setup (PostgreSQL)
- Automatic database migrations

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

3. **Update `docker-compose.yml`** to include PostgreSQL and mount your media directories:
   
   Open `docker-compose.yml` and add a PostgreSQL service, then update volumes:
   ```yaml
   version: '3.8'
   
   services:
     postgres:
       image: postgres:15-alpine
       container_name: hls-postgres
       environment:
         POSTGRES_DB: hls_streaming
         POSTGRES_USER: postgres
         POSTGRES_PASSWORD: ${DB_PASSWORD:-postgres}
       volumes:
         - postgres_data:/var/lib/postgresql/data
       ports:
         - "5432:5432"
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U postgres"]
         interval: 10s
         timeout: 5s
         retries: 5
   
     hls-server:
       build: .
       container_name: hls-iptv-server
       depends_on:
         postgres:
           condition: service_healthy
       ports:
         - "8080:8080"
         - "8081:8081"
       volumes:
         # Mount your media directories here
         # Replace /path/to/your/media with your actual media paths
         - /media/movies:/media/movies:ro
         - /media/shows:/media/shows:ro
         # - /home/user/Videos:/media/videos:ro
         
         # HLS output (persisted)
         - ./hls_output:/app/hls_output
         # Temp directory
         - ./temp:/app/temp
       environment:
         # ... (see existing docker-compose.yml for full config)
         DB_HOST: postgres
         DB_PORT: 5432
         DB_NAME: hls_streaming
         DB_USER: postgres
         DB_PASSWORD: ${DB_PASSWORD:-postgres}
   
   volumes:
     postgres_data:
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
   
   # Database configuration (for Docker, use service name as host)
   DB_HOST=postgres
   DB_PORT=5432
   DB_NAME=hls_streaming
   DB_USER=postgres
   DB_PASSWORD=postgres
   DB_POOL_MIN=2
   DB_POOL_MAX=10
   DB_SSL=false
   ```
   
   **Note:** The paths in `MEDIA_DIRECTORIES` should be the container paths (inside `/media`), not the host paths.

5. **Run database migrations:**
   ```bash
   # After containers are running
   docker-compose exec hls-server npm run migrate
   ```

6. Start with Docker Compose:
   ```bash
   docker-compose up -d
   ```

7. View logs:
   ```bash
   # All services
   docker-compose logs -f
   
   # Just the HLS server
   docker-compose logs -f hls-server
   
   # Just PostgreSQL
   docker-compose logs -f postgres
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
   - Setting up PostgreSQL database (required)
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

4. **Run database migrations (required):**
   ```bash
   npm run migrate
   ```
   
   **Note**: `npm run migrate` is cross-platform:
   - **Linux/Mac**: Uses `migrate.sh` (bash script with psql) - works without building first
   - **Windows**: Uses `migrate.ts` (TypeScript/Node.js) - requires dependencies installed
   
   You can also use the platform-specific commands directly:
   - `npm run migrate:sh` - Force use bash script (Linux/Mac)
   - `npm run migrate:ts` - Force use TypeScript script (Windows/requires build)
   
   **Important**: All migrations will be applied automatically. The migration system tracks applied migrations and will skip already-applied ones on subsequent runs.

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

**Settings Precedence**: Settings configured via the Admin UI (stored in the database) **take precedence** over `.env` file values. If a setting exists in the database, the `.env` value is ignored. This allows you to change settings at runtime without restarting the server.

### Essential Settings

Edit `.env` file with your configuration:

```env
# Media directories (comma-separated paths, this step is not deprecated, as library creation takes place in the admin UI )
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

# FFmpeg encoding preset (affects quality vs speed)
# Options: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
# Default: 'fast' (good balance of quality and speed)
# Faster presets = lower quality (more blocky), slower = better quality but more CPU
FFMPEG_PRESET=fast

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

### Library Scanning

Automatic library scanning is **disabled by default**. To enable it:

**Option 1: Via Admin UI (Recommended)**
- Navigate to Settings (⚙️ icon in top-right) → Enable "Automatic Library Scanning"
- This saves the setting to the database and takes precedence over `.env`

**Option 2: Via `.env` file**
```env
# Enable automatic library scanning
ENABLE_AUTO_SCAN=true

# Set scan interval (in minutes)
AUTO_SCAN_INTERVAL=60
```

**Precedence**: Settings saved via Admin UI (stored in database) **take precedence** over `.env` file values. If a setting exists in the database, the `.env` value is ignored.

**Note**: Even with automatic scanning disabled, you can manually scan libraries via:
- **Admin UI**: Navigate to Libraries tab → Click "Scan" button
- **API**: `POST /api/libraries/{libraryId}/scan`

See `.env.example` for all available configuration options.

## Usage

### Access Points

Once running, access your server at:

- Admin Panel: http://localhost:8080/admin
- API: http://localhost:8080/api/channels
- Stream: http://localhost:8080/{channel-slug}/master.m3u8
- EPG: http://localhost:8080/epg.xml
- IPTV M3U: http://localhost:8080/playlist.m3u

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
- Many More

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

### Setting Up Jellyfin Live TV

Jellyfin can use this HLS server as an IPTV source, giving you a live TV experience with electronic program guide (EPG) support.

#### Prerequisites

- Jellyfin server installed and running
- HLS Streaming Server running and accessible from Jellyfin
- At least one channel created and started

#### Step 1: Install the Live TV Plugin

1. Open Jellyfin Dashboard
2. Navigate to **Plugins** → **Catalog**
3. Find and install **"Live TV"** plugin (comes pre-installed in most Jellyfin versions)
4. Restart Jellyfin if prompted

#### Step 2: Add M3U Tuner

1. Go to **Dashboard** → **Live TV** → **Tuner Devices**
2. Click **+ (Add)** button
3. Select **"M3U Tuner"** from the dropdown
4. Configure the tuner:

**Tuner Settings:**
```
File or URL: http://YOUR-SERVER-IP:8080/playlist.m3u

Example: http://192.168.1.100:8080/playlist.m3u
         or http://localhost:8080/playlist.m3u (if on same machine)

User agent: (leave blank or use default)
Simultaneous stream limit: 3 (adjust based on your server capacity)
```

**Advanced Options (optional):**
- **Auto-loop live streams**: Enabled (recommended for continuous channels)
- **Enable stream probing**: Enabled (helps with codec detection)

5. Click **Save**

#### Step 3: Configure EPG Source (XMLTV)

1. In **Dashboard** → **Live TV** → **Guide Data Providers**
2. Click **+ (Add)** to add a new guide provider
3. Select **"XMLTV"** from the dropdown
4. Configure the EPG:

**XMLTV Settings:**
```
File or URL: http://YOUR-SERVER-IP:8080/epg.xml

Example: http://192.168.1.100:8080/epg.xml
         or http://localhost:8080/epg.xml

Refresh guide every: 2 hours (recommended)
Days of guide data: 2 (matches HLS server's 48-hour lookahead)
```

5. Click **Save**


#### Step 4: Verify Setup

1. Navigate to **Live TV** in the Jellyfin main menu
2. You should see:
   - **Channels** tab showing your HLS channels
   - **Guide** tab showing the program schedule with show titles and times
   - Channel logos (if configured in the HLS server)

#### Troubleshooting Jellyfin Setup

**Channels not appearing:**
- Verify the M3U URL is accessible: `curl http://YOUR-SERVER-IP:8080/playlist.m3u`
- Check Jellyfin logs: **Dashboard** → **Logs** → **Server**
- Ensure channels are started in the HLS admin panel

**EPG data not showing:**
- Verify the XMLTV URL is accessible: `curl http://YOUR-SERVER-IP:8080/epg.xml`
- Check that EPG generation is enabled in HLS server: `ENABLE_EPG=true` in `.env`
- Refresh guide data manually
- Ensure channel names match between M3U and XMLTV

**Playback issues:**
- Check network connectivity between Jellyfin and HLS server
- Verify FFmpeg is running for the channel (check HLS server logs)
- Try increasing **Simultaneous stream limit** in tuner settings
- Enable **Direct Play** in Jellyfin playback settings

**Guide refresh failing:**
- Check Jellyfin scheduled tasks for errors
- Verify no firewall blocking EPG URL
- Try reducing **Refresh guide every** to 4 hours if too frequent

**NOTE:**
Jellyfin caches EPG and stream segments (if not passthru,) which can make it appear as if the server is streaming incorrect content.
This generally only happens under rapid testing or frequent playlist updating. For general usage, it probably isn't an issue.

#### Advanced Configuration

**Custom Channel Numbers:**
Edit `/admin/` to assign specific channel numbers. Jellyfin will respect the `tvg-chno` attribute in the M3U playlist.

**Channel Groups:**
The HLS server automatically assigns channels to groups based on configuration. These appear as filters in Jellyfin's Live TV interface.

**Recording (DVR):**
Jellyfin can record live streams. Go to **Dashboard** → **Live TV** → **Recording** to configure:
- Recording path
- Post-processing options
- Series recording rules

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

2. **Scan for media** (manual scan - automatic scanning is disabled by default):
```bash
curl -X POST http://localhost:8080/api/libraries/{libraryId}/scan \
  -H "X-API-Key: your-api-key"
```

**Note**: Automatic library scanning is disabled by default. You can enable it in Settings (Admin UI) or by setting `ENABLE_AUTO_SCAN=true` in your `.env` file.

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
curl -X POST http://localhost:8080/api/schedules/channels/{channelId}/blocks \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Morning Cartoons",
    "startTime": "06:00:00",
    "endTime": "12:00:00",
    "dayOfWeek": [0,1,2,3,4,5,6],
    "bucketId": "cartoons-bucket-id",
    "playbackMode": "sequential",
    "priority": 1,
    "enabled": true
  }'
```

**Playback Modes:**
- **Sequential (Progressive)**: Plays media in order, with progression tracking. **Note**: Only works with buckets containing a single series. Progression continues across days (Day 1: s1e1, s1e2, s1e3... Day 2: s1e4, s1e5, s1e6...) and persists across EPG regenerations.
- **Shuffle**: Randomizes order once, then plays sequentially
- **Random**: Shuffles order each time, untested, and may introduce issues with EPG, which a lot of infrastructure relies on. TODO

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
| GET | `/:slug/stream.m3u8` | Media playlist | No |
| GET | `/playlist.m3u` | IPTV playlist (M3U) | No |
| GET | `/api/media/count` | Total media files count | No |
| PUT | `/api/channels/:id/schedule-time` | Update schedule start time | Yes |

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

2. **Verify database is running and migrations are applied:**
   ```bash
   # Check database connection
   psql -h localhost -U postgres -d hls_streaming -c "SELECT version FROM schema_migrations ORDER BY version;"
   
   # Run migrations if needed
   npm run migrate
   ```

3. **Verify media directories exist and are readable**

4. **Check logs:**
   ```bash
   # Docker
   docker-compose logs -f
   
   # Local
   # Check console output or logs directory
   ```

5. **Supported formats**: `.mp4`, `.mkv`, `.avi`, `.mov`, `.wmv`, `.flv`, `.webm`, `.m4v`, `.ts`, `.mpg`, `.mpeg`

6. **Verify channel has media assigned**: Use the admin panel at `/admin` to check channel configuration and assigned buckets

### High CPU Usage?

- Lower video bitrate: `DEFAULT_VIDEO_BITRATE=1000000`
- Lower resolution: `DEFAULT_RESOLUTION=1280x720`
- Enable hardware acceleration if available: `HW_ACCEL=nvenc`

### Permission Errors?

- Ensure user has read access to media directories
- For Docker, check volume mount permissions
- Check PostgreSQL user permissions if database operations fail

### Database Connection Errors?

1. **Verify PostgreSQL is running:**
   ```bash
   # Local
   sudo systemctl status postgresql
   
   # Docker
   docker-compose ps postgres
   ```

2. **Test connection:**
   ```bash
   psql -h localhost -U postgres -d hls_streaming -c "SELECT 1;"
   ```

3. **Check database exists:**
   ```bash
   psql -h localhost -U postgres -l | grep hls_streaming
   ```

4. **Verify credentials in `.env`:**
   - Check `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
   - For Docker, use service name as host (e.g., `DB_HOST=postgres`)

### Migration Failures?

See the [Migration Guide](#migration-guide) section below.

### Channel Not Starting?

1. **Check channel has media assigned:**
   - Use admin panel at `/admin`
   - Verify buckets are assigned to channel
   - Verify buckets contain media files

2. **Check FFmpeg logs:**
   - Look for FFmpeg errors in server logs
   - Verify media file paths are correct
   - Check file permissions

3. **Verify schedule blocks (if using dynamic playlists):**
   - Check schedule blocks are enabled
   - Verify time ranges are correct
   - Ensure buckets are assigned to blocks

### EPG Not Generating?

1. **Check EPG is enabled (NEVER disable this):**
   ```env
   ENABLE_EPG=true
   ```

2. **Verify channel has `schedule_start_time` set:**
   - Use admin panel to check/update schedule time
   - Or use API: `PUT /api/channels/:id/schedule-time`

3. **Check channel has media:**
   - EPG requires media to generate program listings

## Migration Guide

### Understanding Migrations

The system uses database migrations that are applied automatically:
1. Initial schema (channels, media_files, libraries, buckets)
2. Schedule blocks support
3. EPG cache tables
4. Progression tracking
5. Schedule time tracking
6. Additional indexes for performance
7. Schema updates and optimizations
8. ...

### Checking Migration Status

```bash
# Using psql
psql -h localhost -U postgres -d hls_streaming -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"

# Using migration script
npm run migrate
# The script will show which migrations are already applied
```

### Running Migrations

**Automatic (Recommended - Cross-Platform):**
```bash
npm run migrate
```

This automatically detects your platform:
- **Linux/Mac**: Uses `migrate.sh` (bash script with psql)
  - Works without building the application first
  - Checks which migrations are already applied
  - Applies only new migrations
  - Shows detailed progress
- **Windows**: Uses `migrate.ts` (TypeScript/Node.js)
  - Requires dependencies installed (`npm install`)
  - Uses the TypeScript Database class
  - Same migration tracking and progress

**Platform-Specific Commands:**
```bash
# Force use bash script (Linux/Mac)
npm run migrate:sh

# Force use TypeScript script (Windows/requires build)
npm run build
npm run migrate:ts
```

**Docker:**
```bash
docker-compose exec hls-server npm run migrate
```

### Migration Troubleshooting

**Migration already applied error:**
- This is normal - migrations are idempotent
- The system tracks applied migrations and skips them

**Connection refused:**
- Verify PostgreSQL is running
- Check database credentials in `.env`
- For Docker, ensure PostgreSQL service is healthy

**Permission denied:**
- Ensure database user has CREATE/ALTER permissions
- For new databases, user needs to be owner or superuser

**Rollback:**
- Migrations are designed to be forward-only
- For rollback, restore from database backup
- Always backup before major updates

### Manual Migration Application

If automatic migration fails, you can apply migrations manually:

```bash
# List all migrations
ls database/migrations/

# Apply specific migration (example)
psql -h localhost -U postgres -d hls_streaming -f database/migrations/001_initial_schema.sql
```

**Warning:** Only do this if you understand the migration system. The automatic migration script is safer.

## Performance Tuning

### Database Connection Pool

Adjust connection pool settings in `.env`:

```env
# Minimum connections (always open)
DB_POOL_MIN=2

# Maximum connections (peak capacity)
DB_POOL_MAX=10
```

**Recommendations:**
- **Small deployments** (1-3 channels): `DB_POOL_MIN=2`, `DB_POOL_MAX=5`
- **Medium deployments** (4-10 channels): `DB_POOL_MIN=2`, `DB_POOL_MAX=10`
- **Large deployments** (10+ channels): `DB_POOL_MIN=5`, `DB_POOL_MAX=20`

**Note:** Each connection uses ~2-5MB of memory. Don't set `DB_POOL_MAX` higher than your PostgreSQL `max_connections` setting.

### FFmpeg Encoding Optimization

**Hardware Acceleration:**
```env
# NVIDIA GPU (recommended if available)
HW_ACCEL=nvenc

# Intel Quick Sync
HW_ACCEL=qsv

# Apple VideoToolbox (macOS)
HW_ACCEL=videotoolbox

# CPU only (default)
HW_ACCEL=none
```

**Quality vs Performance:**
```env
# Lower quality = better performance
DEFAULT_VIDEO_BITRATE=1000000      # 1 Mbps (low)
DEFAULT_VIDEO_BITRATE=1500000      # 1.5 Mbps (medium, default)
DEFAULT_VIDEO_BITRATE=3000000      # 3 Mbps (high)
DEFAULT_RESOLUTION=1280x720        # 720p (faster)
DEFAULT_RESOLUTION=1920x1080       # 1080p (default)
DEFAULT_FPS=24                     # Lower FPS = less CPU

# FFmpeg preset (most important for quality)
FFMPEG_PRESET=fast                 # Default: good balance (less blocky than veryfast)
FFMPEG_PRESET=medium               # Better quality, more CPU
FFMPEG_PRESET=veryfast             # Faster encoding, but can cause blocky video
FFMPEG_PRESET=ultrafast            # Fastest, but very blocky (not recommended)
```

### Concurrent Stream Limits

```env
# Maximum concurrent FFmpeg processes
MAX_CONCURRENT_STREAMS=8
```

**Recommendations:**
- **CPU encoding**: `MAX_CONCURRENT_STREAMS = CPU cores - 1`
- **Hardware encoding**: `MAX_CONCURRENT_STREAMS = 2x GPU capability`
- **Mixed**: Start with 4-6, monitor CPU/GPU usage, adjust accordingly

### HLS Segment Settings

```env
# Segment duration (seconds)
DEFAULT_SEGMENT_DURATION=6

# Shorter segments = more frequent updates but more overhead
# Longer segments = less overhead but slower channel switching
```

**Recommendations:**
- **Live streaming**: 4-6 seconds
- **On-demand**: 6-10 seconds
- **Low bandwidth**: 8-10 seconds

### PostgreSQL Performance

**For large media libraries (10,000+ files):**

1. **Add indexes** (already included in migrations):
   ```sql
   -- These are created automatically, but verify they exist
   CREATE INDEX IF NOT EXISTS idx_media_files_show_name ON media_files(show_name);
   CREATE INDEX IF NOT EXISTS idx_media_files_file_exists ON media_files(file_exists);
   ```

2. **Tune PostgreSQL settings** (`postgresql.conf`):
   ```ini
   shared_buffers = 256MB
   effective_cache_size = 1GB
   maintenance_work_mem = 128MB
   checkpoint_completion_target = 0.9
   wal_buffers = 16MB
   default_statistics_target = 100
   random_page_cost = 1.1
   effective_io_concurrency = 200
   ```

3. **Regular maintenance:**
   ```bash
   # Analyze tables (run weekly)
   psql -h localhost -U postgres -d hls_streaming -c "ANALYZE;"
   
   # Vacuum (run monthly or when needed)
   psql -h localhost -U postgres -d hls_streaming -c "VACUUM ANALYZE;"
   ```

### Monitoring Performance

**Key metrics to watch:**
- Database connection pool usage
- FFmpeg CPU/GPU usage
- HLS segment generation rate
- Memory usage (Node.js + PostgreSQL + FFmpeg)
- Disk I/O (media files + HLS output)

**Useful commands:**
```bash
# Database connections
psql -h localhost -U postgres -d hls_streaming -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'hls_streaming';"

# Database size
psql -h localhost -U postgres -d hls_streaming -c "SELECT pg_size_pretty(pg_database_size('hls_streaming'));"

# FFmpeg processes
ps aux | grep ffmpeg

# Disk usage
du -sh hls_output/
```

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
