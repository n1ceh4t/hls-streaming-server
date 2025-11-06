-- Database Schema Migration
-- Version: 1.2.0
-- Description: Library folder management system (Jellyfin-style)

BEGIN;

-- ============================================================================
-- LIBRARY FOLDERS SYSTEM
-- ============================================================================

-- Library Folders: Define media library locations with categories
CREATE TABLE IF NOT EXISTS library_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL UNIQUE,

    -- Category/Type of content (movies, series, anime, sports, music, etc.)
    category VARCHAR(100) NOT NULL DEFAULT 'general',

    -- Scanning options
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    recursive BOOLEAN NOT NULL DEFAULT TRUE,

    -- Scanning status
    last_scan_at TIMESTAMP,
    last_scan_duration_ms INTEGER,
    last_scan_file_count INTEGER DEFAULT 0,

    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_category CHECK (category IN (
        'movies', 'series', 'anime', 'sports', 'music',
        'documentaries', 'standup', 'general'
    ))
);

CREATE INDEX IF NOT EXISTS idx_library_folders_enabled ON library_folders(enabled);
CREATE INDEX IF NOT EXISTS idx_library_folders_category ON library_folders(category);

-- ============================================================================
-- UPDATE MEDIA FILES TABLE
-- ============================================================================

-- Add library folder reference and category to media files (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'media_files' AND column_name = 'library_folder_id') THEN
        ALTER TABLE media_files
            ADD COLUMN library_folder_id UUID REFERENCES library_folders(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'media_files' AND column_name = 'category') THEN
        ALTER TABLE media_files
            ADD COLUMN category VARCHAR(100);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_media_files_library ON media_files(library_folder_id);
CREATE INDEX IF NOT EXISTS idx_media_files_category ON media_files(category);

-- ============================================================================
-- UPDATE TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS update_library_folders_updated_at ON library_folders;
CREATE TRIGGER update_library_folders_updated_at BEFORE UPDATE ON library_folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
