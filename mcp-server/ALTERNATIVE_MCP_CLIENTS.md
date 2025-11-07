# Open Source Alternatives to Alpaca with MCP and Ollama Support

This document lists open-source desktop applications that support both Ollama (local models) and MCP (Model Context Protocol) tools, similar to Claude Desktop.

## Recommended Options

### 1. ChatOllama
- GitHub: https://github.com/sugarforever/chat-ollama
- Description: Open-source AI chatbot with native Ollama integration and MCP support
- Features:
  - Built specifically for Ollama
  - MCP server integration
  - Supports multiple AI providers (OpenAI, Anthropic, Google, Ollama)
  - User-friendly interface for managing MCP servers
- Platform: Cross-platform
- Status: Active development

### 2. Chat-MCP (by AI-QL)
- GitHub: https://github.com/AI-QL/chat-mcp
- Description: Cross-platform desktop chat application using MCP protocol
- Features:
  - Built on Electron (cross-platform)
  - Minimalistic codebase
  - Dynamic LLM configuration
  - Multi-client management
- Platform: Windows, macOS, Linux
- Status: Active

### 3. MCP Client Chatbot (by universal-mcp)
- GitHub: https://github.com/universal-mcp/mcp-client-chatbot
- Description: Open-source MCP client for running AI chat models locally
- Features:
  - Supports OpenAI, Anthropic, Google, and Ollama
  - External tool integrations (browser automation, databases)
  - Local model support
- Platform: Cross-platform
- Status: Active

### 4. Dive AI Agent
- Website: https://chat.mcp.so/client/Dive/OpenAgentPlatform
- Description: Open-source MCP Host Desktop Application
- Features:
  - Cross-platform (Windows, macOS, Linux)
  - Multi-language support
  - Advanced API management
  - Supports multiple LLMs with function calling
  - MCP server management from UI
- Platform: Cross-platform
- Status: Active

### 5. Luke Desktop
- Description: Alternative Claude desktop application built with Tauri
- Features:
  - Built with Tauri, React, and TypeScript
  - Enhanced security features
  - MCP server protocol support
  - Cross-platform
- Platform: Cross-platform
- Status: Active

### 6. Claude Desktop (Official)
- Website: https://claude.ai/download
- Description: Anthropic's official desktop application
- Features:
  - Built-in MCP support (stdio transport)
  - Full resource and tool support
  - Prompt templates
  - Works with Ollama via API
- Platform: Windows, macOS, Linux
- Status: Official, actively maintained
- Note: Not open source, but free to use

## Comparison Table

| Application | Ollama Support | MCP Support | Open Source | Platform |
|------------|----------------|-------------|-------------|----------|
| ChatOllama | Native | Yes | Yes | Cross-platform |
| Chat-MCP | Yes | Yes | Yes | Cross-platform |
| MCP Client Chatbot | Yes | Yes | Yes | Cross-platform |
| Dive AI Agent | Yes | Yes | Yes | Cross-platform |
| Luke Desktop | Via API | Yes | Yes | Cross-platform |
| Claude Desktop | Via API | Yes | No | Cross-platform |

## Installation Recommendations

### For Your HLS Streaming MCP Server

Best Choice: Claude Desktop (if you can use proprietary software)
- Most polished and stable
- Best MCP stdio support
- Easy configuration
- Works with Ollama via API

Best Open Source Choice: ChatOllama
- Native Ollama support
- MCP integration
- Active development
- Good documentation

## Quick Setup Guide for Claude Desktop

Since Claude Desktop has the best MCP stdio support, here's how to configure it:

### macOS Configuration
```bash
# Edit Claude Desktop config
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

### Linux Configuration
```bash
# Edit Claude Desktop config
nano ~/.config/Claude/claude_desktop_config.json
```

### Configuration Content
```json
{
  "mcpServers": {
    "hls-streaming": {
      "command": "node",
      "args": [
        "/absolute/path/to/hls-streaming-server/mcp-server/dist/index.js"
      ],
      "env": {
        "HLS_SERVER_URL": "http://localhost:8080",
        "HLS_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Quick Setup Guide for ChatOllama

1. Install ChatOllama:
   ```bash
   git clone https://github.com/sugarforever/chat-ollama.git
   cd chat-ollama
   npm install
   npm run dev
   ```

2. Configure MCP Server:
   - Check ChatOllama's documentation for MCP server configuration
   - Typically uses a similar JSON configuration format

## Resources

- Awesome MCP Clients: https://github.com/punkpeye/awesome-mcp-clients
- MCP Protocol Docs: https://modelcontextprotocol.io/
- Ollama Documentation: https://ollama.ai/docs