#!/bin/bash
# prepare-release.sh - Cleanup script for release preparation

set -e

echo "🧹 Preparing repository for release..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Remove personal data files
echo -e "${YELLOW}Removing personal data files...${NC}"
rm -f .env .env.backup
rm -rf data/state.json data/state.backup.json
rm -rf logs/*.log 2>/dev/null || true

# Remove build artifacts
echo -e "${YELLOW}Removing build artifacts...${NC}"
rm -rf dist/
rm -rf node_modules/
rm -rf coverage/

# Clean HLS output (keep structure)
echo -e "${YELLOW}Cleaning HLS output directories...${NC}"
find hls_output/* -type d -mindepth 1 -exec rm -rf {} + 2>/dev/null || true
find temp/* -type f -delete 2>/dev/null || true

# Ensure .gitkeep files exist
echo -e "${YELLOW}Creating .gitkeep files...${NC}"
mkdir -p hls_output temp logs data
touch hls_output/.gitkeep temp/.gitkeep logs/.gitkeep

# Create example state file
echo '{"channels":[]}' > data/state.json.example

# Search for hardcoded paths
echo -e "${YELLOW}Checking for hardcoded paths...${NC}"
if grep -r "/media/dave" src/ scripts/ 2>/dev/null; then
    echo -e "${RED}⚠️  Found hardcoded paths! Please review and remove.${NC}"
fi

if grep -r "/backup" src/ scripts/ 2>/dev/null; then
    echo -e "${RED}⚠️  Found hardcoded backup paths! Please review and remove.${NC}"
fi

# Check for API keys in code
echo -e "${YELLOW}Checking for secrets in code...${NC}"
if grep -r "dev-test-api-key" src/ scripts/ 2>/dev/null; then
    echo -e "${RED}⚠️  Found test API keys! Please remove or replace with placeholders.${NC}"
fi

echo -e "${GREEN}✅ Cleanup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Review and remove any hardcoded paths found above"
echo "2. Test fresh installation: npm ci && npm run build"
echo "3. Review CHANGELOG.md"
echo "4. Commit changes and create release tag"
