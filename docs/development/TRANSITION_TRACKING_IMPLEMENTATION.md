# Transition Tracking Implementation Using Existing Hooks

## Existing Hooks We Can Use

### 1. `onFileEnd` Callback
- **Location**: `ChannelService.onFileEnd` (line 843)
- **Triggered**: When FFmpeg 'end' event fires (file finishes)
- **Current use**: Starts next file/bumper transition
- **Perfect for**: Recording transition point

### 2. `waitForStreamStart` Method
- **Location**: `FFmpegEngine.waitForStreamStart` (line 575)
- **Already tracks**: Baseline segment count and new segments
- **Perfect for**: Recording exact segment number where transition occurs

## Implementation Strategy

### Step 1: Track Transition Points

**In `FFmpegEngine.waitForStreamStart()` when transition is detected:**

```typescript
// When transition completes (newSegments >= 1)
if (isTransition && newSegments >= 1) {
  // The first new segment number is: baselineCount + 1
  const firstNewSegmentNumber = baselineCount + 1;
  
  // Record transition point
  // This is the segment where discontinuity should be inserted
  this.recordTransitionPoint(channelId, firstNewSegmentNumber);
}
```

**Or track in `ChannelService.onFileEnd()` before starting new file:**

```typescript
// In onFileEnd, before starting next file:
// Read current playlist to get last segment number
const playlistPath = path.join(channel.config.outputDir, 'stream.m3u8');
const playlistContent = await fs.readFile(playlistPath, 'utf-8');
const lastSegmentMatch = playlistContent.match(/stream_(\d+)\.ts/g);
const lastSegmentNumber = lastSegmentMatch ? 
  parseInt(lastSegmentMatch[lastSegmentMatch.length - 1].match(/\d+/)?.[0] || '0') : 0;

// Record: next segment will be lastSegmentNumber + 1
// This is where discontinuity should be inserted
playlistService.recordTransitionPoint(channelId, lastSegmentNumber + 1);
```

### Step 2: Store Transition Points

**Add to PlaylistService:**

```typescript
export class PlaylistService {
  // Track pending transition points per channel
  // Key: channelId, Value: Set of segment numbers needing discontinuity tags
  private pendingTransitions: Map<string, Set<number>> = new Map();

  recordTransitionPoint(channelId: string, segmentNumber: number): void {
    if (!this.pendingTransitions.has(channelId)) {
      this.pendingTransitions.set(channelId, new Set());
    }
    this.pendingTransitions.get(channelId)!.add(segmentNumber);
    logger.debug({ channelId, segmentNumber }, 'Recorded transition point');
  }

  clearTransitionPoint(channelId: string, segmentNumber: number): void {
    const transitions = this.pendingTransitions.get(channelId);
    if (transitions) {
      transitions.delete(segmentNumber);
      if (transitions.size === 0) {
        this.pendingTransitions.delete(channelId);
      }
    }
  }
}
```

### Step 3: Inject Tags in getPlaylist()

**Modify `PlaylistService.getPlaylist()`:**

```typescript
async getPlaylist(playlistPath: string): Promise<string> {
  try {
    const content = await fs.readFile(playlistPath, 'utf-8');
    
    // Validate
    if (!content.includes('#EXTM3U')) {
      return this.buildMinimalPlaylist();
    }
    
    // Extract channel ID from path (or pass as parameter)
    const channelId = this.extractChannelIdFromPath(playlistPath);
    const pendingTransitions = this.pendingTransitions.get(channelId);
    
    if (pendingTransitions && pendingTransitions.size > 0) {
      // Inject discontinuity tags
      return this.injectDiscontinuityTags(content, pendingTransitions, channelId);
    }
    
    return content;
  } catch (error) {
    // ... existing error handling
  }
}

private injectDiscontinuityTags(
  content: string, 
  transitions: Set<number>, 
  channelId: string
): string {
  const lines = content.split('\n');
  const newLines: string[] = [];
  const processedTransitions = new Set<number>();
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line contains a segment that needs discontinuity
    const segmentMatch = line.match(/stream_(\d+)\.ts/);
    if (segmentMatch) {
      const segmentNumber = parseInt(segmentMatch[1], 10);
      
      if (transitions.has(segmentNumber)) {
        // Insert discontinuity tag before this segment
        // But only if we haven't already inserted one for this segment
        // Check previous line isn't already a discontinuity tag
        if (newLines[newLines.length - 1] !== '#EXT-X-DISCONTINUITY') {
          newLines.push('#EXT-X-DISCONTINUITY');
          logger.debug({ channelId, segmentNumber }, 'Injected discontinuity tag');
        }
        processedTransitions.add(segmentNumber);
      }
    }
    
    newLines.push(line);
  }
  
  // Clean up processed transitions
  processedTransitions.forEach(segNum => {
    this.clearTransitionPoint(channelId, segNum);
  });
  
  return newLines.join('\n');
}
```

### Step 4: Hook into Transition Points

**Option A: In `waitForStreamStart()` (Better - knows exact segment number):**

```typescript
// In FFmpegEngine.waitForStreamStart()
if (isTransition && newSegments >= 1) {
  // Calculate first new segment number
  // Parse playlist to get actual segment numbers
  const segmentMatches = content.match(/stream_(\d+)\.ts/g);
  if (segmentMatches && segmentMatches.length > baselineCount) {
    const firstNewSegment = segmentMatches[baselineCount];
    const segmentNumber = parseInt(firstNewSegment.match(/\d+/)?.[0] || '0', 10);
    
    // Record transition point
    // Need to pass PlaylistService instance or use a shared service
    // Or emit event that PlaylistService can listen to
  }
}
```

**Option B: In `ChannelService.onFileEnd()` (Simpler - before new file starts):**

```typescript
// In ChannelService.onFileEnd(), before await this.startChannel()
const playlistPath = path.join(channel.config.outputDir, 'stream.m3u8');
try {
  const playlistContent = await fs.readFile(playlistPath, 'utf-8');
  const segments = playlistContent.match(/stream_\d+\.ts/g) || [];
  const lastSegmentMatch = segments[segments.length - 1]?.match(/stream_(\d+)\.ts/);
  
  if (lastSegmentMatch) {
    const lastSegmentNumber = parseInt(lastSegmentMatch[1], 10);
    const nextSegmentNumber = lastSegmentNumber + 1;
    
    // Record transition point
    const playlistService = new PlaylistService();
    playlistService.recordTransitionPoint(channelId, nextSegmentNumber);
    
    logger.debug(
      { channelId, lastSegment: lastSegmentNumber, nextSegment: nextSegmentNumber },
      'Recorded transition point for discontinuity tag'
    );
  }
} catch (error) {
  // Playlist might not exist, that's OK
  logger.debug({ channelId, error }, 'Could not read playlist to record transition point');
}

// Then start next file
await this.startChannel(channelId, nextIndex);
```

## Recommended Approach

**Use Option B (in `onFileEnd`) because:**
1. ? Simpler - happens in one place
2. ? We know exactly when transition occurs
3. ? Can calculate next segment number easily
4. ? No need to modify FFmpegEngine

**Then enhance with Option A if needed** for more precision (wait for first actual segment).

## Implementation Steps

1. ? Add `pendingTransitions` Map to PlaylistService
2. ? Add `recordTransitionPoint()` and `clearTransitionPoint()` methods
3. ? Modify `getPlaylist()` to inject tags
4. ? Add transition point recording in `ChannelService.onFileEnd()`
5. ? Test with Roku client

This approach is clean, uses existing hooks, and avoids all timing issues!
