#!/usr/bin/env node

/**
 * Cross-platform migration runner
 * - Windows: Uses migrate.ts (TypeScript/Node.js)
 * - Linux/Mac: Uses migrate.sh (bash script with psql)
 */

const { spawn } = require('child_process');
const path = require('path');
const isWindows = process.platform === 'win32';

async function runMigration() {
  if (isWindows) {
    // Windows: Use TypeScript migration script
    console.log('🪟 Windows detected - using TypeScript migration script...\n');
    
    const tsxPath = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const migrateTsPath = path.join(__dirname, 'migrate.ts');
    
    const migrateProcess = spawn('node', [tsxPath, migrateTsPath], {
      stdio: 'inherit',
      shell: true,
      cwd: path.join(__dirname, '..'),
    });

    migrateProcess.on('close', (code) => {
      process.exit(code || 0);
    });

    migrateProcess.on('error', (error) => {
      console.error('❌ Failed to run migration:', error.message);
      console.error('\n💡 Make sure you have run: npm install');
      process.exit(1);
    });
  } else {
    // Linux/Mac: Use bash migration script
    console.log('🐧 Linux/Mac detected - using bash migration script...\n');
    
    const migrateShPath = path.join(__dirname, 'migrate.sh');
    
    const migrateProcess = spawn('bash', [migrateShPath], {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });

    migrateProcess.on('close', (code) => {
      process.exit(code || 0);
    });

    migrateProcess.on('error', (error) => {
      console.error('❌ Failed to run migration:', error.message);
      console.error('\n💡 Make sure bash and psql are installed');
      process.exit(1);
    });
  }
}

runMigration().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});

