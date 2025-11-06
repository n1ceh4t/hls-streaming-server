-- Database Schema Migration
-- Version: 1.5.0
-- Description: Add library-to-bucket assignment system

BEGIN;

-- ============================================================================
-- BUCKET LIBRARIES SYSTEM
-- ============================================================================

-- Bucket Libraries: Many-to-many relationship between buckets and libraries
-- When a library is assigned to a bucket, all media files from that library
-- are automatically added to the bucket when the library is scanned.
CREATE TABLE IF NOT EXISTS bucket_libraries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id UUID NOT NULL REFERENCES media_buckets(id) ON DELETE CASCADE,
    library_folder_id UUID NOT NULL REFERENCES library_folders(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    
    -- Ensure one library can only be assigned to a bucket once
    UNIQUE(bucket_id, library_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_bucket_libraries_bucket ON bucket_libraries(bucket_id);
CREATE INDEX IF NOT EXISTS idx_bucket_libraries_library ON bucket_libraries(library_folder_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- No triggers needed for this table

COMMIT;

