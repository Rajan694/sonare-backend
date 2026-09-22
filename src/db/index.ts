import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { dbConfig } from '../config.js';
import * as schema from './schema.js';

export const sql = postgres({
  ...dbConfig,
  max: 10,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export async function verifyDatabase() {
  try {
    await sql`SELECT 1`;
  } catch (error: any) {
    if (error.code === '3D000') {
      console.error('\x1b[31m[Database Error]\x1b[0m Database "sonare" does not exist!');
      console.error('\x1b[33mRun `npm run db:create` and `npm run db:migrate` to set it up.\x1b[0m');
      process.exit(1);
    }
    console.error('\x1b[31m[Database Error]\x1b[0m Failed to connect to PostgreSQL:', error.message);
    process.exit(1);
  }
}
