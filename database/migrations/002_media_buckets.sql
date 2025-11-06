-- Database Schema Migration
-- Version: 1.1.0
-- Description: Media buckets system for dynamic playlist management

BEGIN;

-- ============================================================================
-- MEDIA BUCKETS SYSTEM
-- ============================================================================

-- Media Buckets: Organized collections of media (shows, movies, etc.)
CREATE TABLE IF NOT EXISTS media_buckets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    bucket_type VARCHAR(50) NOT NULL, -- 'global', 'channel_specific'
    description TEXT,

    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_bucket_type CHECK (bucket_type IN ('global', 'channel_specific'))
);

CREATE INDEX IF NOT EXISTS idx_media_buckets_type ON media_buckets(bucket_type);

-- Bucket-Media Association: Maps media files to buckets
CREATE TABLE IF NOT EXISTS bucket_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id UUID NOT NULL REFERENCES media_buckets(id) ON DELETE CASCADE,
    media_file_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,

    -- Ordering within bucket (for sequential playback)
    position INTEGER NOT NULL DEFAULT 0,

    -- Metadata
    added_at TIMESTAMP NOT NULL DEFAULT NOW(),

    UNIQUE(bucket_id, media_file_id)
);

CREATE INDEX IF NOT EXISTS idx_bucket_media_bucket ON bucket_media(bucket_id);
CREATE INDEX IF NOT EXISTS idx_bucket_media_position ON bucket_media(bucket_id, position);

-- Channel-Bucket Association: Which buckets are available to which channels
CREATE TABLE IF NOT EXISTS channel_buckets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    bucket_id UUID NOT NULL REFERENCES media_buckets(id) ON DELETE CASCADE,

    -- Priority for random selection (higher = more likely)
    priority INTEGER NOT NULL DEFAULT 1,

    -- Metadata
    added_at TIMESTAMP NOT NULL DEFAULT NOW(),

    UNIQUE(channel_id, bucket_id),
    CONSTRAINT valid_priority CHECK (priority >= 1)
);

CREATE INDEX IF NOT EXISTS idx_channel_buckets_channel ON channel_buckets(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_buckets_bucket ON channel_buckets(bucket_id);

-- Channel Bucket Progression: Tracks where each channel is in each show/bucket
CREATE TABLE IF NOT EXISTS channel_bucket_progression (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    bucket_id UUID NOT NULL REFERENCES media_buckets(id) ON DELETE CASCADE,

    -- Current position in bucket
    last_played_media_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
    current_position INTEGER DEFAULT 0, -- Index in ordered bucket

    -- For episodic content
    current_season INTEGER,
    current_episode INTEGER,

    -- Metadata
    last_played_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    UNIQUE(channel_id, bucket_id),
    CONSTRAINT valid_position CHECK (current_position >= 0)
);

CREATE INDEX IF NOT EXISTS idx_progression_channel ON channel_bucket_progression(channel_id);
CREATE INDEX IF NOT EXISTS idx_progression_bucket ON channel_bucket_progression(bucket_id);

-- ============================================================================
-- SCHEDULE BLOCKS SYSTEM (for future implementation)
-- ============================================================================

-- Schedule Blocks: Time-based programming (e.g., 6am-9am: Cartoons)
CREATE TABLE IF NOT EXISTS schedule_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

    -- Schedule definition
    name VARCHAR(255) NOT NULL,
    day_of_week INTEGER[], -- Array of days (0=Sunday, 6=Saturday), NULL = all days
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,

    -- What to play during this block
    bucket_id UUID REFERENCES media_buckets(id) ON DELETE SET NULL,
    playback_mode VARCHAR(20) DEFAULT 'sequential', -- 'sequential', 'random', 'shuffle'

    -- Priority (for overlapping blocks)
    priority INTEGER NOT NULL DEFAULT 1,

    -- Active/inactive
    enabled BOOLEAN DEFAULT TRUE,

    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_playback_mode CHECK (playback_mode IN ('sequential', 'random', 'shuffle')),
    CONSTRAINT valid_priority CHECK (priority >= 1),
    CONSTRAINT valid_time_range CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_schedule_blocks_channel ON schedule_blocks(channel_id);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_time ON schedule_blocks(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_enabled ON schedule_blocks(enabled);

-- ============================================================================
-- CONTENT OVERRIDES (for future implementation)
-- ============================================================================

-- Content Overrides: One-time content substitutions (e.g., emergency broadcasts)
CREATE TABLE IF NOT EXISTS content_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

    -- Override details
    media_file_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMP NOT NULL,
    duration_seconds INTEGER NOT NULL,

    -- Status
    played BOOLEAN DEFAULT FALSE,
    played_at TIMESTAMP,

    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_duration CHECK (duration_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_content_overrides_channel ON content_overrides(channel_id);
CREATE INDEX IF NOT EXISTS idx_content_overrides_scheduled ON content_overrides(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_content_overrides_played ON content_overrides(played);

-- ============================================================================
-- UPDATE TRIGGERS
-- ============================================================================

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_media_buckets_updated_at ON media_buckets;
CREATE TRIGGER update_media_buckets_updated_at BEFORE UPDATE ON media_buckets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_channel_bucket_progression_updated_at ON channel_bucket_progression;
CREATE TRIGGER update_channel_bucket_progression_updated_at BEFORE UPDATE ON channel_bucket_progression
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_schedule_blocks_updated_at ON schedule_blocks;
CREATE TRIGGER update_schedule_blocks_updated_at BEFORE UPDATE ON schedule_blocks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
