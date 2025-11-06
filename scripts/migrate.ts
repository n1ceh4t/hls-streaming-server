#!/usr/bin/env tsx

/**
 * Database migration runner script
 * Runs pending database migrations
 */

import { Database } from '../src/infrastructure/database/Database';
import { MigrationRunner } from '../src/infrastructure/database/MigrationRunner';

async function main() {
  try {
    console.log('🚀 Starting database migrations...\n');

    // Initialize database connection
    Database.initialize();

    // Check connection
    const isHealthy = await Database.healthCheck();
    if (!isHealthy) {
      console.error('❌ Database connection failed. Please check your configuration.');
      process.exit(1);
    }

    console.log('✅ Database connection established\n');

    // Run migrations
    const runner = new MigrationRunner('./database/migrations');
    await runner.runMigrations();

    // Check if up to date
    const isUpToDate = await runner.isUpToDate();
    if (isUpToDate) {
      console.log('\n✅ All migrations are up to date');
    }

    // Close connection
    await Database.close();

    console.log('\n✨ Migration process completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    await Database.close().catch(() => {
      // Ignore close errors
    });
    process.exit(1);
  }
}

main();

