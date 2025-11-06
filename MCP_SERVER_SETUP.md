# MCP Server Setup Guide

## Overview

The HLS Streaming Server includes a **Model Context Protocol (MCP) server** that enables AI assistants like Claude to manage your streaming server through natural language commands.

**Note:** MCP servers run directly via stdio with MCP clients (like Claude Desktop), not as standalone Docker containers. They are launched by the MCP client process itself.

## What is MCP?

Model Context Protocol (MCP) is a protocol that allows AI assistants to interact with external tools and services. The MCP server exposes **35 tools** covering the complete HLS Streaming Server API.

## Quick Start

### 1. Build the MCP Server

```bash
cd mcp-server
npm install
npm run build
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
HLS_SERVER_URL=http://localhost:8080
HLS_API_KEY=your-api-key-here
```

### 3. Configure Claude Desktop

**macOS:**
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:**
Edit `%APPDATA%\Claude\claude_desktop_config.json`

**Linux:**
Edit `~/.config/Claude/claude_desktop_config.json`

Add:
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

### 4. Restart Claude Desktop

The MCP server will be available as tools in Claude.

## Available Tools

**35 tools** covering:
- Channel management (create, start, stop, configure)
- Library management (scan, organize)
- Media buckets (organize content)
- Schedule blocks (time-based playlists)
- EPG management (program guides)
- Media search (find content)

See [mcp-server/README.md](mcp-server/README.md) for complete documentation.

## Deployment Note

MCP servers run directly via stdio with MCP clients (like Claude Desktop), not as standalone Docker containers. They are launched by the MCP client process itself, so no Docker containerization is needed. Simply build the MCP server and configure your MCP client to run it.

## Example Usage

Instead of using curl commands, you can ask Claude:

> "Create a 24/7 sitcom channel that plays Friends from 8am-12pm on weekdays"

Claude will automatically:
1. Create the channel
2. Search for Friends episodes
3. Create buckets and schedule blocks
4. Start streaming

## Troubleshooting

See [mcp-server/TROUBLESHOOTING.md](mcp-server/TROUBLESHOOTING.md) for common issues.

## More Information

- Full documentation: [mcp-server/README.md](mcp-server/README.md)
- Alternative MCP clients: [mcp-server/ALTERNATIVE_MCP_CLIENTS.md](mcp-server/ALTERNATIVE_MCP_CLIENTS.md)
- MCP Protocol: https://modelcontextprotocol.io/
