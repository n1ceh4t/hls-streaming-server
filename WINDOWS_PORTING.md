# Windows Porting Guide

## Current Status

The core application is **mostly Windows-compatible**, but several setup and utility scripts need Windows alternatives.

## What Works on Windows

✅ **Core Application**
- All TypeScript source code (uses cross-platform Node.js APIs)
- Path handling (already supports Windows paths: `..\\`)
- FFmpeg integration
- PostgreSQL database operations
- HLS streaming functionality
- Admin web interface

✅ **Alternative Migration Script**
- `npm run migrate:ts` - TypeScript-based migration (works on Windows)

## What Needs Work

### 1. Shell Scripts (6 scripts)

These bash scripts need Windows alternatives:

- `scripts/migrate.sh` → Use `migrate.ts` instead (already exists)
- `scripts/setup-database.sh` → Needs PowerShell version
- `scripts/install.sh` → Needs PowerShell version  
- `scripts/fix-migrations.sh` → Needs PowerShell version
- `scripts/migrate-to-schedule-time.sh` → Needs PowerShell version
- `scripts/prepare-release.sh` → Needs PowerShell version

### 2. Package.json Scripts

**✅ FIXED:**
```json
"migrate": "node scripts/migrate.js"  // Cross-platform wrapper
"migrate:ts": "node node_modules/tsx/dist/cli.mjs scripts/migrate.ts"  // Windows/TypeScript
"migrate:sh": "bash scripts/migrate.sh"  // Linux/Mac (bash)
```

The `migrate.js` wrapper automatically:
- Uses `migrate.ts` on Windows
- Uses `migrate.sh` on Linux/Mac

### 3. Setup Script (`scripts/setup.js`)

Contains Linux-specific commands:
- `apt-get` (package manager)
- `systemctl` (service manager)
- `sudo` (privilege escalation)

**Solution:** Add platform detection and Windows alternatives.

## Implementation Plan

### Phase 1: Quick Wins (1-2 hours)

1. **✅ COMPLETED: Update package.json migration script:**
   ```json
   "migrate": "node scripts/migrate.js"  // Cross-platform wrapper created
   ```
   
   The wrapper automatically detects the platform and uses the appropriate script.

2. **Add platform detection to setup.js:**
   ```javascript
   const isWindows = process.platform === 'win32';
   if (isWindows) {
     // Use Windows commands
   } else {
     // Use Linux commands
   }
   ```

### Phase 2: Create Windows Alternatives (4-6 hours)

1. **Create `scripts/migrate.ps1`** (PowerShell version of migrate.sh)
   - Use `psql` directly (same as bash version)
   - Handle Windows path separators

2. **Create `scripts/setup-database.ps1`**
   - Use `choco` or `winget` for PostgreSQL installation
   - Use Windows service commands instead of `systemctl`
   - Use `net user` or PowerShell for user management

3. **Create `scripts/install.ps1`**
   - Remove `chmod` calls (not needed on Windows)
   - Use Windows-compatible directory creation

### Phase 3: Cross-Platform Setup Script (2-3 hours)

Update `scripts/setup.js` to:
- Detect platform (`process.platform`)
- Use appropriate commands for each platform
- Provide Windows installation instructions
- Handle Windows PostgreSQL setup

### Phase 4: Testing (2-4 hours)

Test on Windows:
- Fresh installation
- Database setup
- Migrations
- Channel creation and streaming
- File path handling with Windows paths

## Windows-Specific Considerations

### PostgreSQL Installation

**Option 1: Manual Installation**
- Download from postgresql.org
- Use pgAdmin or psql command line

**Option 2: Package Manager**
- Chocolatey: `choco install postgresql`
- Winget: `winget install PostgreSQL.PostgreSQL`

### FFmpeg Installation

**Option 1: Manual**
- Download from ffmpeg.org
- Add to PATH

**Option 2: Package Manager**
- Chocolatey: `choco install ffmpeg`
- Winget: `winget install Gyan.FFmpeg`

### Path Handling

The code already handles Windows paths correctly:
- Uses `path.normalize()` (cross-platform)
- Checks for both `../` and `..\\` in path traversal detection
- Uses `path.sep` for path separators

### File Permissions

Windows doesn't use Unix-style permissions:
- Remove `chmod` calls (already handled in install.sh with platform check)
- Windows uses ACLs instead

## Recommended Approach

### Minimal Changes (Recommended)

1. **Update package.json:**
   ```json
   "migrate": "npm run migrate:ts"
   ```

2. **Add Windows instructions to README:**
   - Manual PostgreSQL installation
   - Manual FFmpeg installation
   - Use `npm run migrate:ts` instead of `npm run migrate`

3. **Update setup.js with platform detection:**
   - Skip automatic PostgreSQL installation on Windows
   - Provide manual instructions instead

### Full Windows Support (If Needed)

Create PowerShell equivalents for all scripts and add comprehensive Windows testing.

## Testing Checklist

- [ ] Install Node.js, FFmpeg, PostgreSQL on Windows
- [ ] Run `npm install`
- [ ] Run `npm run build`
- [ ] Run `npm run migrate:ts`
- [ ] Run `npm run setup` (with Windows detection)
- [ ] Create a channel via API
- [ ] Start streaming
- [ ] Test with Windows paths (e.g., `C:\Media\Movies`)
- [ ] Test file path traversal detection

## Estimated Effort

- **Minimal (Recommended)**: 2-3 hours
  - Update package.json
  - Add Windows instructions
  - Platform detection in setup.js

- **Full Windows Support**: 1-2 days
  - Create PowerShell scripts
  - Comprehensive testing
  - Documentation updates

## Conclusion

The application is **already mostly Windows-compatible**. The main work is:
1. Providing Windows alternatives for setup scripts
2. Updating documentation
3. Testing on Windows

The core functionality should work without changes.

