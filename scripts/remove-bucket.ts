#!/usr/bin/env tsx

/**
 * Script to manually remove a bucket by name
 */

import { Database } from '../src/infrastructure/database/Database';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('RemoveBucket');

async function removeBucket(bucketName: string) {
  try {
    await Database.initialize();
    logger.info('Database initialized');
    
    // Find the bucket
    const bucketResult = await Database.query<{ id: string; name: string }>(
      'SELECT id, name FROM media_buckets WHERE name = $1',
      [bucketName]
    );
    
    if (bucketResult.rows.length === 0) {
      logger.warn({ bucketName }, 'Bucket not found');
      console.log(`❌ Bucket "${bucketName}" not found in database`);
      return;
    }
    
    const bucket = bucketResult.rows[0];
    logger.info({ bucketId: bucket.id, bucketName: bucket.name }, 'Found bucket to remove');
    console.log(`Found bucket: ${bucket.name} (ID: ${bucket.id})`);
    
    // Check for relationships
    const channelCount = await Database.query(
      'SELECT COUNT(*) as count FROM channel_buckets WHERE bucket_id = $1',
      [bucket.id]
    );
    const mediaCount = await Database.query(
      'SELECT COUNT(*) as count FROM bucket_media WHERE bucket_id = $1',
      [bucket.id]
    );
    const libraryCount = await Database.query(
      'SELECT COUNT(*) as count FROM bucket_libraries WHERE bucket_id = $1',
      [bucket.id]
    );
    const scheduleCount = await Database.query(
      'SELECT COUNT(*) as count FROM schedule_blocks WHERE bucket_id = $1',
      [bucket.id]
    );
    
    const channelCountNum = parseInt(channelCount.rows[0].count);
    const mediaCountNum = parseInt(mediaCount.rows[0].count);
    const libraryCountNum = parseInt(libraryCount.rows[0].count);
    const scheduleCountNum = parseInt(scheduleCount.rows[0].count);
    
    console.log(`\nRelationships found:`);
    console.log(`  - Channels: ${channelCountNum}`);
    console.log(`  - Media files: ${mediaCountNum}`);
    console.log(`  - Libraries: ${libraryCountNum}`);
    console.log(`  - Schedule blocks: ${scheduleCountNum}`);
    
    if (channelCountNum > 0 || mediaCountNum > 0 || libraryCountNum > 0 || scheduleCountNum > 0) {
      console.log(`\n⚠️  Warning: This bucket has relationships that will be removed:`);
      if (channelCountNum > 0) console.log(`   - Will remove ${channelCountNum} channel assignment(s)`);
      if (mediaCountNum > 0) console.log(`   - Will remove ${mediaCountNum} media file assignment(s)`);
      if (libraryCountNum > 0) console.log(`   - Will remove ${libraryCountNum} library assignment(s)`);
      if (scheduleCountNum > 0) console.log(`   - Will set ${scheduleCountNum} schedule block(s) bucket to NULL`);
    }
    
    // Delete in transaction
    await Database.transaction(async (client) => {
      // Remove channel assignments
      if (channelCountNum > 0) {
        await client.query('DELETE FROM channel_buckets WHERE bucket_id = $1', [bucket.id]);
        logger.info({ count: channelCountNum }, 'Removed channel assignments');
      }
      
      // Remove media assignments
      if (mediaCountNum > 0) {
        await client.query('DELETE FROM bucket_media WHERE bucket_id = $1', [bucket.id]);
        logger.info({ count: mediaCountNum }, 'Removed media assignments');
      }
      
      // Remove library assignments
      if (libraryCountNum > 0) {
        await client.query('DELETE FROM bucket_libraries WHERE bucket_id = $1', [bucket.id]);
        logger.info({ count: libraryCountNum }, 'Removed library assignments');
      }
      
      // Set schedule blocks bucket to NULL (don't delete schedule blocks)
      if (scheduleCountNum > 0) {
        await client.query('UPDATE schedule_blocks SET bucket_id = NULL WHERE bucket_id = $1', [bucket.id]);
        logger.info({ count: scheduleCountNum }, 'Cleared schedule block bucket references');
      }
      
      // Finally, delete the bucket
      await client.query('DELETE FROM media_buckets WHERE id = $1', [bucket.id]);
      logger.info({ bucketId: bucket.id }, 'Deleted bucket');
    });
    
    console.log(`\n✅ Successfully removed bucket "${bucketName}"`);
    logger.info({ bucketId: bucket.id, bucketName }, 'Bucket removed successfully');
    
  } catch (error) {
    logger.error({ error }, 'Failed to remove bucket');
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await Database.close();
  }
}

// Get bucket name from command line argument
const bucketName = process.argv[2];

if (!bucketName) {
  console.error('Usage: tsx scripts/remove-bucket.ts "Bucket Name"');
  process.exit(1);
}

removeBucket(bucketName).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

