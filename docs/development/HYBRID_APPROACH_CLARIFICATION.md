# Hybrid Approach: Modify on Read, Not File

## Key Point: We Modify the Response, NOT the File

### What We Do

**In `PlaylistService.getPlaylist()`:**
1. Read the actual playlist file from disk (FFmpeg's version, untouched)
2. Parse the content
3. Inject `#EXT-X-DISCONTINUITY` tags into the content before serving
4. Return the modified content to the client
5. **Never write back to the file**

### What We DON'T Do

- ? Modify the playlist file on disk
- ? Write changes back to `stream.m3u8`
- ? Intercept FFmpeg's file operations
- ? Lock files or coordinate writes

## How It Works

### Step 1: Record Transition Intent (onFileEnd)

```typescript
// In ChannelService.onFileEnd()
// Just record that a transition is coming
// We don't know the exact segment number yet
playlistService.recordTransitionIntent(channelId, {
  timestamp: Date.now(),
  hasBumper: includeBumpers && !!bumperInfo
});
```

**No file operations** - just in-memory tracking.

### Step 2: Confirm Actual Segment Number (waitForStreamStart)

```typescript
// In FFmpegEngine.waitForStreamStart()
// After first new segment is confirmed
const content = await fs.readFile(playlistPath, 'utf-8'); // READ ONLY
const firstNewSegmentNumber = /* parse from content */;

// Record the actual segment number
playlistService.confirmTransitionPoint(channelId, firstNewSegmentNumber);
```

**Read-only file operation** - just reading to find the segment number.

### Step 3: Inject Tags on Read (getPlaylist)

```typescript
// In PlaylistService.getPlaylist()
async getPlaylist(playlistPath: string): Promise<string> {
  // Read FFmpeg's playlist file (unchanged)
  const content = await fs.readFile(playlistPath, 'utf-8');
  
  // Get transition points for this channel
  const transitionPoints = this.getTransitionPoints(channelId);
  
  if (transitionPoints.size > 0) {
    // Parse and modify the content in memory
    const modifiedContent = this.injectDiscontinuityTags(content, transitionPoints);
    
    // Return modified content (file on disk is unchanged)
    return modifiedContent;
  }
  
  // No transitions, return original
  return content;
}

private injectDiscontinuityTags(
  content: string,
  transitions: Set<number>
): string {
  const lines = content.split('\n');
  const newLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this segment needs a discontinuity tag
    const segmentMatch = line.match(/stream_(\d+)\.ts/);
    if (segmentMatch && transitions.has(parseInt(segmentMatch[1], 10))) {
      // Insert discontinuity tag before this segment
      if (newLines[newLines.length - 1] !== '#EXT-X-DISCONTINUITY') {
        newLines.push('#EXT-X-DISCONTINUITY');
      }
    }
    
    newLines.push(line);
  }
  
  // Return modified content (file is unchanged)
  return newLines.join('\n');
}
```

**Only read operations** - file is never written to.

## Flow Diagram

```
Client Request ? GET /:slug/stream.m3u8
    ?
PlaylistService.getPlaylist()
    ?
Read stream.m3u8 (FFmpeg's file, untouched)
    ?
Parse content
    ?
Check for transition points
    ?
Inject #EXT-X-DISCONTINUITY tags (in memory)
    ?
Return modified content to client
    ?
File on disk: UNCHANGED
```

## Why This Is Safe

1. **No race conditions**: We never write to the file, so no conflicts with FFmpeg
2. **No timing issues**: We read when serving, not when FFmpeg is writing
3. **Always current**: Each request gets the latest playlist state
4. **No file corruption**: File is never modified
5. **No coordination**: FFmpeg writes, we read separately

## Storage of Transition Points

**In-memory only:**

```typescript
export class PlaylistService {
  // In-memory tracking (no file operations)
  private transitionPoints: Map<string, Set<number>> = new Map();
  
  recordTransitionIntent(channelId: string, info: TransitionInfo): void {
    // Just store in memory
  }
  
  confirmTransitionPoint(channelId: string, segmentNumber: number): void {
    // Just update in-memory map
  }
  
  getTransitionPoints(channelId: string): Set<number> {
    // Return from memory
    return this.transitionPoints.get(channelId) || new Set();
  }
}
```

**No persistence needed** - transitions are temporary (until segments are served).

## Comparison: Modify File vs Modify on Read

### Modify File (What We DON'T Do)
```
FFmpeg writes playlist ? We read ? We modify ? We write back
    ?
Race condition! FFmpeg might write again
    ?
Timing issues! When do we write?
    ?
File corruption risk!
```

### Modify on Read (What We DO)
```
FFmpeg writes playlist ? Client requests ? We read ? We modify in memory ? Return to client
    ?
No race condition! We never write
    ?
No timing issues! We read when serving
    ?
No file corruption! File is untouched
```

## Summary

**The hybrid approach modifies the playlist content in memory when serving it to clients.**

- ? Read the file
- ? Modify in memory
- ? Return modified content
- ? Never write to the file
- ? Never modify FFmpeg's file

This is the **modify-on-read** approach we discussed earlier - it's the safest way to inject discontinuity tags without any file system race conditions.
