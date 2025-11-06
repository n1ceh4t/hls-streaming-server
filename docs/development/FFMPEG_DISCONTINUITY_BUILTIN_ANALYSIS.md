# FFmpeg Built-in Discontinuity Tag Support Analysis

## Summary

**FFmpeg does NOT have built-in support for automatically inserting discontinuity tags during `append_list` operations.**

## Current FFmpeg HLS Flags

From FFmpeg 7.1.2 documentation and source code analysis:

### Available Flags:
- `discont_start` - **Only adds discontinuity at the START of a new playlist file**
- `append_list` - Appends new segments to existing playlist
- `delete_segments` - Auto-deletes old segments
- `program_date_time` - Adds EXT-X-PROGRAM-DATE-TIME
- `independent_segments` - Adds EXT-X-INDEPENDENT-SEGMENTS
- `omit_endlist` - Keeps stream open

### The Problem with `discont_start`

From FFmpeg source code (`hlsenc.c`):
```c
if ((hls->flags & HLS_DISCONT_START) && sequence==hls->start_sequence && vs->discontinuity_set==0) {
    avio_printf(byterange_mode ? hls->m3u8_out : vs->out, "#EXT-X-DISCONTINUITY\n");
    vs->discontinuity_set = 1;
    ...
}
```

**Key limitation**: `discont_start` only triggers when:
- `sequence == hls->start_sequence` (the very first segment in a new playlist)
- When `append_list` is used, FFmpeg continues from the existing sequence number
- Therefore, `discont_start` never triggers during append operations

## What FFmpeg Does During `append_list`

1. **Reads existing playlist** to get last segment number
2. **Continues segment numbering** from where it left off
3. **Appends new segments** to the playlist
4. **Does NOT detect codec changes** between different source files
5. **Does NOT insert discontinuity tags** automatically

## Why This Matters

RFC 8216 Section 6.3.3 requires `EXT-X-DISCONTINUITY` when:
- Encoding parameters change
- Number and type of tracks change
- Timestamp sequence changes
- File format changes

**Each new source file has different encoding parameters**, so discontinuity tags are required, but FFmpeg doesn't insert them automatically during `append_list`.

## No Built-in Solution

FFmpeg does not provide:
- ? Automatic codec change detection
- ? Automatic discontinuity insertion during append
- ? Flag to force discontinuity on every new file
- ? Mechanism to detect encoding parameter differences

## Possible Workarounds (Not Built-in)

1. **Manual insertion** (timing issues as analyzed)
2. **Modify playlist on-read** (safest approach)
3. **Use separate playlists** (breaks continuity)
4. **Patch FFmpeg** (requires custom build)
5. **Wait for FFmpeg enhancement** (no timeline)

## Conclusion

**FFmpeg does NOT have built-in support** for automatically inserting discontinuity tags during file transitions when using `append_list`. The `discont_start` flag only works for new playlists, not during append operations.

This confirms that manual intervention is required to fix the Roku compatibility issue, and the safest approach is modifying playlists on-read in PlaylistService rather than modifying the file directly.
