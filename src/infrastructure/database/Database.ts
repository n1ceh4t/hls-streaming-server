import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../../config/env';
import { createLogger } from '../../utils/logger';

const logger = createLogger('Database');

/**
 * Database connection pool manager
 */
export class Database {
  private static pool: Pool | null = null;

  /**
   * Initialize database connection pool
   */
  public static initialize(): void {
    if (this.pool) {
      logger.warn('Database pool already initialized');
      return;
    }

    const connectionConfig = config.database.url
      ? {
          connectionString: config.database.url,
          ssl: config.database.ssl
            ? {
                rejectUnauthorized: false,
              }
            : false,
        }
      : {
          host: config.database.host,
          port: config.database.port,
          database: config.database.database,
          user: config.database.user,
          password: config.database.password,
          ssl: config.database.ssl
            ? {
                rejectUnauthorized: false,
              }
            : false,
          min: config.database.pool.min,
          max: config.database.pool.max,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        };

    this.pool = new Pool(connectionConfig);

    // Handle pool errors
    this.pool.on('error', (err) => {
      logger.error({ error: err }, 'Unexpected database pool error');
    });

    // Log connection
    this.pool.on('connect', () => {
      logger.debug('New database client connected');
    });

    logger.info(
      {
        host: config.database.host,
        port: config.database.port,
        database: config.database.database,
        poolMin: config.database.pool.min,
        poolMax: config.database.pool.max,
      },
      'Database pool initialized'
    );
  }

  /**
   * Get a client from the pool
   */
  public static async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('Database pool not initialized. Call Database.initialize() first.');
    }
    return this.pool.connect();
  }

  /**
   * Execute a query
   */
  public static async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database pool not initialized. Call Database.initialize() first.');
    }

    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;
      logger.debug({ duration, query: text.substring(0, 100) }, 'Query executed');
      return result;
    } catch (error) {
      logger.error({ error, query: text.substring(0, 100) }, 'Query failed');
      throw error;
    }
  }

  /**
   * Execute a transaction
   */
  public static async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check database connection
   */
  public static async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error({ error }, 'Database health check failed');
      return false;
    }
  }

  /**
   * Close database pool
   */
  public static async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('Database pool closed');
    }
  }

  /**
   * Get pool stats
   */
  public static getStats(): {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  } {
    if (!this.pool) {
      return { totalCount: 0, idleCount: 0, waitingCount: 0 };
    }

    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}

