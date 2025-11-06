# Race Condition Analysis: Recording Transition Points

## The Problem with Recording in `onFileEnd()`

### Race Condition 1: Segment Deletion

**Timeline:**
```
Time    Action
0ms     File1 ends (last segment: 050)
10ms    onFileEnd() fires
20ms    We read playlist: segments 041-050 (last = 050)
25ms    We record transition: segment 051
30ms    FFmpeg delete_segments runs, deletes segment 041
35ms    Playlist now shows: segments 042-050, MEDIA-SEQUENCE=42
40ms    Bumper starts with append_list
45ms    FFmpeg reads playlist, sees MEDIA-SEQUENCE=42, last segment=050
50ms    Bumper writes segment 051
```

**Problem**: We recorded transition at 051, but:
- MEDIA-SEQUENCE might have shifted
- Segment numbers might not match what we expect
- The playlist state changed between reading and recording

### Race Condition 2: Bumper Segments

**Timeline:**
```
Time    Action
0ms     File1 ends at segment 050
10ms    onFileEnd() reads playlist, records transition at 051
20ms    Bumper streams (separate FFmpeg process)
30ms    Bumper writes segments 051, 052 (using append_list)
40ms    Bumper ends
50ms    File2 starts (separate FFmpeg process)
60ms    File2 reads playlist, sees last segment = 052
70ms    File2 writes segment 053
```

**Problem**: We recorded transition at 051, but:
- Bumper actually writes 051-052
- File2 starts at 053
- We need discontinuity at 053 (File2 start), not 051 (bumper start)
- We missed the File1?Bumper transition entirely!

### Race Condition 3: MEDIA-SEQUENCE Shifting

**What happens:**
```
Playlist state:
#EXT-X-MEDIA-SEQUENCE:41
stream_041.ts
stream_042.ts
...
stream_050.ts

FFmpeg deletes old segments:
#EXT-X-MEDIA-SEQUENCE:42
stream_042.ts
...
stream_050.ts

New segment added:
#EXT-X-MEDIA-SEQUENCE:42
stream_042.ts
...
stream_050.ts
stream_051.ts  <- New segment
```

**Problem**: We can't reliably use segment numbers because:
- MEDIA-SEQUENCE shifts as old segments are deleted
- The segment number we record might not match the actual segment number
- We need to use MEDIA-SEQUENCE + offset, not absolute segment numbers

### Race Condition 4: Multiple FFmpeg Processes

**The flow:**
1. File1 FFmpeg ends ? writes final segment, may still be updating playlist
2. onFileEnd() fires ? reads playlist (might be mid-update)
3. Bumper FFmpeg starts ? reads playlist, writes segments
4. File2 FFmpeg starts ? reads playlist, writes segments

**Each FFmpeg process:**
- Reads playlist atomically
- Writes segments
- Updates playlist (may delete old segments)
- All happening concurrently or in quick succession

## Better Approach: Record Transition AFTER New File Starts

### Option A: Record in `waitForStreamStart()` (Best)

**When**: After new file's first segment is confirmed

```typescript
// In FFmpegEngine.waitForStreamStart()
if (isTransition && newSegments >= 1) {
  // Read playlist to get actual first new segment number
  const content = await fs.readFile(playlistPath, 'utf-8');
  
  // Parse MEDIA-SEQUENCE to get base
  const mediaSeqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  const mediaSequence = mediaSeqMatch ? parseInt(mediaSeqMatch[1], 10) : 0;
  
  // Find all segments in playlist
  const allSegments = content.match(/stream_(\d+)\.ts/g) || [];
  
  // Calculate which segment is the first new one
  // If we have baselineCount segments, the first new one is at index baselineCount
  if (allSegments.length > baselineCount) {
    const firstNewSegmentMatch = allSegments[baselineCount].match(/stream_(\d+)\.ts/);
    if (firstNewSegmentMatch) {
      const firstNewSegmentNumber = parseInt(firstNewSegmentMatch[1], 10);
      
      // Record transition point
      playlistService.recordTransitionPoint(channelId, firstNewSegmentNumber);
      
      logger.debug(
        { channelId, firstNewSegmentNumber, baselineCount, totalSegments: allSegments.length },
        'Recorded transition point after first new segment confirmed'
      );
    }
  }
}
```

**Pros:**
- ? Knows exact segment number (read from actual playlist)
- ? Happens after FFmpeg has written the segment
- ? Accounts for segment deletion (uses actual playlist state)
- ? Works for both bumper and file transitions

**Cons:**
- ? Requires passing PlaylistService to FFmpegEngine (or event system)
- ? Slightly delayed (after first segment written)

### Option B: Use MEDIA-SEQUENCE + Segment Count

**Track transitions by MEDIA-SEQUENCE + offset:**

```typescript
// In onFileEnd(), before starting new file
const playlistContent = await fs.readFile(playlistPath, 'utf-8');
const mediaSeqMatch = playlistContent.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
const mediaSequence = mediaSeqMatch ? parseInt(mediaSeqMatch[1], 10) : 0;
const segments = playlistContent.match(/stream_\d+\.ts/g) || [];
const segmentCount = segments.length;

// Record: next segment will be at MEDIA-SEQUENCE + segmentCount
// This accounts for MEDIA-SEQUENCE shifting
const nextSegmentNumber = mediaSequence + segmentCount;

playlistService.recordTransitionPoint(channelId, nextSegmentNumber);
```

**Pros:**
- ? Accounts for MEDIA-SEQUENCE shifting
- ? Simple calculation
- ? Happens before new file starts

**Cons:**
- ? Still doesn't account for bumper segments
- ? Might be off if segments are deleted between read and write
- ? Doesn't know if bumper will run

### Option C: Track Multiple Transition Points

**Record transitions for both File?Bumper and Bumper?File:**

```typescript
// In onFileEnd()
const playlistContent = await fs.readFile(playlistPath, 'utf-8');
const mediaSequence = /* parse MEDIA-SEQUENCE */;
const segmentCount = /* count segments */;
const nextSegmentNumber = mediaSequence + segmentCount;

// Record transition point (will be for bumper if bumpers enabled)
playlistService.recordTransitionPoint(channelId, nextSegmentNumber);

// If bumpers are enabled, also record a transition for after bumper
if (includeBumpers && bumperInfo) {
  // Estimate bumper segment count (or read from bumper info)
  const bumperSegmentCount = bumperInfo.segmentCount || 2; // Estimate
  const file2StartSegment = nextSegmentNumber + bumperSegmentCount;
  
  // Record second transition point
  playlistService.recordTransitionPoint(channelId, file2StartSegment);
}
```

**Pros:**
- ? Handles both transitions
- ? Works with bumpers

**Cons:**
- ? Complex (need to track multiple points)
- ? Estimation for bumper segments might be wrong
- ? Still has timing issues

## Recommended: Hybrid Approach

### Step 1: Record Transition Intent in `onFileEnd()`

```typescript
// In ChannelService.onFileEnd()
// Record that a transition is about to happen
// We don't know exact segment number yet, but we'll detect it
playlistService.recordTransitionIntent(channelId, {
  timestamp: Date.now(),
  hasBumper: includeBumpers && !!bumperInfo,
  estimatedBumperSegments: bumperInfo?.segmentCount || 0
});
```

### Step 2: Detect Actual Transition in `waitForStreamStart()`

```typescript
// In FFmpegEngine.waitForStreamStart()
if (isTransition && newSegments >= 1) {
  // Read actual playlist state
  const content = await fs.readFile(playlistPath, 'utf-8');
  const allSegments = content.match(/stream_(\d+)\.ts/g) || [];
  
  // Find first new segment (at index baselineCount)
  if (allSegments.length > baselineCount) {
    const firstNewSegment = allSegments[baselineCount].match(/stream_(\d+)\.ts/);
    if (firstNewSegment) {
      const segmentNumber = parseInt(firstNewSegment[1], 10);
      
      // Record actual transition point
      playlistService.confirmTransitionPoint(channelId, segmentNumber);
    }
  }
}
```

### Step 3: Inject Tags Based on Actual Segments

```typescript
// In PlaylistService.getPlaylist()
// Check for confirmed transition points
// Inject discontinuity before segments that match transition points
```

**This approach:**
- ? Records intent early (knows transition is coming)
- ? Confirms actual segment number after it's written
- ? Handles both bumper and file transitions
- ? Accounts for segment deletion and MEDIA-SEQUENCE shifting

## Alternative: Don't Track Segment Numbers at All

**Instead, detect transitions by analyzing playlist content:**

```typescript
// In PlaylistService.getPlaylist()
// Track last segment number we saw per channel
// If we see a segment number that's significantly higher than expected,
// it's a transition (new file started)

// Or detect by PROGRAM-DATE-TIME gaps:
// If timestamps jump by more than segment duration * 2,
// it's likely a transition
```

**Pros:**
- ? No coordination needed
- ? Self-contained
- ? Works automatically

**Cons:**
- ? Less precise
- ? Might miss some transitions
- ? False positives on timestamp gaps

## Recommendation

**Use the Hybrid Approach (Step 1 + Step 2 + Step 3)** because:
1. Records transition intent early (knows it's coming)
2. Confirms actual segment number after it's written (accurate)
3. Handles all edge cases (bumpers, segment deletion, etc.)
4. Requires coordination but is most reliable

**Or use detection-based approach** if coordination is too complex:
- Simpler to implement
- Self-contained
- Good enough for most cases
