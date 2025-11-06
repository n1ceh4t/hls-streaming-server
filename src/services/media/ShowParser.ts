import path from 'path';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ShowParser');

export interface ParsedShowInfo {
  showName: string;
  season?: number;
  episode?: number;
  episodeEnd?: number; // For multi-episode files (S01E01E02)
  episodeTitle?: string;
  year?: number;
  confidence: 'high' | 'medium' | 'low';
  patternUsed: string;
}

interface ParsePattern {
  name: string;
  regex: RegExp;
  priority: number;
  extract: (match: RegExpMatchArray, filePath: string) => Partial<ParsedShowInfo>;
}

/**
 * Enhanced TV Show Parser
 * Parses filenames and directory structures to extract show metadata
 * Based on industry standards from Plex, Jellyfin, and community best practices
 */
export class ShowParser {
  private readonly patterns: ParsePattern[] = [
    // Pattern 1: Standard SxxExx format (Highest confidence)
    // Examples: S01E01, s03e12, S1E1
    {
      name: 'SxxExx',
      regex: /[Ss](\d{1,2})[Ee](\d{1,2})(?:[Ee](\d{1,2}))?/,
      priority: 1,
      extract: (match) => ({
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10),
        episodeEnd: match[3] ? parseInt(match[3], 10) : undefined,
        confidence: 'high' as const,
      }),
    },

    // Pattern 2: NumxNum format (1x01, 10x99)
    {
      name: 'NumxNum',
      regex: /(\d{1,2})x(\d{1,2})/i,
      priority: 2,
      extract: (match) => ({
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10),
        confidence: 'high' as const,
      }),
    },

    // Pattern 3: Date-based format (2023-11-03, 2023.11.03)
    // Common for daily shows like The Daily Show, news programs
    {
      name: 'DateBased',
      regex: /(\d{4})[\.\-](\d{2})[\.\-](\d{2})/,
      priority: 3,
      extract: (match) => {
        const year = parseInt(match[1], 10);
        const month = parseInt(match[2], 10);
        const day = parseInt(match[3], 10);
        return {
          year,
          // Use date as virtual season/episode for organization
          season: year,
          episode: month * 100 + day, // 1103 for Nov 3
          confidence: 'high' as const,
        };
      },
    },

    // Pattern 4: Episode keyword format
    // Examples: "Episode 12", "Ep 05", "E12"
    {
      name: 'EpisodeKeyword',
      regex: /(?:Episode|Ep|E)[\s\.\-_]*(\d{1,2})/i,
      priority: 4,
      extract: (match) => ({
        episode: parseInt(match[1], 10),
        confidence: 'medium' as const,
      }),
    },

    // Pattern 5: Absolute episode number (3-4 digits)
    // Examples: 101 (S01E01), 305 (S03E05), 1201 (S12E01)
    {
      name: 'AbsoluteEpisode',
      regex: /(?:^|[\s\-_\.\[\]])(\d{3,4})(?:[\s\-_\.\[\]]|$)/,
      priority: 5,
      extract: (match) => {
        const num = parseInt(match[1], 10);
        // For 3-digit: SEEE (e.g., 101 = S1E01)
        // For 4-digit: SSEE (e.g., 1201 = S12E01)
        const season = Math.floor(num / 100);
        const episode = num % 100;
        return {
          season,
          episode,
          confidence: 'medium' as const,
        };
      },
    },

    // Pattern 6: Part/Pt format
    // Examples: "Part 1", "Pt 3"
    {
      name: 'PartFormat',
      regex: /(?:Part|Pt)[\s\.\-_]*(\d{1,2})/i,
      priority: 6,
      extract: (match) => ({
        episode: parseInt(match[1], 10),
        confidence: 'low' as const,
      }),
    },
  ];

  /**
   * Parse a file path to extract show information
   */
  public parse(filePath: string): ParsedShowInfo {
    const filename = path.basename(filePath);
    const normalized = this.normalizeFilename(filename);

    // Try each pattern in priority order
    for (const pattern of this.patterns) {
      const match = normalized.match(pattern.regex);
      if (match) {
        const extracted = pattern.extract(match, filePath);
        const showName = this.extractShowName(filePath, filename, normalized, match);

        const result: ParsedShowInfo = {
          showName: this.cleanShowName(showName),
          season: extracted.season,
          episode: extracted.episode,
          episodeEnd: extracted.episodeEnd,
          year: extracted.year,
          confidence: extracted.confidence || 'medium',
          patternUsed: pattern.name,
        };

        // Try to extract episode title
        result.episodeTitle = this.extractEpisodeTitle(normalized, match[0]);

        logger.debug(
          { filePath, result, pattern: pattern.name },
          'Successfully parsed show info'
        );

        return result;
      }
    }

    // Fallback: Parse from directory structure
    return this.parseFromDirectory(filePath);
  }

  /**
   * Parse multiple files and group by show/season
   */
  public parseAndGroup(filePaths: string[]): Map<string, Map<number, ParsedShowInfo[]>> {
    const grouped = new Map<string, Map<number, ParsedShowInfo[]>>();

    for (const filePath of filePaths) {
      const parsed = this.parse(filePath);
      
      if (!grouped.has(parsed.showName)) {
        grouped.set(parsed.showName, new Map());
      }

      const showMap = grouped.get(parsed.showName)!;
      const season = parsed.season || 0;

      if (!showMap.has(season)) {
        showMap.set(season, []);
      }

      showMap.get(season)!.push(parsed);
    }

    // Sort episodes within each season
    for (const showMap of grouped.values()) {
      for (const episodes of showMap.values()) {
        episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
      }
    }

    return grouped;
  }

  /**
   * Normalize filename for better matching
   */
  private normalizeFilename(filename: string): string {
    // Remove [Group] tags at the start (anime releases)
    let normalized = filename.replace(/^\[.*?\]\s*/, '');
    
    // Remove quality/tag brackets at the end [1080p], [Subbed], etc.
    normalized = normalized.replace(/\s*\[(?:1080p|720p|480p|4k|2160p|subbed?|dubbed?|uncensored)\](?:\s*\[.*?\])*/gi, '');
    
    // Remove other bracketed content
    normalized = normalized.replace(/\{.*?\}/g, ''); // Remove {tags}
    normalized = normalized.replace(/\((?!\d{4})\)/g, ''); // Remove () but keep (year)
    
    return normalized;
  }

  /**
   * Extract show name from file path and filename
   */
  private extractShowName(filePath: string, originalFilename: string, normalizedFilename: string, match: RegExpMatchArray): string {
    const parts = filePath.split(path.sep);
    const parentDir = parts[parts.length - 2] || '';
    const grandparentDir = parts[parts.length - 3] || '';

    // If parent directory is "Season XX", use grandparent as show name
    if (/^Season[\s\._\-]*\d+$/i.test(parentDir)) {
      return grandparentDir;
    }

    // For anime-style filenames with [Group] tags, extract from original filename FIRST
    // Format: [Group] Show Name - 12 [quality].mkv
    // This needs to happen before other extraction because normalization removes the brackets
    if (originalFilename.startsWith('[')) {
      // More flexible pattern: [Group] Show Name - episode_number [optional quality tags]
      // Use greedy match up to the dash-space-number pattern
      const animeMatch = originalFilename.match(/^\[.*?\]\s+(.+?)\s+-\s+(\d+)/);
      if (animeMatch && animeMatch[1] && animeMatch[1].trim().length > 0) {
        // Clean the show name: remove any trailing bracketed content
        let showName = animeMatch[1].trim();
        showName = showName.replace(/\s*\[.*?\]\s*$/g, '');
        return showName;
      }
    }

    // Extract show name from filename (everything before the match)
    const matchIndex = normalizedFilename.indexOf(match[0]);
    if (matchIndex > 0) {
      const showNameFromFile = normalizedFilename.substring(0, matchIndex);
      return showNameFromFile.trim();
    }

    // Fallback to parent directory
    return parentDir || 'Unknown';
  }

  /**
   * Clean and normalize show name
   */
  private cleanShowName(showName: string): string {
    return showName
      .replace(/\s*\(\d{4}\)\s*/g, '') // Remove (year)
      .replace(/[\._]/g, ' ') // Replace . and _ with spaces
      .replace(/\s+/g, ' ') // Collapse multiple spaces
      .replace(/\[(.*?)\]/g, '') // Remove [tags]
      .replace(/\b(1080p|720p|480p|2160p|4k)\b/gi, '') // Remove quality
      .replace(/\b(bluray|web-?dl|hdtv|dvd|webrip|brrip)\b/gi, '') // Remove source
      .replace(/\b(h\.?264|h\.?265|x\.?264|x\.?265|xvid|divx)\b/gi, '') // Remove codec
      .replace(/\b(aac|ac3|dts|mp3|flac)\b/gi, '') // Remove audio codec
      .replace(/\b(proper|repack|internal|limited)\b/gi, '') // Remove release tags
      .replace(/[\-\._]+$/, '') // Remove trailing separators
      .trim();
  }

  /**
   * Extract episode title from filename
   */
  private extractEpisodeTitle(normalizedFilename: string, seasonEpisodeMatch: string): string | undefined {
    const matchIndex = normalizedFilename.indexOf(seasonEpisodeMatch);
    if (matchIndex === -1) return undefined;

    // Get everything after the season/episode pattern
    let title = normalizedFilename.substring(matchIndex + seasonEpisodeMatch.length);

    // Remove file extension
    title = title.replace(/\.\w{2,4}$/, '');

    // Remove common trailing patterns
    title = title
      .replace(/[\-\._\s]+$/, '')
      .replace(/^[\-\._\s]+/, '')
      .replace(/\b(1080p|720p|480p|2160p)\b.*/gi, '')
      .replace(/\b(bluray|web-?dl|hdtv)\b.*/gi, '')
      .replace(/[\._]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return title.length > 0 ? title : undefined;
  }

  /**
   * Fallback: Parse from directory structure when filename patterns fail
   */
  private parseFromDirectory(filePath: string): ParsedShowInfo {
    const parts = filePath.split(path.sep);
    const filename = parts[parts.length - 1];
    const parentDir = parts[parts.length - 2] || '';
    const grandparentDir = parts[parts.length - 3] || '';

    let showName = parentDir;
    let season: number | undefined;
    let episode: number | undefined;

    // Check if parent directory is "Season XX"
    const seasonMatch = parentDir.match(/^Season[\s\._\-]*(\d{1,2})$/i);
    if (seasonMatch) {
      season = parseInt(seasonMatch[1], 10);
      showName = grandparentDir;
    }

    // Try to extract episode number from filename
    const episodeMatch = filename.match(/(\d{1,2})/);
    if (episodeMatch) {
      episode = parseInt(episodeMatch[1], 10);
    }

    // Extract year if present
    const yearMatch = showName.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;

    return {
      showName: this.cleanShowName(showName),
      season,
      episode,
      year,
      confidence: 'low',
      patternUsed: 'DirectoryStructure',
    };
  }

  /**
   * Validate parsed information
   */
  public validate(info: ParsedShowInfo): boolean {
    // Show name must exist
    if (!info.showName || info.showName === 'Unknown') {
      return false;
    }

    // Season should be valid if present
    if (info.season !== undefined && (info.season < 0 || info.season > 99)) {
      return false;
    }

    // Episode should be valid if present
    if (info.episode !== undefined && (info.episode < 0 || info.episode > 999)) {
      return false;
    }

    return true;
  }

  /**
   * Format parsed info back to standard naming convention
   */
  public formatStandard(info: ParsedShowInfo): string {
    let result = info.showName;

    if (info.year) {
      result += ` (${info.year})`;
    }

    if (info.season !== undefined && info.episode !== undefined) {
      result += ` - S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`;

      if (info.episodeEnd) {
        result += `E${String(info.episodeEnd).padStart(2, '0')}`;
      }
    } else if (info.episode !== undefined) {
      result += ` - Episode ${info.episode}`;
    }

    if (info.episodeTitle) {
      result += ` - ${info.episodeTitle}`;
    }

    return result;
  }
}

