import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://bench:bench@127.0.0.1:5434/articles',
  max: Number(process.env.DB_POOL ?? 20),
});

export const db = drizzle(pool);
