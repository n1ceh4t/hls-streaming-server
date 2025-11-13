-- Migration: Add global settings table
-- Stores server-wide configuration settings (e.g., FFmpeg preset)

BEGIN;

-- Global settings table
CREATE TABLE IF NOT EXISTS global_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(100) NOT NULL UNIQUE,
    value TEXT,
    description TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_global_settings_key ON global_settings(key);

-- Insert default settings (if not exists)
INSERT INTO global_settings (key, value, description)
VALUES 
  ('ffmpeg_preset', 'fast', 'FFmpeg encoding preset (ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow)'),
  ('log_level', 'info', 'Logging level (fatal, error, warn, info, debug, trace)'),
  ('hw_accel', 'none', 'Hardware acceleration (none, nvenc, qsv, videotoolbox)'),
  ('max_concurrent_streams', '8', 'Maximum number of concurrent streams (1-100)'),
  ('enable_auto_scan', 'false', 'Enable automatic library scanning'),
  ('auto_scan_interval', '60', 'Auto scan interval in minutes'),
  ('viewer_disconnect_grace_period', '45', 'Seconds before pausing stream when no viewers')
ON CONFLICT (key) DO NOTHING;

COMMIT;

