import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Database } from './Database';
import { createLogger } from '../../utils/logger';

const logger = createLogger('MigrationRunner');

interface Migration {
  version: string;
  filename: string;
  sql: string;
}

/**
 * Runs database migrations
 */
export class MigrationRunner {
  private readonly migrationsDir: string;

  constructor(migrationsDir: string = './database/migrations') {
    this.migrationsDir = path.resolve(migrationsDir);
  }

  /**
   * Create migrations table if it doesn't exist
   */
  private async ensureMigrationsTable(): Promise<void> {
    await Database.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
  }

  /**
   * Get list of applied migrations
   */
  private async getAppliedMigrations(): Promise<string[]> {
    await this.ensureMigrationsTable();
    const result = await Database.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    return result.rows.map((row) => row.version);
  }

  /**
   * Load migration files
   */
  private loadMigrations(): Migration[] {
    try {
      const files = readdirSync(this.migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort();

      return files.map((filename) => {
        const filePath = path.join(this.migrationsDir, filename);
        const sql = readFileSync(filePath, 'utf-8');
        // Extract version from filename (e.g., "001_initial_schema.sql" -> "001")
        const version = filename.split('_')[0];

        return {
          version,
          filename,
          sql,
        };
      });
    } catch (error) {
      logger.error({ error, migrationsDir: this.migrationsDir }, 'Failed to load migrations');
      throw error;
    }
  }

  /**
   * Run all pending migrations
   */
  public async runMigrations(): Promise<void> {
    logger.info('Starting database migrations');

    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations();
    const migrations = this.loadMigrations();

    const pending = migrations.filter((m) => !applied.includes(m.version));

    if (pending.length === 0) {
      logger.info('No pending migrations');
      return;
    }

    logger.info({ count: pending.length }, 'Found pending migrations');

    for (const migration of pending) {
      logger.info({ version: migration.version, file: migration.filename }, 'Running migration');

      try {
        // For migration files with BEGIN/COMMIT, try executing as a single transaction
        // This is simpler and more reliable than parsing complex SQL
        const hasExplicitTransaction = migration.sql.trim().match(/^\s*BEGIN\s*;/i);
        
        if (hasExplicitTransaction) {
          // Execute the entire migration as-is, but wrap in our own transaction
          // Remove BEGIN/COMMIT from the SQL since we manage transactions
          let sqlToExecute = migration.sql
            .replace(/^\s*BEGIN\s*;?\s*/i, '')
            .replace(/\s*COMMIT\s*;?\s*$/i, '')
            .trim();
          
          logger.info(
            { originalLength: migration.sql.length, cleanedLength: sqlToExecute.length },
            'Migration has explicit transaction, executing as single statement'
          );
          
          await Database.transaction(async (client) => {
            // Use PostgreSQL's native ability to execute multiple statements
            // by executing the entire SQL as one query
            // PostgreSQL's query() can handle multiple statements separated by semicolons
            // We just need to make sure each statement is properly terminated
            try {
              // Execute all statements at once - PostgreSQL supports this
              await client.query(sqlToExecute);
              
              // Mark as applied
              await client.query(
                'INSERT INTO schema_migrations (version) VALUES ($1)',
                [migration.version]
              );
            } catch (error: any) {
              logger.error(
                {
                  error,
                  errorCode: error.code,
                  errorMessage: error.message,
                  sqlPreview: sqlToExecute.substring(0, 500),
                },
                'Migration execution failed - attempting statement-by-statement'
              );
              
              // Fallback: if bulk execution fails, try statement by statement
              // Split on semicolons that are not inside quotes
              const statements: string[] = [];
              let current = '';
              let inSingleQuote = false;
              let inDoubleQuote = false;
              let inDollarQuote = false;
              let dollarTag = '';
              
              for (let i = 0; i < sqlToExecute.length; i++) {
                const char = sqlToExecute[i];
                const nextChar = i + 1 < sqlToExecute.length ? sqlToExecute[i + 1] : '';
                
                // Track dollar quotes
                if (!inSingleQuote && !inDoubleQuote && !inDollarQuote && char === '$') {
                  const remaining = sqlToExecute.substring(i);
                  const match = remaining.match(/^\$([^$]*)\$/);
                  if (match) {
                    dollarTag = match[0];
                    inDollarQuote = true;
                    current += char;
                    continue;
                  }
                }
                
                if (inDollarQuote) {
                  current += char;
                  if (current.endsWith(dollarTag)) {
                    inDollarQuote = false;
                    dollarTag = '';
                  }
                  continue;
                }
                
                // Track quotes
                if (char === "'" && !inDoubleQuote) {
                  if (char === nextChar) {
                    // Escaped quote
                    current += char + nextChar;
                    i++;
                    continue;
                  }
                  inSingleQuote = !inSingleQuote;
                } else if (char === '"' && !inSingleQuote) {
                  inDoubleQuote = !inDoubleQuote;
                }
                
                current += char;
                
                // End of statement
                if (
                  char === ';' &&
                  !inSingleQuote &&
                  !inDoubleQuote &&
                  !inDollarQuote
                ) {
                  const trimmed = current.trim();
                  if (trimmed && !trimmed.match(/^\s*--/)) {
                    statements.push(trimmed);
                  }
                  current = '';
                }
              }
              
              // Execute statements one by one
              logger.info({ statementCount: statements.length }, 'Executing statements individually');
              for (let i = 0; i < statements.length; i++) {
                const stmt = statements[i];
                if (stmt) {
                  try {
                    await client.query(stmt);
                  } catch (err: any) {
                    logger.error(
                      { error: err, statementIndex: i + 1, statement: stmt.substring(0, 200) },
                      'Statement execution failed'
                    );
                    throw err;
                  }
                }
              }
              
              // Mark as applied
              await client.query(
                'INSERT INTO schema_migrations (version) VALUES ($1)',
                [migration.version]
              );
            }
          });
          
          logger.info({ version: migration.version }, 'Migration applied successfully');
          continue; // Skip the complex parsing for this migration
        }
        
        // Split SQL into individual statements
        // PostgreSQL's pg library requires each statement to be executed separately
        // We need to properly parse SQL to split on semicolons, but not inside strings
        // Handle: single quotes, double quotes, and dollar-quoted strings ($$ ... $$)
        const statements: string[] = [];
        let currentStatement = '';
        let inString = false;
        let stringChar = '';
        let inDollarQuote = false;
        let dollarQuoteTag = '';
        let inComment = false;
        let parenDepth = 0; // Track parentheses depth for nested structures
        let createTableStartPos = -1; // Debug: track where CREATE TABLE starts
        
        for (let i = 0; i < migration.sql.length; i++) {
          const char = migration.sql[i];
          
          // Debug: detect CREATE TABLE start (check after we have the char)
          if (
            !inComment &&
            !inString &&
            !inDollarQuote &&
            i + 13 < migration.sql.length &&
            migration.sql.substring(i, i + 13).toUpperCase() === 'CREATE TABLE'
          ) {
            createTableStartPos = i;
            logger.info({ position: i, context: migration.sql.substring(i, i + 200) }, '🔍 Found CREATE TABLE start');
          }
          const nextChar = i < migration.sql.length - 1 ? migration.sql[i + 1] : '';
          const prevChar = i > 0 ? migration.sql[i - 1] : '';
          
          // Track dollar-quoted strings (e.g., $$, $tag$, $body$)
          // PostgreSQL dollar quotes: $tag$ or $$
          if (!inComment && !inString && !inDollarQuote && char === '$') {
            // Look ahead to find the opening tag (e.g., $$ or $tag$)
            const remaining = migration.sql.substring(i);
            // Match: $$ or $ followed by optional tag and $
            const tagMatch = remaining.match(/^\$([^$]*)\$/);
            if (tagMatch) {
              dollarQuoteTag = tagMatch[0]; // e.g., "$$" or "$tag$"
              inDollarQuote = true;
              currentStatement += char;
              continue;
            }
          }
          
          if (inDollarQuote) {
            currentStatement += char;
            // Check if we've reached the end of the dollar quote
            // Look at the end of currentStatement to see if it ends with dollarQuoteTag
            if (currentStatement.endsWith(dollarQuoteTag)) {
              inDollarQuote = false;
              dollarQuoteTag = '';
            }
            continue;
          }
          
          // Track comments (only when not in string/dollar quote)
          if (!inString && !inDollarQuote && char === '-' && nextChar === '-') {
            inComment = true;
            currentStatement += char;
            continue;
          }
          
          if (inComment) {
            currentStatement += char;
            if (char === '\n') {
              inComment = false;
            }
            continue;
          }
          
          // Track string literals FIRST (before parentheses tracking)
          // Handle both single and double quotes
          if (!inComment && !inDollarQuote && (char === '"' || char === "'")) {
            // Check for escaped quotes: '' (two single quotes in PostgreSQL)
            if (char === "'" && nextChar === "'") {
              // Escaped single quote in PostgreSQL - treat as single character
              currentStatement += char;
              i++; // Skip next quote
              currentStatement += nextChar;
              continue;
            }
            
            // Check for backslash escape (for double quotes)
            if (prevChar === '\\') {
              currentStatement += char;
              continue;
            }
            
            if (!inString) {
              inString = true;
              stringChar = char;
            } else if (char === stringChar) {
              inString = false;
              stringChar = '';
            }
          }
          
          // Track parentheses (for nested structures like CHECK constraints)
          // Only track when NOT in a string
          if (!inComment && !inDollarQuote && !inString) {
            if (char === '(') {
              parenDepth++;
            } else if (char === ')') {
              parenDepth = Math.max(0, parenDepth - 1); // Prevent negative depth
            }
          }
          
          // Add char to statement (but track state before adding)
          // IMPORTANT: We check for end-of-statement AFTER adding the char
          // because the semicolon itself is part of the statement
          currentStatement += char;
          
          // End of statement - semicolon not in string/dollar-quote/comment, at top level (parenDepth === 0)
          // or followed by whitespace/newline/comment/end
          if (
            char === ';' &&
            !inString &&
            !inDollarQuote &&
            !inComment &&
            parenDepth === 0
          ) {
            const trimmed = currentStatement.trim();
            
            // Debug: Log all statement endings for CREATE TABLE
            if (createTableStartPos >= 0 && i >= createTableStartPos) {
              logger.info(
                {
                  position: i,
                  char,
                  parenDepth,
                  inString,
                  inDollarQuote,
                  inComment,
                  statementPreview: currentStatement.substring(0, 100),
                  trimmedLength: trimmed.length,
                  trimmedPreview: trimmed.substring(0, 100),
                },
                '🔍 At CREATE TABLE statement end check'
              );
            }
            
            // Debug: Log ALL statements being considered
            if (trimmed && trimmed.length > 0) {
              logger.debug(
                {
                  position: i,
                  trimmedLength: trimmed.length,
                  trimmedStart: trimmed.substring(0, 50),
                  isComment: !!trimmed.match(/^\s*--/),
                  isBegin: !!trimmed.match(/^\s*BEGIN\s*;?\s*$/i),
                  isCommit: !!trimmed.match(/^\s*COMMIT\s*;?\s*$/i),
                  isRollback: !!trimmed.match(/^\s*ROLLBACK\s*;?\s*$/i),
                  willPush: !trimmed.match(/^\s*--/) &&
                    !trimmed.match(/^\s*BEGIN\s*;?\s*$/i) &&
                    !trimmed.match(/^\s*COMMIT\s*;?\s*$/i) &&
                    !trimmed.match(/^\s*ROLLBACK\s*;?\s*$/i),
                },
                '📝 Statement end detected'
              );
            }
            
            // Skip empty statements, comments-only, and transaction control (we handle that separately)
            if (
              trimmed &&
              !trimmed.match(/^\s*--/) &&
              !trimmed.match(/^\s*BEGIN\s*;?\s*$/i) &&
              !trimmed.match(/^\s*COMMIT\s*;?\s*$/i) &&
              !trimmed.match(/^\s*ROLLBACK\s*;?\s*$/i)
            ) {
              statements.push(trimmed);
              
              // Debug: Log CREATE TABLE statements as they're found
              if (trimmed.match(/CREATE\s+TABLE/i)) {
                logger.info(
                  {
                    statement: trimmed.substring(0, 200),
                    statementLength: trimmed.length,
                    parenDepth,
                    inString,
                    inDollarQuote,
                    inComment,
                  },
                  'Found CREATE TABLE statement'
                );
              } else if (createTableStartPos >= 0 && i > createTableStartPos + 1000) {
                // Debug: If we started a CREATE TABLE but haven't found it after 1000 chars, log warning
                logger.warn(
                  {
                    startPos: createTableStartPos,
                    currentPos: i,
                    currentParenDepth: parenDepth,
                    currentInString: inString,
                    currentStatement: currentStatement.substring(0, 500),
                  },
                  'CREATE TABLE started but not completed'
                );
                createTableStartPos = -1; // Reset to avoid spam
              }
            }
            currentStatement = '';
            inString = false;
            stringChar = '';
            parenDepth = 0; // Reset for next statement
          }
        }
        
        // Add any remaining statement (in case no trailing semicolon)
        const remaining = currentStatement.trim();
        if (
          remaining &&
          !remaining.match(/^\s*--/) &&
          !remaining.match(/^\s*BEGIN\s*;?\s*$/i) &&
          !remaining.match(/^\s*COMMIT\s*;?\s*$/i) &&
          !remaining.match(/^\s*ROLLBACK\s*;?\s*$/i)
        ) {
          statements.push(remaining);
        }

        // Log parsed statements for debugging
        logger.info(
          {
            statementCount: statements.length,
            statements: statements.slice(0, 10).map((s, i) => ({
              index: i,
              preview: s.substring(0, 100).replace(/\s+/g, ' '),
            })),
            createTableStatements: statements
              .filter((s) => s.match(/CREATE\s+TABLE/i))
              .map((s) => ({
                index: statements.indexOf(s),
                preview: s.substring(0, 150).replace(/\s+/g, ' '),
              })),
          },
          'Parsed migration statements'
        );
        
        // Check if CREATE TABLE channels is present (only for initial schema migration)
        // For ALTER TABLE migrations, skip this validation
        const hasChannelsTable = statements.some((s) =>
          s.match(/CREATE\s+TABLE\s+channels/i)
        );
        const hasAlterTable = statements.some((s) =>
          s.match(/ALTER\s+TABLE/i)
        );
        
        // Only validate CREATE TABLE channels for migration 001 (initial schema)
        // Allow ALTER TABLE migrations without this validation
        if (!hasChannelsTable && !hasAlterTable && migration.version === '001') {
          // Log a sample of the raw SQL to see what we're working with
          const sampleSql = migration.sql.substring(0, 2000);
          logger.error(
            {
              allStatements: statements.map((s, i) => `${i}: ${s.substring(0, 100)}`),
              sampleSql: sampleSql,
              sqlLength: migration.sql.length,
            },
            'CREATE TABLE channels not found in parsed statements'
          );
          throw new Error(
            'CREATE TABLE channels statement was not parsed correctly. Check SQL syntax.'
          );
        }
        
        // For ALTER TABLE migrations, log info instead of requiring CREATE TABLE
        if (hasAlterTable && !hasChannelsTable) {
          logger.info(
            { version: migration.version },
            'ALTER TABLE migration detected, skipping CREATE TABLE validation'
          );
        }

        // Execute all statements within a transaction
        // Note: Migration file may have BEGIN/COMMIT, but we execute statements separately
        // so we manage our own transaction
        await Database.transaction(async (client) => {
          // Execute all statements in sequence
          for (let i = 0; i < statements.length; i++) {
            const statement = statements[i].trim();
            if (statement) {
              try {
                logger.debug(
                  { statementIndex: i + 1, totalStatements: statements.length },
                  'Executing statement'
                );
                await client.query(statement);
              } catch (error: any) {
                logger.error(
                  {
                    error,
                    statementIndex: i + 1,
                    totalStatements: statements.length,
                    statementPreview: statement.substring(0, 100),
                    previousStatements: statements
                      .slice(0, i)
                      .map((s, idx) => `${idx + 1}: ${s.substring(0, 50)}`)
                      .join('\n'),
                  },
                  'Failed to execute migration statement'
                );
                throw new Error(
                  `Statement ${i + 1} of ${statements.length} failed: ${error.message}\n` +
                    `Statement: ${statement.substring(0, 200)}`
                );
              }
            }
          }
          
          // Mark as applied
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [migration.version]
          );
        });

        logger.info({ version: migration.version }, 'Migration applied successfully');
      } catch (error) {
        logger.error(
          { error, version: migration.version, file: migration.filename },
          'Migration failed'
        );
        throw error;
      }
    }

    logger.info('All migrations completed');
  }

  /**
   * Check if migrations are up to date
   */
  public async isUpToDate(): Promise<boolean> {
    const applied = await this.getAppliedMigrations();
    const migrations = this.loadMigrations();
    return migrations.every((m) => applied.includes(m.version));
  }
}

