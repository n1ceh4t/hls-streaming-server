-- Migration: Add schedule_start_time for simplified time tracking
-- Replaces complex virtual time tracking with a single timestamp anchor
-- This timestamp represents when the channel's schedule begins (never changes after initialization)

BEGIN;

-- Add schedule_start_time column
ALTER TABLE channels ADD COLUMN IF NOT EXISTS schedule_start_time TIMESTAMP;

-- For existing channels with virtual_start_time, copy it over as initial value
UPDATE channels
SET schedule_start_time = virtual_start_time
WHERE virtual_start_time IS NOT NULL AND schedule_start_time IS NULL;

-- Add index for efficient queries
CREATE INDEX IF NOT EXISTS idx_channels_schedule_start ON channels(schedule_start_time) WHERE schedule_start_time IS NOT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN channels.schedule_start_time IS 'Permanent anchor timestamp for calculating current playback position. Set once on channel initialization, never updated.';

COMMIT;
