-- Database Schema Migration
-- Version: 1.0.0
-- Description: Initial database schema for HLS/IPTV streaming server

BEGIN;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    output_dir TEXT NOT NULL,
    video_bitrate INTEGER NOT NULL,
    audio_bitrate INTEGER NOT NULL,
    resolution VARCHAR(20) NOT NULL,
    fps INTEGER NOT NULL,
    segment_duration INTEGER NOT NULL,
    auto_start BOOLEAN DEFAULT FALSE,
    
    -- Runtime state
    state VARCHAR(20) NOT NULL DEFAULT 'idle',
    current_index INTEGER DEFAULT 0,
    viewer_count INTEGER DEFAULT 0,
    started_at TIMESTAMP,
    last_error TEXT,
    last_error_at TIMESTAMP,
    
    -- Virtual Time Progression (Key Feature: Perceived continuous streaming)
    virtual_start_time TIMESTAMP, -- Epoch start of virtual timeline
    virtual_paused_at TIMESTAMP, -- When streaming paused (NULL = actively streaming)
    total_virtual_seconds INTEGER DEFAULT 0, -- Total virtual playback time accumulated
    virtual_current_index INTEGER DEFAULT 0, -- File index in virtual timeline
    virtual_position_in_file INTEGER DEFAULT 0, -- Seconds into current file (virtual time)
    
    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_state CHECK (state IN ('idle', 'starting', 'streaming', 'stopping', 'error')),
    CONSTRAINT valid_bitrate CHECK (video_bitrate > 0 AND audio_bitrate > 0),
    CONSTRAINT valid_fps CHECK (fps > 0 AND fps <= 120),
    CONSTRAINT valid_segment_duration CHECK (segment_duration > 0 AND segment_duration <= 30),
    CONSTRAINT valid_virtual_time CHECK (total_virtual_seconds >= 0 AND virtual_position_in_file >= 0)
);

CREATE INDEX IF NOT EXISTS idx_channels_slug ON channels(slug);
CREATE INDEX IF NOT EXISTS idx_channels_state ON channels(state);
CREATE INDEX IF NOT EXISTS idx_channels_updated_at ON channels(updated_at);
CREATE INDEX IF NOT EXISTS idx_channels_virtual_start ON channels(virtual_start_time) WHERE virtual_start_time IS NOT NULL;

-- Media files table
CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT NOT NULL UNIQUE,
    filename VARCHAR(255) NOT NULL,
    
    -- File metadata
    duration INTEGER NOT NULL,
    file_size BIGINT NOT NULL,
    resolution VARCHAR(20),
    codec VARCHAR(50),
    bitrate INTEGER,
    fps NUMERIC(5,2),
    
    -- Content info
    show_name VARCHAR(255),
    season INTEGER,
    episode INTEGER,
    title VARCHAR(255),
    
    -- Status
    file_exists BOOLEAN DEFAULT TRUE,
    last_scanned_at TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_duration CHECK (duration > 0),
    CONSTRAINT valid_file_size CHECK (file_size > 0)
);

CREATE INDEX IF NOT EXISTS idx_media_files_path ON media_files(path);
CREATE INDEX IF NOT EXISTS idx_media_files_show_name ON media_files(show_name);
CREATE INDEX IF NOT EXISTS idx_media_files_season_episode ON media_files(show_name, season, episode) WHERE show_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_last_scanned ON media_files(last_scanned_at);

-- Channel-media junction table
CREATE TABLE IF NOT EXISTS channel_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    media_file_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(channel_id, position),
    UNIQUE(channel_id, media_file_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_media_channel_id ON channel_media(channel_id);
CREATE INDEX IF NOT EXISTS idx_channel_media_position ON channel_media(channel_id, position);
CREATE INDEX IF NOT EXISTS idx_channel_media_file_id ON channel_media(media_file_id);

-- ============================================================================
-- VIRTUAL TIME PROGRESSION
-- ============================================================================

-- Playback sessions table (tracks actual streaming sessions)
CREATE TABLE IF NOT EXISTS playback_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    session_start TIMESTAMP NOT NULL,
    session_end TIMESTAMP,
    duration_seconds INTEGER,
    virtual_time_at_start INTEGER NOT NULL,
    virtual_time_at_end INTEGER,
    session_type VARCHAR(20) NOT NULL,
    triggered_by VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_session_type CHECK (session_type IN ('started', 'resumed', 'viewer_reconnect', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_playback_sessions_channel ON playback_sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_playback_sessions_time ON playback_sessions(session_start, session_end);
CREATE INDEX IF NOT EXISTS idx_playback_sessions_active ON playback_sessions(channel_id) WHERE session_end IS NULL;

-- ============================================================================
-- FUTURE FEATURES (Phase 2)
-- ============================================================================

-- Schedules table (for scheduled programming)
CREATE TABLE IF NOT EXISTS schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    media_file_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
    title VARCHAR(255),
    description TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_schedules_channel_id ON schedules(channel_id);
CREATE INDEX IF NOT EXISTS idx_schedules_time_range ON schedules(channel_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_schedules_start_time ON schedules(start_time);

-- Viewing history table
CREATE TABLE IF NOT EXISTS viewing_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    media_file_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    viewer_id VARCHAR(255) NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_watched_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    UNIQUE(viewer_id, channel_id, media_file_id)
);

CREATE INDEX IF NOT EXISTS idx_viewing_history_viewer ON viewing_history(viewer_id);
CREATE INDEX IF NOT EXISTS idx_viewing_history_channel ON viewing_history(channel_id);
CREATE INDEX IF NOT EXISTS idx_viewing_history_file ON viewing_history(media_file_id);
CREATE INDEX IF NOT EXISTS idx_viewing_history_last_watched ON viewing_history(last_watched_at);

-- Viewer analytics table
CREATE TABLE IF NOT EXISTS viewer_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    media_file_id UUID REFERENCES media_files(id) ON DELETE CASCADE,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    period_type VARCHAR(10) NOT NULL,
    view_count INTEGER DEFAULT 0,
    unique_viewers INTEGER DEFAULT 0,
    total_watch_time INTEGER DEFAULT 0,
    avg_watch_time INTEGER DEFAULT 0,
    completion_rate NUMERIC(5,2) DEFAULT 0,
    calculated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    UNIQUE(channel_id, media_file_id, period_start, period_type)
);

CREATE INDEX IF NOT EXISTS idx_analytics_channel ON viewer_analytics(channel_id, period_start);
CREATE INDEX IF NOT EXISTS idx_analytics_file ON viewer_analytics(media_file_id, period_start);
CREATE INDEX IF NOT EXISTS idx_analytics_period ON viewer_analytics(period_start, period_type);

-- Content rules table
CREATE TABLE IF NOT EXISTS content_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rule_type VARCHAR(50) NOT NULL,
    conditions JSONB NOT NULL,
    actions JSONB NOT NULL,
    priority INTEGER DEFAULT 0,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_rules_enabled ON content_rules(enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_content_rules_type ON content_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_content_rules_conditions ON content_rules USING GIN (conditions);

-- EPG cache table
CREATE TABLE IF NOT EXISTS epg_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    xml_content TEXT NOT NULL,
    json_content JSONB NOT NULL,
    generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    
    UNIQUE(channel_id)
);

CREATE INDEX IF NOT EXISTS idx_epg_cache_expires ON epg_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_epg_cache_channel ON epg_cache(channel_id);

-- ============================================================================
-- VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW channel_playlist_view AS
SELECT 
    cm.channel_id,
    cm.position,
    mf.id as media_file_id,
    mf.path,
    mf.filename,
    mf.duration,
    mf.show_name,
    mf.season,
    mf.episode,
    mf.title
FROM channel_media cm
JOIN media_files mf ON cm.media_file_id = mf.id
WHERE mf.file_exists = TRUE
ORDER BY cm.channel_id, cm.position;

CREATE OR REPLACE VIEW channel_status_view AS
SELECT 
    c.id,
    c.name,
    c.slug,
    c.state,
    c.viewer_count,
    c.current_index,
    COUNT(DISTINCT cm.id) as media_count,
    mf_current.filename as current_file,
    c.started_at,
    c.last_error
FROM channels c
LEFT JOIN channel_media cm ON c.id = cm.channel_id
LEFT JOIN channel_media cm_current ON c.id = cm_current.channel_id AND cm_current.position = c.current_index
LEFT JOIN media_files mf_current ON cm_current.media_file_id = mf_current.id
GROUP BY c.id, mf_current.filename;

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channels_updated_at ON channels;
CREATE TRIGGER channels_updated_at
    BEFORE UPDATE ON channels
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS media_files_updated_at ON media_files;
CREATE TRIGGER media_files_updated_at
    BEFORE UPDATE ON media_files
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS schedules_updated_at ON schedules;
CREATE TRIGGER schedules_updated_at
    BEFORE UPDATE ON schedules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS content_rules_updated_at ON content_rules;
CREATE TRIGGER content_rules_updated_at
    BEFORE UPDATE ON content_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMIT;

