# Troubleshooting MCP Server Not Showing in Alpaca

If the MCP server tools are not appearing in Alpaca, follow these steps:

## Step 1: Verify Configuration File

Check that the configuration file exists and is valid:

```bash
cat ~/.var/app/com.jeffser.Alpaca/config/mcp_servers.json
```

The file should contain:
```json
{
  "mcpServers": {
    "hls-streaming": {
      "command": "/path/to/your/mcp-server/run-script.sh",
      "env": {
        "HLS_SERVER_URL": "http://localhost:8080",
        "HLS_API_KEY": "",
        "HLS_SESSION_TOKEN": "",
        "DEBUG": "false"
      }
    }
  }
}
```

## Step 2: Verify MCP Server Files

Ensure all files are in place:

```bash
# Check if MCP server exists
ls -la ~/.local/share/alpaca/mcp-servers/hls-streaming/dist/index.js

# Check if wrapper script exists and is executable
ls -la ~/.local/share/alpaca/mcp-servers/hls-streaming/run-mcp.sh

# Test the wrapper script
~/.local/share/alpaca/mcp-servers/hls-streaming/run-mcp.sh
# (Press Ctrl+C after it starts - it should show "HLS Streaming MCP Server running on stdio")
```

## Step 3: Check Alpaca Logs

Alpaca may log errors when loading MCP servers. Check for log files:

```bash
# Look for log files
find ~/.var/app/com.jeffser.Alpaca -name "*.log" 2>/dev/null

# Check journalctl for Flatpak errors
journalctl --user -u flatpak -f | grep -i alpaca
```

## Step 4: Verify Flatpak Permissions

Ensure Alpaca has filesystem access:

```bash
# Check current overrides
flatpak override --show com.jeffser.Alpaca

# Grant home directory access (if needed)
flatpak override --user --filesystem=home com.jeffser.Alpaca
```

## Step 5: Alternative Configuration Locations

Alpaca might look for configuration in different locations. Try:

1. **User config directory:**
   ```bash
   mkdir -p ~/.config/alpaca
   cp ~/.var/app/com.jeffser.Alpaca/config/mcp_servers.json ~/.config/alpaca/
   ```

2. **Check Alpaca's UI:**
   - Open Alpaca
   - Look for Settings/Preferences
   - Check for "MCP Servers" or "Tools" section
   - Some versions may require adding MCP servers through the UI

## Step 6: Verify JSON Format

Ensure the JSON is valid:

```bash
python3 -m json.tool ~/.var/app/com.jeffser.Alpaca/config/mcp_servers.json
```

If there are errors, fix them.

## Step 7: Restart Alpaca Completely

1. Fully quit Alpaca:
   ```bash
   # Kill any running Alpaca processes
   pkill -f Alpaca
   ```

2. Wait a few seconds

3. Restart Alpaca from the applications menu

## Step 8: Test MCP Server Manually

Test if the MCP server can run:

```bash
cd ~/.local/share/alpaca/mcp-servers/hls-streaming
./run-mcp.sh
```

It should start and wait for MCP protocol messages (no output is normal).

## Step 9: Check Alpaca Version

Some versions of Alpaca may have different MCP support:

```bash
flatpak info com.jeffser.Alpaca | grep Version
```

If you're on an older version, try updating:

```bash
flatpak update com.jeffser.Alpaca
```

## Step 10: Alternative: Use Flatpak-Spawn

If Alpaca can't access host Node.js, try using `flatpak-spawn`:

Update `mcp_servers.json`:
```json
{
  "mcpServers": {
    "hls-streaming": {
      "command": "flatpak-spawn",
      "args": [
        "--host",
        "/usr/bin/node",
        "/path/to/your/mcp-server/dist/index.js"
      ],
      "env": {
        "HLS_SERVER_URL": "http://localhost:8080",
        "HLS_API_KEY": "",
        "HLS_SESSION_TOKEN": "",
        "DEBUG": "false"
      }
    }
  }
}
```

## Step 11: Check Alpaca Documentation

Refer to Alpaca's official documentation or GitHub repository:
- https://github.com/Jeffser/Alpaca
- Check for MCP server integration documentation
- Look for issues or discussions about MCP server setup

## Common Issues

### Issue: "Permission denied"
Solution: Make sure the wrapper script is executable:
```bash
chmod +x ~/.local/share/alpaca/mcp-servers/hls-streaming/run-mcp.sh
```

### Issue: "Node.js not found"
Solution: The wrapper script should find Node.js automatically. If not, update the path in `run-mcp.sh`.

### Issue: "MCP server crashes"
Solution: Enable debug mode:
```json
"DEBUG": "true"
```
Then check Alpaca logs for error messages.

### Issue: "Configuration not loading"
**Solution:** 
- Ensure JSON syntax is valid
- Check file permissions (should be readable)
- Try creating the config in `~/.config/alpaca/` instead

## Still Not Working?

1. Check Alpaca's GitHub Issues:
   - Search for "MCP" related issues
   - Look for configuration examples from other users

2. Verify MCP Protocol:
   - The MCP server uses stdio mode
   - Alpaca should spawn it as a subprocess
   - Check if Alpaca supports MCP protocol v1.0

3. Try a Different Approach:
   - Create a Flatpak extension for the MCP server
   - Or install Alpaca from source if using Flatpak causes issues

## Getting Help

If none of these steps work, provide:
- Alpaca version: `flatpak info com.jeffser.Alpaca | grep Version`
- Configuration file contents
- Any error messages from Alpaca logs
- Operating system and version

