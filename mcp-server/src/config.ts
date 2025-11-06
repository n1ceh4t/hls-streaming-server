/**
 * Configuration management for MCP server
 */

import * as dotenv from 'dotenv';
import { z } from 'zod';

// Load .env file
dotenv.config();

const configSchema = z.object({
  serverUrl: z.string().url().default('http://localhost:8080'),
  apiKey: z.string().optional(),
  sessionToken: z.string().optional(),
  debug: z.boolean().default(false),
});

export const config = configSchema.parse({
  serverUrl: process.env.HLS_SERVER_URL || 'http://localhost:8080',
  apiKey: process.env.HLS_API_KEY,
  sessionToken: process.env.HLS_SESSION_TOKEN,
  debug: process.env.DEBUG === 'true',
});
