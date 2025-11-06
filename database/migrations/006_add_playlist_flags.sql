-- Migration: Add playlist configuration flags to channels table
-- Adds use_dynamic_playlist and include_bumpers flags for backward-compatible feature toggling

BEGIN;

-- Add use_dynamic_playlist flag (default: false for backward compatibility)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS use_dynamic_playlist BOOLEAN DEFAULT FALSE;

-- Add include_bumpers flag (default: true for backward compatibility)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS include_bumpers BOOLEAN DEFAULT TRUE;

COMMIT;

