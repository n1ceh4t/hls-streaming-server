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
echo -e "${YELLOW}💡 Tip: Using --no-bin-links is recommended to avoid symlink issues on Windows/WSL/Docker${NC}"
if [ -f package-lock.json ]; then
    npm ci --no-bin-links
else
    echo -e "${YELLOW}⚠️  package-lock.json not found. Using npm install instead...${NC}"
    npm install --no-bin-links
fi

# Setup environment
if [ ! -f .env ]; then
    echo -e "${BLUE}📝 Setting up environment configuration...${NC}"
    echo ""
    echo -e "${YELLOW}You can either:${NC}"
    echo "  1. Run interactive setup: npm run setup (recommended)"
    echo "  2. Copy .env.example and edit manually"
    echo ""
    read -p "Run interactive setup now? (Y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        echo ""
        node scripts/setup.js
        echo ""
        echo -e "${GREEN}✅ Interactive setup completed${NC}"
    else
        cp .env.example .env
        echo -e "${YELLOW}⚠️  IMPORTANT: Please edit .env and configure:${NC}"
        echo "   - MEDIA_DIRECTORIES: Paths to your media files"
        echo "   - API_KEY: A secure random string for authentication"
        echo ""
    fi
else
    echo -e "${GREEN}✅ .env file already exists${NC}"
fi

# Build
echo -e "${BLUE}🔨 Building application...${NC}"
if npm run build; then
    echo -e "${GREEN}✅ Build completed successfully${NC}"
else
    echo -e "${RED}❌ Build failed. Please check errors above.${NC}"
    exit 1
fi

# Setup database
echo -e "${BLUE}🗄️  Setting up database...${NC}"

# Check if database is configured in .env
if [ -f .env ] && grep -q "^DB_HOST=" .env 2>/dev/null; then
    echo -e "${GREEN}✅ Database configuration found in .env${NC}"
    
    # Check if psql is available
    if ! command -v psql &> /dev/null; then
        echo -e "${YELLOW}⚠️  psql command not found. PostgreSQL client tools are required for migrations.${NC}"
        echo "   Install with: sudo apt-get install postgresql-client"
        echo ""
        read -p "Continue anyway? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}⚠️  Skipping migrations. Install PostgreSQL client and run 'npm run migrate' when ready.${NC}"
        else
            echo -e "${YELLOW}⚠️  Skipping migrations. Run 'npm run migrate' when PostgreSQL client is installed.${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Make sure PostgreSQL is running and configured.${NC}"
        echo ""
        read -p "Run database migrations now? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            if npm run migrate; then
                echo -e "${GREEN}✅ Migrations completed successfully${NC}"
            else
                echo -e "${RED}❌ Migrations failed. You can run them manually with: npm run migrate${NC}"
            fi
        else
            echo -e "${YELLOW}⚠️  Skipping migrations. Run 'npm run migrate' when ready.${NC}"
        fi
    fi
else
    echo -e "${YELLOW}⚠️  Database not configured in .env. Skipping migrations.${NC}"
    echo "   Configure database in .env file, then run: npm run migrate"
fi

# Create necessary directories (before build, but also ensure they exist after)
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
if [ ! -f .env ]; then
    echo "1. Run interactive setup:"
    echo "   npm run setup"
    echo ""
    echo "   Or manually configure .env file"
    echo ""
fi
echo "2. Start the server:"
echo "   npm start           # Start server"
echo "   npm run dev         # Development mode with auto-reload"
echo ""
echo "3. Access the server:"
echo "   API: http://localhost:8080/api/channels"
echo "   Admin Panel: http://localhost:8080/admin/"
echo ""
echo "4. Read the documentation:"
echo "   - README.md for full documentation"
echo ""
