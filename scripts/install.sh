#!/bin/bash
# install.sh - Installation script for fresh installations

set -e

echo "🚀 Installing HLS/IPTV Streaming Server..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is required but not installed.${NC}"
    echo "   Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 18+ is required. Current version: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is required but not installed.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ npm $(npm -v)${NC}"

# Check FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}⚠️  FFmpeg is not found in PATH.${NC}"
    echo "   The server requires FFmpeg for video processing."
    echo "   Install FFmpeg: https://ffmpeg.org/download.html"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✅ FFmpeg $(ffmpeg -version | head -n 1 | cut -d' ' -f3)${NC}"
fi

echo ""

# Install dependencies
echo -e "${BLUE}📦 Installing dependencies...${NC}"
npm ci

# Setup environment
if [ ! -f .env ]; then
    echo -e "${BLUE}📝 Creating .env file from template...${NC}"
    cp .env.example .env
    echo -e "${YELLOW}⚠️  IMPORTANT: Please edit .env and configure:${NC}"
    echo "   - MEDIA_DIRECTORIES: Paths to your media files"
    echo "   - API_KEY: A secure random string for authentication"
    echo ""
else
    echo -e "${GREEN}✅ .env file already exists${NC}"
fi

# Build
echo -e "${BLUE}🔨 Building application...${NC}"
npm run build

# Setup database
echo -e "${BLUE}🗄️  Setting up database...${NC}"
echo -e "${YELLOW}⚠️  Make sure PostgreSQL is running and configured.${NC}"
echo ""
read -p "Run database migrations now? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm run migrate
else
    echo -e "${YELLOW}⚠️  Skipping migrations. Run 'npm run migrate' when ready.${NC}"
fi

# Create necessary directories
echo -e "${BLUE}📁 Creating directories...${NC}"
mkdir -p hls_output temp logs data

# Set permissions (if on Linux/Mac)
if [ "$(uname)" != "MINGW" ] && [ "$(uname)" != "MSYS" ]; then
    chmod 755 hls_output temp logs data
fi

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Edit .env file and configure your settings:"
echo "   - MEDIA_DIRECTORIES: Paths to your media files"
echo "   - API_KEY: Generate a secure random string"
echo ""
echo "2. Configure database connection in .env (if using PostgreSQL)"
echo ""
echo "3. Start the server:"
echo "   npm start           # Production mode"
echo "   npm run dev         # Development mode with auto-reload"
echo ""
echo "4. Access the server:"
echo "   API: http://localhost:8080/api/channels"
echo "   Admin Panel: http://localhost:8080/admin/"
echo ""
echo "5. Read the documentation:"
echo "   - README.md for full documentation"
echo "   - QUICK_START.md for quick start guide"
echo ""
