import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

export const sql = postgres(config.databaseUrl, { max: 10, connection: { statement_timeout: 20_000 } });
export const db = drizzle(sql, { schema });
