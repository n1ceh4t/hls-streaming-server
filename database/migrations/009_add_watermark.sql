-- Migration: Add watermark support to channels
-- Allows channels to have a watermark image (stored as base64) and position

BEGIN;

-- Add watermark columns to channels table
ALTER TABLE channels 
  ADD COLUMN IF NOT EXISTS watermark_image_base64 TEXT,
  ADD COLUMN IF NOT EXISTS watermark_position VARCHAR(20);

-- Add constraint for valid watermark positions (drop first if exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'valid_watermark_position' 
    AND conrelid = 'channels'::regclass
  ) THEN
    ALTER TABLE channels DROP CONSTRAINT valid_watermark_position;
  END IF;
END $$;

ALTER TABLE channels
  ADD CONSTRAINT valid_watermark_position 
  CHECK (watermark_position IS NULL OR watermark_position IN ('top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'));

COMMIT;

