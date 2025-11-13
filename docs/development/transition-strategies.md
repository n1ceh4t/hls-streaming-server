# File Transition Strategies

## Current Approach: Early Start (7 seconds before end)

**How it works:**
- Start next FFmpeg process 7 seconds before current file ends
- Kills current process early, next file starts writing segments immediately
- When transition point arrives, segments are already available

**Pros:**
- Simple implementation
- Segments ready when needed
- Eliminates gaps

**Cons:**
- Cuts ~7 seconds from end of each file
- Requires precise timing calculations
- Race conditions if file ends naturally before early start

---

## Alternative 1: Increase Segment Duration (6s → 10-12s)

**How it works:**
- Increase `segmentDuration` from 6s to 10-12s
- Larger segments = more buffer time during transitions
- Early start would cut less content (only 1 segment instead of 1.2 segments)

**Pros:**
- Simpler logic (less cutting)
- More buffer for players
- Less frequent segment requests (reduced server load)
- Better for slower networks

**Cons:**
- **Higher latency** (10-12s vs 6s initial delay)
- Larger file sizes (more bandwidth per segment)
- Slower seeking (must wait for larger segments)
- Still cuts content (just less)

**Recommendation:** Good if latency isn't critical (e.g., TV channels, not live events)

---

## Alternative 2: Pre-Generate First Segment of Next File

**How it works:**
- Before transition, generate the first segment of the next file
- Store it temporarily
- When current file ends, immediately append pre-generated segment to playlist
- Then start FFmpeg to continue from segment 2

**Pros:**
- No content cutting
- Seamless transition
- Segments ready immediately

**Cons:**
- **Complex implementation** (segment file management)
- Storage overhead (temporary segments)
- Must ensure segment numbering continuity
- Risk of stale segments if media list changes

**Recommendation:** Most seamless but most complex

---

## Alternative 3: Concat Demuxer (Single FFmpeg Process)

**How it works:**
- Single FFmpeg process streams multiple files using `-f concat` demuxer
- Create concat file listing all files in sequence
- FFmpeg handles transitions internally
- No separate processes per file

**Pros:**
- **Truly seamless** (no transitions at all)
- No content cutting
- Single process (simpler state management)
- FFmpeg handles all transitions

**Cons:**
- **Major refactor** (completely different architecture)
- Must regenerate concat file when media list changes
- Harder to seek to specific files
- Can't easily skip files or handle schedule changes mid-stream

**Recommendation:** Best long-term solution but requires significant rewrite

---

## Alternative 4: Start Earlier (2x Segment Duration)

**How it works:**
- Start next file 12-14 seconds early (2x segment duration)
- More buffer time
- Less risk of gaps

**Pros:**
- More segments ready
- Safer timing

**Cons:**
- Cuts more content (12-14 seconds)
- Still has race conditions

**Recommendation:** Not ideal - cuts too much content

---

## Alternative 5: Hybrid - Longer Segments + Early Start

**How it works:**
- Increase segment duration to 10s
- Start next file 10-11 seconds early
- Cuts exactly 1 segment (10s) instead of 1.2 segments (7s)

**Pros:**
- Cleaner cuts (exact segment boundaries)
- More buffer
- Less complex than pre-generation

**Cons:**
- Still cuts content
- Higher latency

**Recommendation:** Good middle ground

---

## Comparison Table

| Approach | Content Loss | Complexity | Latency | Seamless | Implementation |
|----------|--------------|------------|---------|----------|----------------|
| **Current (7s early)** | ~7s per file | Medium | 6s | Good | ✅ Done |
| **10s segments** | ~10s per file | Low | 10s | Good | Easy |
| **12s segments** | ~12s per file | Low | 12s | Good | Easy |
| **Pre-generate** | 0s | High | 6s | Excellent | Hard |
| **Concat demuxer** | 0s | Very High | 6s | Perfect | Very Hard |
| **Hybrid (10s + early)** | ~10s | Medium | 10s | Good | Medium |

---

## Recommendations

### For Immediate Fix (Low Risk):
**Increase segment duration to 10 seconds**
- Change `DEFAULT_SEGMENT_DURATION` from 6 to 10
- Adjust early start to 10-11 seconds
- Simple config change, minimal code changes

### For Best User Experience:
**Pre-generate first segment approach**
- Most seamless without major refactor
- Requires segment file management
- Medium complexity

### For Long-Term Solution:
**Concat demuxer architecture**
- Perfect transitions
- Requires significant refactor
- Best for stable playlists

---

## Implementation Notes

### Increasing Segment Duration:
```typescript
// In config/env.ts
DEFAULT_SEGMENT_DURATION: z.coerce.number().min(1).max(30).default(10), // Changed from 6

// In ChannelService.ts - adjust early start
if (remainingDuration > 11 && !isTransition) { // Changed from 7
  const earlyStartDelay = Math.max(0, (remainingDuration - 11) * 1000); // Changed from 7
  // ...
}
```

### Pre-Generate Approach:
1. Before transition, call FFmpeg to generate first segment of next file
2. Store in temp location with correct naming
3. When current file ends, copy pre-generated segment to output dir
4. Start FFmpeg from segment 2 (using `-ss` to skip first segment)

### Concat Demuxer:
1. Generate concat file: `file '/path/to/file1.mp4'\nfile '/path/to/file2.mp4'`
2. Single FFmpeg process: `ffmpeg -f concat -i concat.txt -c copy ...`
3. Update concat file when media list changes (requires process restart)
