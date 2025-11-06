#!/usr/bin/env node

/**
 * Quick setup script for HLS/IPTV Server
 * Helps users configure the server interactively
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execSync } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkPostgreSQLInstalled() {
  return commandExists('psql');
}

function checkPostgreSQLRunning() {
  try {
    execSync('pg_isready -h localhost -p 5432', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function setupDatabase(dbName, dbUser, dbPassword) {
  console.log('\n🗄️  Setting up PostgreSQL database...');
  
  // Check if PostgreSQL is installed
  if (!checkPostgreSQLInstalled()) {
    const install = await question('PostgreSQL is not installed. Install it now? (Y/n): ');
    if (install.toLowerCase() !== 'n') {
      console.log('Installing PostgreSQL (this may require sudo password)...');
      try {
        execSync('sudo apt-get update -qq', { stdio: 'inherit' });
        execSync('sudo apt-get install -y postgresql postgresql-contrib', { stdio: 'inherit' });
        console.log('✅ PostgreSQL installed');
      } catch (error) {
        console.error('❌ Failed to install PostgreSQL. Please install manually:');
        console.error('   sudo apt-get install postgresql postgresql-contrib');
        return false;
      }
    } else {
      console.log('⚠️  Skipping PostgreSQL installation. Please install it manually.');
      return false;
    }
  }

  // Check if PostgreSQL is running
  if (!checkPostgreSQLRunning()) {
    const start = await question('PostgreSQL service is not running. Start it now? (Y/n): ');
    if (start.toLowerCase() !== 'n') {
      console.log('Starting PostgreSQL service...');
      try {
        execSync('sudo systemctl start postgresql', { stdio: 'inherit' });
        execSync('sudo systemctl enable postgresql', { stdio: 'inherit' });
        console.log('✅ PostgreSQL service started');
        
        // Wait a moment for service to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('❌ Failed to start PostgreSQL. Please start it manually:');
        console.error('   sudo systemctl start postgresql');
        return false;
      }
    } else {
      console.log('⚠️  Skipping PostgreSQL startup. Please start it manually.');
      return false;
    }
  }

  // Create database and user
  console.log('Creating database and user...');
  try {
    // Check if we need to create a new user or use postgres
    const usePostgresUser = dbUser === 'postgres';
    
    if (!usePostgresUser && dbPassword) {
      // Create new user
      try {
        execSync(
          `sudo -u postgres psql -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPassword}';"`,
          { stdio: 'ignore' }
        );
        console.log(`✅ Created user: ${dbUser}`);
      } catch (error) {
        // User might already exist, that's okay
        console.log(`ℹ️  User ${dbUser} may already exist, continuing...`);
      }
    }

    // Create database
    try {
      const ownerCmd = usePostgresUser ? '' : `OWNER ${dbUser}`;
      execSync(
        `sudo -u postgres psql -c "CREATE DATABASE ${dbName} ${ownerCmd};"`,
        { stdio: 'ignore' }
      );
      console.log(`✅ Created database: ${dbName}`);
    } catch (error) {
      // Database might already exist, that's okay
      console.log(`ℹ️  Database ${dbName} may already exist, continuing...`);
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to create database. Error:', error.message);
    return false;
  }
}

async function runMigrations() {
  console.log('\n🔄 Running database migrations...');
  try {
    // Check if dependencies are installed
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      console.error('❌ Dependencies not installed. Please run: npm install');
      console.error('   Then run migrations manually with: npm run migrate');
      return false;
    }

    // Check if psql is available (required for migrate.sh)
    if (!commandExists('psql')) {
      console.error('❌ psql command not found. PostgreSQL client tools are required.');
      console.error('   Install with: sudo apt-get install postgresql-client');
      return false;
    }

    const { execSync } = require('child_process');
    execSync('npm run migrate', { stdio: 'inherit' });
    console.log('✅ Migrations completed successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to run migrations');
    if (error.message) {
      console.error(`   Error: ${error.message}`);
    }
    console.error('   Possible causes:');
    console.error('   - Database not running');
    console.error('   - Wrong database credentials in .env');
    console.error('   - Database not created yet');
    console.error('   - PostgreSQL client tools not installed');
    console.error('   You can run migrations manually with: npm run migrate');
    return false;
  }
}

function validatePort(portInput) {
  const port = parseInt(portInput, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return { valid: false, port: null };
  }
  return { valid: true, port };
}

function validateMediaPaths(mediaDirsInput) {
  if (!mediaDirsInput || !mediaDirsInput.trim()) {
    return { valid: false, dirs: [], warnings: ['Media directories cannot be empty'] };
  }

  const dirs = mediaDirsInput.split(',').map(d => d.trim()).filter(d => d.length > 0);
  const warnings = [];

  for (const dir of dirs) {
    // Check if path exists
    if (!fs.existsSync(dir)) {
      warnings.push(`⚠️  Directory does not exist: ${dir}`);
    } else {
      // Check if it's actually a directory
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory()) {
          warnings.push(`⚠️  Path is not a directory: ${dir}`);
        }
      } catch (err) {
        warnings.push(`⚠️  Cannot access path: ${dir}`);
      }
    }
  }

  return { valid: dirs.length > 0, dirs, warnings };
}

async function setup() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   HLS/IPTV Streaming Server - Quick Setup       ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  // Check if dependencies are installed (optional check, don't fail if not)
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('⚠️  Note: Dependencies not yet installed.');
    console.log('   You can run this setup before or after npm install.\n');
  }

  // Check if .env already exists
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const overwrite = await question('.env file already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
    // Backup existing .env
    const backupPath = `${envPath}.backup.${Date.now()}`;
    try {
      fs.copyFileSync(envPath, backupPath);
      console.log(`✅ Backed up existing .env to ${path.basename(backupPath)}\n`);
    } catch (err) {
      console.log('⚠️  Could not backup existing .env file\n');
    }
  }

  console.log('Let\'s configure your server!\n');

  // Media directories with validation
  console.log('📁 Media Directories');
  console.log('Enter the paths to your media files (comma-separated)');
  console.log('Example: /media/movies,/media/shows,/home/user/Videos\n');
  
  let mediaDirs;
  let mediaDirsValid = false;
  while (!mediaDirsValid) {
    const mediaDirsInput = await question('Media directories: ');
    const validation = validateMediaPaths(mediaDirsInput);
    
    if (validation.valid) {
      mediaDirs = validation.dirs.join(',');
      if (validation.warnings.length > 0) {
        console.log('');
        validation.warnings.forEach(w => console.log(w));
        const proceed = await question('\nContinue anyway? (y/N): ');
        if (proceed.toLowerCase() === 'y') {
          mediaDirsValid = true;
        }
      } else {
        mediaDirsValid = true;
      }
    } else {
      console.log('❌ Invalid input. Please enter at least one valid directory path.');
    }
  }

  // API Key
  console.log('\n🔐 Security');
  const useRandomKey = await question('Generate a random API key? (Y/n): ');
  let apiKey;
  if (useRandomKey.toLowerCase() === 'n') {
    apiKey = await question('Enter your API key: ');
  } else {
    apiKey = generateApiKey();
    console.log(`Generated API key: ${apiKey}`);
  }

  // Port with validation
  console.log('\n🌐 Network');
  let port;
  let portValid = false;
  while (!portValid) {
    const portInput = await question('Server port (default: 8080): ') || '8080';
    const validation = validatePort(portInput);
    if (validation.valid) {
      port = validation.port;
      portValid = true;
    } else {
      console.log('❌ Invalid port. Please enter a number between 1 and 65535.');
    }
  }

  // Streaming quality
  console.log('\n🎬 Streaming Quality');
  console.log('1. Low (720p, 1Mbps)');
  console.log('2. Medium (1080p, 1.5Mbps) [Default]');
  console.log('3. High (1080p, 3Mbps)');
  console.log('4. Ultra (4K, 8Mbps)');
  const quality = await question('Select quality (1-4): ') || '2';

  const qualities = {
    '1': { resolution: '1280x720', videoBitrate: '1000000', audioBitrate: '96000' },
    '2': { resolution: '1920x1080', videoBitrate: '1500000', audioBitrate: '128000' },
    '3': { resolution: '1920x1080', videoBitrate: '3000000', audioBitrate: '192000' },
    '4': { resolution: '3840x2160', videoBitrate: '8000000', audioBitrate: '256000' },
  };

  const selectedQuality = qualities[quality] || qualities['2'];

  // Hardware acceleration
  console.log('\n⚡ Hardware Acceleration');
  console.log('1. None (CPU only) [Default]');
  console.log('2. NVIDIA (nvenc)');
  console.log('3. Intel (qsv)');
  console.log('4. Apple (videotoolbox)');
  const hwAccel = await question('Select acceleration (1-4): ') || '1';

  const hwAccelMap = {
    '1': 'none',
    '2': 'nvenc',
    '3': 'qsv',
    '4': 'videotoolbox',
  };

  // Database configuration
  console.log('\n🗄️  Database Configuration');
  const useDatabase = await question('Configure PostgreSQL database? (Y/n): ') || 'y';
  let dbHost = 'localhost';
  let dbPort = '5432';
  let dbName = 'hls_streaming';
  let dbUser = 'postgres';
  let dbPassword = '';
  let dbUseSsl = 'false';
  let dbSetupSuccess = false;

  if (useDatabase.toLowerCase() !== 'n') {
    dbHost = await question('Database host (default: localhost): ') || 'localhost';
    dbPort = await question('Database port (default: 5432): ') || '5432';
    dbName = await question('Database name (default: hls_streaming): ') || 'hls_streaming';
    
    const createNewUser = await question('Create a new database user? (Y/n): ') || 'y';
    if (createNewUser.toLowerCase() !== 'n') {
      dbUser = await question('Database user name (default: hls_user): ') || 'hls_user';
      
      // Password generation options
      console.log('\nPassword options:');
      console.log('1. Generate a random secure password (recommended)');
      console.log('2. Enter your own password');
      const passwordChoice = await question('Choose option (1/2, default: 1): ') || '1';
      
      if (passwordChoice === '2') {
        dbPassword = await question('Database password (min 8 characters): ');
        if (!dbPassword || dbPassword.length < 8) {
          console.log('⚠️  Password too short. Generating a secure random password instead...');
          dbPassword = crypto.randomBytes(16).toString('hex');
          console.log(`Generated password: ${dbPassword}`);
        }
      } else {
        dbPassword = crypto.randomBytes(16).toString('hex');
        console.log(`✅ Generated secure password: ${dbPassword}`);
        console.log('⚠️  IMPORTANT: Save this password! It will be saved to your .env file.');
      }
    } else {
      dbUser = await question('Database user (default: postgres): ') || 'postgres';
      dbPassword = await question('Database password (leave empty if none): ') || '';
    }
    
    const sslChoice = await question('Use SSL? (y/N): ');
    dbUseSsl = sslChoice.toLowerCase() === 'y' ? 'true' : 'false';

    // Setup database if on localhost
    if (dbHost === 'localhost' || dbHost === '127.0.0.1') {
      const autoSetup = await question('Automatically install and setup PostgreSQL database? (Y/n): ') || 'y';
      if (autoSetup.toLowerCase() !== 'n') {
        dbSetupSuccess = await setupDatabase(dbName, dbUser, dbPassword);
        
        // Run migrations automatically after successful database setup
        if (dbSetupSuccess) {
          const runMigrationsNow = await question('Run database migrations now? (Y/n): ') || 'y';
          if (runMigrationsNow.toLowerCase() !== 'n') {
            await runMigrations();
          }
        }
      }
    } else {
      console.log('ℹ️  Skipping automatic database setup for remote host.');
      console.log('   Please ensure the database exists and user has proper permissions.');
    }
  }

  // Create .env content
  const envContent = `# HLS/IPTV Server Configuration
# Generated by setup script on ${new Date().toISOString()}

# Server Configuration
NODE_ENV=development
PORT=${port}
HOST=0.0.0.0
WEBSOCKET_PORT=8081

# Media Configuration
MEDIA_DIRECTORIES=${mediaDirs}
HLS_OUTPUT_DIR=./hls_output
TEMP_DIR=./temp

# Streaming Configuration
DEFAULT_VIDEO_BITRATE=${selectedQuality.videoBitrate}
DEFAULT_AUDIO_BITRATE=${selectedQuality.audioBitrate}
DEFAULT_RESOLUTION=${selectedQuality.resolution}
DEFAULT_FPS=30
DEFAULT_SEGMENT_DURATION=6
MAX_CONCURRENT_STREAMS=8

# Security Configuration
API_KEY=${apiKey}
REQUIRE_AUTH=true
RATE_LIMIT_MAX=1000
RATE_LIMIT_WINDOW_MS=900000

# Feature Flags
ENABLE_EPG=true
ENABLE_ANALYTICS=true
ENABLE_AUTO_SCAN=true
AUTO_SCAN_INTERVAL=60

# Logging
LOG_LEVEL=info
LOG_FORMAT=pretty

# FFmpeg Configuration
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
HW_ACCEL=${hwAccelMap[hwAccel] || 'none'}

# Advanced
SEGMENT_CLEANUP_INTERVAL=30
SEGMENT_MAX_AGE=300
SESSION_TIMEOUT=300

# Database Configuration
${useDatabase.toLowerCase() !== 'n' ? `DB_HOST=${dbHost}
DB_PORT=${dbPort}
DB_NAME=${dbName}
DB_USER=${dbUser}
DB_PASSWORD=${dbPassword}
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_SSL=${dbUseSsl}` : '# Database disabled - configure DB_* variables to enable'}
`;

  // Write .env file
  fs.writeFileSync(envPath, envContent);

  console.log('\n✅ Configuration saved to .env');
  console.log('\n📋 Summary:');
  console.log(`   Media directories: ${mediaDirs}`);
  console.log(`   Server port: ${port}`);
  console.log(`   Quality: ${selectedQuality.resolution}`);
  console.log(`   Hardware acceleration: ${hwAccelMap[hwAccel] || 'none'}`);
  console.log(`   API Key: ${apiKey.substring(0, 10)}...`);
  if (useDatabase.toLowerCase() !== 'n') {
    console.log(`   Database: ${dbUser}@${dbHost}:${dbPort}/${dbName}`);
    if (dbSetupSuccess) {
      console.log('   ✅ Database automatically configured');
    }
  } else {
    console.log(`   Database: Disabled`);
  }

  console.log('\n🚀 Next steps:');
  
  let stepNum = 1;
  
  // Only mention npm install if dependencies aren't installed
  if (!fs.existsSync(nodeModulesPath)) {
    console.log(`   ${stepNum}. Install dependencies:`);
    console.log('      npm install --no-bin-links');
    console.log('      (Recommended: --no-bin-links avoids symlink issues on Windows/WSL/Docker)');
    console.log('      (Or use: npm install if symlinks work on your system)');
    stepNum++;
  }
  if (useDatabase.toLowerCase() !== 'n') {
    if (!dbSetupSuccess) {
      console.log(`   ${stepNum}. Set up PostgreSQL database:`);
      console.log(`      createdb -h ${dbHost} -p ${dbPort} -U ${dbUser} ${dbName}`);
      console.log('      (Or manually create the database if needed)');
      stepNum++;
      console.log(`   ${stepNum}. Run database migrations:`);
      console.log('      npm run migrate');
      stepNum++;
    } else {
      console.log(`   ${stepNum}. ✅ Database setup and migrations completed automatically`);
      stepNum++;
    }
  }
  
  console.log(`   ${stepNum}. Build the project: npm run build`);
  stepNum++;
  console.log(`   ${stepNum}. Start the server: npm start`);
  console.log(`\n   Then open http://localhost:${port}/health`);
  console.log('\n   Or use Docker: docker-compose up -d\n');

  rl.close();
}

setup().catch((error) => {
  console.error('Setup failed:', error);
  rl.close();
  process.exit(1);
});
