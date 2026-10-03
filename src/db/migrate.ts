import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './index.js';
import { logger } from '../logger.js';
import { describeError } from '../errors.js';

// Applies the SQL migrations in drizzle/ without drizzle-kit (a devDependency), so the
// production image can migrate on start. Works from src/db (tsx) and dist/db (node) alike:
// both are two levels below the folder that holds drizzle/.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  logger.info('Database migrations are up to date');
} catch (error) {
  logger.fatal({ err: error }, `Migration failed: ${describeError(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
