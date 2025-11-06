#!/usr/bin/env tsx
/**
 * CLI Tool to test ShowParser on your media directory
 * 
 * Usage:
 *   npm run test-parser /path/to/media
 *   npm run test-parser /media/tv-shows
 * 
 * Features:
 *   - Scans directory for video files
 *   - Parses each file with ShowParser
 *   - Displays results grouped by show/season
 *   - Shows confidence levels
 *   - Identifies files needing manual review
 */

import fs from 'fs/promises';
import path from 'path';
import { ShowParser } from '../src/services/media/ShowParser';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
};

const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg'];

interface ScanResult {
  filePath: string;
  parsed: ReturnType<typeof ShowParser.prototype.parse>;
}

/**
 * Recursively scan directory for video files
 */
async function scanDirectory(directory: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      // Skip hidden files and common junk
      if (entry.name.startsWith('.') || entry.name === '@eaDir') {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await scanDirectory(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (videoExtensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`${colors.red}Error scanning ${directory}:${colors.reset}`, error);
  }

  return files;
}

/**
 * Display results grouped by show and season
 */
function displayResults(results: ScanResult[]) {
  const parser = new ShowParser();
  const filePaths = results.map(r => r.filePath);
  const grouped = parser.parseAndGroup(filePaths);

  console.log(`\n${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}   MEDIA DISCOVERY RESULTS${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════${colors.reset}\n`);

  console.log(`${colors.bright}Found ${results.length} video files${colors.reset}\n`);

  // Display by show
  for (const [showName, seasons] of grouped) {
    const totalEpisodes = Array.from(seasons.values()).reduce((sum, eps) => sum + eps.length, 0);
    
    console.log(`${colors.bright}${colors.blue}📺 ${showName}${colors.reset} (${totalEpisodes} episodes)`);
    
    for (const [seasonNum, episodes] of seasons) {
      console.log(`  ${colors.cyan}Season ${seasonNum || '?'}:${colors.reset} ${episodes.length} episodes`);
      
      for (const episode of episodes) {
        const confidenceColor = 
          episode.confidence === 'high' ? colors.green :
          episode.confidence === 'medium' ? colors.yellow :
          colors.red;
        
        const confidenceIcon = 
          episode.confidence === 'high' ? '✓' :
          episode.confidence === 'medium' ? '~' :
          '!';
        
        const episodeNum = String(episode.episode || '?').padStart(2, '0');
        const title = episode.episodeTitle ? ` - ${episode.episodeTitle}` : '';
        const pattern = `[${episode.patternUsed}]`;
        
        console.log(
          `    ${confidenceColor}${confidenceIcon}${colors.reset} E${episodeNum}${title} ${colors.dim}${pattern}${colors.reset}`
        );
      }
    }
    
    console.log(''); // Blank line between shows
  }
}

/**
 * Display files that need manual review
 */
function displayNeedsReview(results: ScanResult[]) {
  const lowConfidence = results.filter(r => r.parsed.confidence === 'low');
  const missingInfo = results.filter(r => !r.parsed.season || !r.parsed.episode);
  
  if (lowConfidence.length > 0 || missingInfo.length > 0) {
    console.log(`${colors.bright}${colors.yellow}⚠️  Files Needing Manual Review${colors.reset}\n`);
    
    if (lowConfidence.length > 0) {
      console.log(`${colors.yellow}Low Confidence Parsing (${lowConfidence.length}):${colors.reset}`);
      for (const result of lowConfidence) {
        console.log(`  ${colors.red}!${colors.reset} ${path.basename(result.filePath)}`);
        console.log(`    Show: ${result.parsed.showName}`);
        console.log(`    Pattern: ${result.parsed.patternUsed}`);
      }
      console.log('');
    }
    
    if (missingInfo.length > 0) {
      console.log(`${colors.yellow}Missing Season/Episode Info (${missingInfo.length}):${colors.reset}`);
      for (const result of missingInfo) {
        console.log(`  ${colors.red}!${colors.reset} ${path.basename(result.filePath)}`);
        console.log(`    Show: ${result.parsed.showName}`);
        console.log(`    Season: ${result.parsed.season || 'N/A'}`);
        console.log(`    Episode: ${result.parsed.episode || 'N/A'}`);
      }
      console.log('');
    }
  } else {
    console.log(`${colors.green}✓ All files parsed successfully with good confidence!${colors.reset}\n`);
  }
}

/**
 * Display statistics
 */
function displayStats(results: ScanResult[]) {
  const highConfidence = results.filter(r => r.parsed.confidence === 'high').length;
  const mediumConfidence = results.filter(r => r.parsed.confidence === 'medium').length;
  const lowConfidence = results.filter(r => r.parsed.confidence === 'low').length;
  
  const patternCounts = new Map<string, number>();
  for (const result of results) {
    const count = patternCounts.get(result.parsed.patternUsed) || 0;
    patternCounts.set(result.parsed.patternUsed, count + 1);
  }
  
  console.log(`${colors.bright}${colors.cyan}Statistics:${colors.reset}\n`);
  
  console.log(`${colors.green}High Confidence:${colors.reset}   ${highConfidence} (${((highConfidence / results.length) * 100).toFixed(1)}%)`);
  console.log(`${colors.yellow}Medium Confidence:${colors.reset} ${mediumConfidence} (${((mediumConfidence / results.length) * 100).toFixed(1)}%)`);
  console.log(`${colors.red}Low Confidence:${colors.reset}    ${lowConfidence} (${((lowConfidence / results.length) * 100).toFixed(1)}%)`);
  
  console.log(`\n${colors.bright}Patterns Used:${colors.reset}`);
  for (const [pattern, count] of patternCounts) {
    console.log(`  ${pattern}: ${count} (${((count / results.length) * 100).toFixed(1)}%)`);
  }
  console.log('');
}

/**
 * Display sample standard naming
 */
function displayStandardNaming(results: ScanResult[]) {
  const parser = new ShowParser();
  const samples = results.slice(0, 5);
  
  if (samples.length > 0) {
    console.log(`${colors.bright}${colors.cyan}Standard Naming Examples:${colors.reset}\n`);
    console.log(`${colors.dim}If you want to rename your files to a standard format:${colors.reset}\n`);
    
    for (const result of samples) {
      const originalName = path.basename(result.filePath);
      const standardName = parser.formatStandard(result.parsed) + path.extname(result.filePath);
      
      console.log(`${colors.dim}Original:${colors.reset}  ${originalName}`);
      console.log(`${colors.green}Standard:${colors.reset}  ${standardName}`);
      console.log('');
    }
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
${colors.bright}Media Parser Test Tool${colors.reset}

Usage:
  npm run test-parser <directory>
  tsx scripts/test-media-parser.ts <directory>

Examples:
  npm run test-parser /media/tv-shows
  npm run test-parser /path/to/your/media

Options:
  --help, -h     Show this help message
  --verbose, -v  Show full file paths
  --export       Export results to JSON file
    `);
    process.exit(0);
  }
  
  const directory = args[0];
  const verbose = args.includes('--verbose') || args.includes('-v');
  const exportJson = args.includes('--export');
  
  // Check if directory exists
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) {
      console.error(`${colors.red}Error: ${directory} is not a directory${colors.reset}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`${colors.red}Error: Directory ${directory} does not exist${colors.reset}`);
    process.exit(1);
  }
  
  console.log(`${colors.bright}Scanning directory:${colors.reset} ${directory}\n`);
  console.log(`${colors.dim}Please wait, this may take a moment...${colors.reset}\n`);
  
  // Scan for video files
  const files = await scanDirectory(directory);
  
  if (files.length === 0) {
    console.log(`${colors.yellow}No video files found in ${directory}${colors.reset}`);
    process.exit(0);
  }
  
  console.log(`${colors.green}Found ${files.length} video files${colors.reset}`);
  console.log(`${colors.dim}Parsing filenames...${colors.reset}\n`);
  
  // Parse all files
  const parser = new ShowParser();
  const results: ScanResult[] = files.map(filePath => ({
    filePath,
    parsed: parser.parse(filePath),
  }));
  
  // Display results
  displayResults(results);
  displayNeedsReview(results);
  displayStats(results);
  displayStandardNaming(results);
  
  // Export to JSON if requested
  if (exportJson) {
    const exportPath = path.join(process.cwd(), 'media-parse-results.json');
    const exportData = {
      scannedDirectory: directory,
      scannedAt: new Date().toISOString(),
      totalFiles: results.length,
      results: results.map(r => ({
        filePath: r.filePath,
        showName: r.parsed.showName,
        season: r.parsed.season,
        episode: r.parsed.episode,
        episodeTitle: r.parsed.episodeTitle,
        confidence: r.parsed.confidence,
        patternUsed: r.parsed.patternUsed,
      })),
    };
    
    await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));
    console.log(`${colors.green}✓ Results exported to: ${exportPath}${colors.reset}\n`);
  }
  
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════${colors.reset}\n`);
}

// Run the tool
main().catch(error => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  process.exit(1);
});

