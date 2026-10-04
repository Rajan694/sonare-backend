import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { dbConfig } from '../config.js';
import { logger } from '../logger.js';
import { describeError } from '../errors.js';
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
  } catch (error) {
    if (describeError(error) === '3D000') {
      logger.fatal(
        `Database "${dbConfig.database}" does not exist. Run \`npm run db:create\` and \`npm run db:migrate\` to set it up.`,
      );
      process.exit(1);
    }
    logger.fatal({ err: error }, `Failed to connect to PostgreSQL: ${describeError(error)}`);
    process.exit(1);
  }
}
