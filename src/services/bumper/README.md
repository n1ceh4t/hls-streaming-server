# Enhanced Bumper Generator

The bumper generator now supports advanced features while maintaining full backwards compatibility with the original API.

## Backwards Compatibility

The original `BumperConfig` interface still works exactly as before:

```typescript
// Original API - still works!
await bumperGenerator.generateUpNextBumperSegments({
  showName: "Breaking Bad",
  episodeName: "Pilot",
  duration: 10,
  resolution: "1920x1080",
  fps: 30,
  videoBitrate: 1500000,
  audioBitrate: 128000
});
```

## Enhanced Features

### Background Images

Use show posters or channel branding as backgrounds:

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  showName: "Breaking Bad",
  episodeName: "Pilot",
  duration: 10,
  resolution: "1920x1080",
  fps: 30,
  videoBitrate: 1500000,
  audioBitrate: 128000,
  
  // New: Background image
  backgroundImage: "/path/to/show-poster.jpg",
  backgroundBlur: 5, // Optional: blur background (0-10)
  overlayOpacity: 0.6 // Optional: dark overlay for text readability (0.0-1.0)
});
```

### Audio Support

Add background music or channel jingles:

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  // ... base config ...
  
  // New: Audio support
  audioFile: "/path/to/jingle.mp3",
  audioVolume: 0.5, // 0.0 to 1.0
  audioFadeIn: true, // Default: true
  audioFadeOut: true // Default: true
});
```

### Text Animations

Animate text appearance:

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  // ... base config ...
  
  // New: Text animations
  textAnimation: "fadeIn", // "none" | "fadeIn" | "slideUp"
  textAnimationDuration: 0.5 // Animation duration in seconds
});
```

### Countdown Timer

Show a progress indicator:

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  // ... base config ...
  
  // New: Countdown timer
  showCountdown: true,
  countdownPosition: "top-right" // "top-right" | "top-left" | "bottom-right" | "bottom-left"
});
```

### Custom Typography

Customize text appearance:

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  // ... base config ...
  
  // New: Typography
  fontFamily: "/path/to/custom-font.ttf",
  fontSize: 96,
  fontColor: "#FFFFFF",
  textStrokeColor: "#000000", // Text outline
  textStrokeWidth: 2 // Outline width (0-10)
});
```

### Complete Example

```typescript
await bumperGenerator.generateUpNextBumperSegments({
  showName: "Breaking Bad",
  episodeName: "Pilot",
  duration: 10,
  resolution: "1920x1080",
  fps: 30,
  videoBitrate: 1500000,
  audioBitrate: 128000,
  
  // Visual enhancements
  backgroundImage: "/media/posters/breaking-bad.jpg",
  backgroundBlur: 3,
  overlayOpacity: 0.7,
  
  // Audio
  audioFile: "/media/jingles/channel-jingle.mp3",
  audioVolume: 0.4,
  audioFadeIn: true,
  audioFadeOut: true,
  
  // Animation
  textAnimation: "fadeIn",
  textAnimationDuration: 0.6,
  
  // Typography
  fontSize: 84,
  fontColor: "#FFFFFF",
  textStrokeColor: "#000000",
  textStrokeWidth: 2,
  
  // Progress indicator
  showCountdown: true,
  countdownPosition: "top-right"
});
```

## Security Features

All file paths are validated and sanitized to prevent command injection:

- Path validation checks for illegal characters
- Path normalization prevents directory traversal
- Optional base directory restriction
- FFmpeg filter values are properly escaped
- Numeric values are validated and bounded

## Performance

- **Caching**: Bumpers are cached based on content and configuration hash
- **Concurrent Generation**: Multiple bumpers can be generated simultaneously (limited by system resources)
- **Timeout Protection**: Generation automatically times out after 30 seconds
- **Resource Cleanup**: Failed generations are properly cleaned up

## Error Handling

The generator gracefully handles errors:

- Missing background images fall back to solid color
- Missing audio files fall back to silence
- Missing font files fall back to default font
- Invalid paths are rejected with clear error messages
- All errors are logged for debugging

## Migration Guide

**No migration needed!** The original API continues to work. Enhanced features are optional and can be added incrementally.

To enable enhanced features:

1. Start with background images (easiest win)
2. Add audio support
3. Enable animations
4. Add countdown timers
5. Customize typography

All features work independently - enable only what you need.

