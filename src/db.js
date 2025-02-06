import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const client = postgres(process.env.DATABASE_URL);
export const db = drizzle(client, { schema });
