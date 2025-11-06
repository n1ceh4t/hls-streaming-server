# Roku HLS Playlist Transition Issue Analysis

## Problem Summary
Roku clients hang when transitioning from one file to the next in m3u8 streams, requiring manual channel reload. Web clients work seamlessly.

## Root Cause Analysis

### 1. Missing EXT-X-DISCONTINUITY Tags
**Issue**: FFmpeg's `discont_start` flag has a critical limitation:
- `discont_start` only adds a discontinuity tag at the **very beginning** of a **new** playlist file
- When using `append_list`, FFmpeg continues appending to an **existing** playlist
- During transitions (File1 ? Bumper ? File2), `discont_start` does **NOT** automatically insert discontinuity tags between segments from different source files

**Evidence**:
- Current playlists examined show no `EXT-X-DISCONTINUITY` tags at transition points
- FFmpeg comments in code incorrectly assume `discont_start` handles all transitions

**RFC 8216 Requirement**:
- Section 6.3.3 states: `EXT-X-DISCONTINUITY` MUST be present when encoding parameters change
- Each new source file has different encoding parameters (codec settings, timestamps, etc.)
- Therefore, discontinuity tags are **required** at every file transition

### 2. Playlist Type Not Explicitly Set
**Issue**: FFmpeg-generated playlists don't include `EXT-X-PLAYLIST-TYPE` tags
- `buildMinimalPlaylist()` includes `EXT-X-PLAYLIST-TYPE:EVENT` for fallback
- Actual FFmpeg playlists omit this tag
- Roku players may require explicit playlist type for proper continuous stream handling

### 3. Roku Player Strictness
**Why web works but Roku doesn't**:
- Roku's `roVideoScreen` (Video component) has stricter HLS compliance requirements
- Web players (HTML5 video) are more forgiving of missing discontinuity tags
- Roku expects RFC 8216 compliant playlists, especially for:
  - Discontinuity markers at encoding parameter changes
  - Proper playlist type declarations
  - Continuous MEDIA-SEQUENCE (which we have with `append_list`)

### 4. Current Implementation Gap
**What we're doing**:
- Using `append_list` to maintain MEDIA-SEQUENCE continuity ?
- Using `discont_start` flag (but it doesn't work for append operations) ?
- Relying on FFmpeg to handle all transitions automatically ?
- Not manually inserting discontinuity tags at transitions ?

**What we need**:
- Manually insert `EXT-X-DISCONTINUITY` tags before first segment of each new file
- Optionally add `EXT-X-DISCONTINUITY-SEQUENCE` for tracking
- Ensure `EXT-X-PLAYLIST-TYPE:EVENT` is present in playlists

## Technical Details from jellyfin-roku Repository

### Roku Video Player Behavior
- Uses `roVideoScreen` component (extends Video)
- Observes content changes and state transitions
- More strict about HLS playlist compliance than web players
- Can hang when encountering unexpected playlist structure during transitions

### Key Findings
- No special HLS handling code found in jellyfin-roku (relies on Roku's native player)
- Roku's native HLS player expects RFC 8216 compliant playlists
- Missing discontinuity tags cause playback to stall during source file transitions

## Recommended Solution (No Code Changes Made)

Based on this analysis, the fix would require:

1. **Post-process FFmpeg playlists during transitions**:
   - Detect when a new file starts (monitor for new segments after file end)
   - Insert `EXT-X-DISCONTINUITY` tag before the first new segment
   - This could be done in `PlaylistService` or `ChannelService`

2. **Ensure playlist type is set**:
   - Modify playlist to include `EXT-X-PLAYLIST-TYPE:EVENT` if missing
   - Or configure FFmpeg to output this (may require post-processing)

3. **Consider using existing infrastructure**:
   - `PlaylistManipulator` class exists but is marked unused
   - `_injectDiscontinuityTag_unused` method exists in ChannelService
   - These were likely disabled when switching to FFmpeg's `append_list` approach

## FFmpeg Flag Limitations

The current FFmpeg flags:
```
-hls_flags append_list+independent_segments+program_date_time+delete_segments+omit_endlist+discont_start
```

**What each does**:
- `append_list`: ? Continues numbering from existing playlist
- `discont_start`: ? Only works for NEW playlist files, not during append operations
- `omit_endlist`: ? Keeps stream open
- `independent_segments`: ? Improves player compatibility
- `program_date_time`: ? Adds timestamps

**The gap**: No automatic discontinuity insertion during `append_list` transitions.

## Conclusion

The bug occurs because:
1. FFmpeg's `discont_start` doesn't work with `append_list` for transitions
2. Missing `EXT-X-DISCONTINUITY` tags violate RFC 8216 requirements
3. Roku players strictly enforce RFC 8216, causing hangs
4. Web players are more forgiving, so they continue working

The solution requires manual intervention to insert discontinuity tags at file transitions, either by:
- Post-processing playlists after FFmpeg writes them
- Using a playlist manipulation service (like the existing but unused `PlaylistManipulator`)
- Monitoring segment generation and injecting tags at transition points
