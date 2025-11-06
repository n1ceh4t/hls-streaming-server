# Modify-on-Read Implementation Plan

## Overview

Modify playlists on-read in `PlaylistService` to inject `EXT-X-DISCONTINUITY` tags at file transition points. This avoids all file write race conditions and timing issues.

## Implementation Strategy

### Option 1: Track Transition Points (Recommended)

**Track when transitions occur and which segment numbers they affect:**

1. **Track transition points in ChannelService:**
   - When `startChannel()` is called with a new file (transition detected)
   - Record: `{ channelId, transitionSegmentNumber, timestamp }`
   - Store in a Map or pass to PlaylistService

2. **Inject tags in PlaylistService:**
   - When serving playlist, check if any segments appear after a tracked transition point
   - Insert `#EXT-X-DISCONTINUITY` before the first segment after each transition

**Pros:**
- Precise control
- Knows exactly when transitions occur
- Can track multiple transitions

**Cons:**
- Requires coordination between ChannelService and PlaylistService
- Need to track segment numbers at transition time

### Option 2: Detect Transitions by Segment Analysis

**Analyze playlist content to detect transitions:**

1. **Monitor segment numbering patterns:**
   - Track last segment number seen per channel
   - Detect when new segments appear with gaps
   - Insert discontinuity before segments that appear after a gap

2. **Or analyze PROGRAM-DATE-TIME:**
   - FFmpeg includes `EXT-X-PROGRAM-DATE-TIME` for each segment
   - Large gaps in timestamps indicate transitions
   - Insert discontinuity when timestamp gap exceeds threshold

**Pros:**
- No coordination needed
- Works automatically
- Self-contained in PlaylistService

**Cons:**
- Less precise (may miss some transitions)
- False positives on timestamp gaps
- Harder to detect bumper vs file transitions

### Option 3: Track FFmpeg Process Starts

**Monitor when new FFmpeg processes start:**

1. **In FFmpegEngine.start():**
   - Detect if this is a transition (playlist exists)
   - Record transition point: `{ channelId, segmentNumber, isTransition }`
   - Pass to PlaylistService or store in shared state

2. **In PlaylistService.getPlaylist():**
   - Check for recent transitions
   - Insert discontinuity before segments >= transition segment number

**Pros:**
- Direct knowledge of when transitions occur
- Can distinguish initial start vs transition

**Cons:**
- Need to know segment number at transition time (may not be known yet)
- Timing: segments may not exist when transition is recorded

## Recommended Approach: Hybrid (Option 1 + Option 3)

### Implementation Steps

1. **Add transition tracking to FFmpegEngine:**
   ```typescript
   // In FFmpegEngine.start()
   if (isTransition) {
     // Record that a transition is starting
     // We don't know the segment number yet, but we can track it
   }
   ```

2. **Track first new segment after transition:**
   ```typescript
   // In waitForStreamStart() when transition detected
   // Wait for first new segment, record its number
   // This is the transition point
   ```

3. **Store transition points:**
   ```typescript
   // In PlaylistService or shared state
   private transitionPoints: Map<string, number[]> = new Map();
   // Key: channelId, Value: array of segment numbers where transitions occurred
   ```

4. **Inject in PlaylistService.getPlaylist():**
   ```typescript
   // Parse playlist
   // Find segments >= transition point
   // Insert #EXT-X-DISCONTINUITY before first such segment
   // Remove old transition points (already processed)
   ```

### Key Implementation Details

**When to record transition:**
- After `waitForStreamStart()` confirms first new segment
- Record the segment number from baseline count analysis
- Store: `transitionPoints.set(channelId, [...existing, newSegmentNumber])`

**When to inject:**
- Every time `getPlaylist()` is called
- Parse playlist to find segments
- For each transition point, insert discontinuity before that segment
- Clean up old transition points (segments already served)

**Edge cases:**
- What if playlist is served before transition point is recorded? (Retry on next request)
- What if multiple transitions occur? (Handle all pending transitions)
- What if segment numbers wrap or reset? (Unlikely with append_list, but handle)

## Alternative: Simpler Detection-Based Approach

If coordination is too complex, use **Option 2** with segment analysis:

1. **Track last segment number per channel:**
   ```typescript
   private lastSegmentNumbers: Map<string, number> = new Map();
   ```

2. **Detect transitions:**
   ```typescript
   // When serving playlist, compare current segments to last known
   // If new segments appear with gap > expected, insert discontinuity
   // This handles both file transitions and bumper transitions
   ```

3. **Pros:**
   - Simpler, no coordination needed
   - Works automatically
   - Self-contained

4. **Cons:**
   - Less precise (may miss if segment count is continuous)
   - False positives on gaps

## Recommended: Start with Option 2 (Simpler)

**Start with segment analysis approach** because:
- Easiest to implement
- No coordination between services
- Works automatically
- Can refine later if needed

**Then enhance to Option 1** if needed for precision.
