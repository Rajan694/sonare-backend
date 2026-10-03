import postgres from 'postgres';
import { dbConfig } from '../config.js';
import { logger } from '../logger.js';

async function createDatabase() {
  const maintenanceConfig = {
    ...dbConfig,
    database: 'postgres',
  };

  logger.info(`Connecting to maintenance database 'postgres' on host ${maintenanceConfig.host}...`);
  const sql = postgres(maintenanceConfig);

  try {
    const exists = await sql`
      SELECT 1 FROM pg_database WHERE datname = 'sonare'
    `;

    if (exists.length > 0) {
      logger.info('Database "sonare" already exists. Nothing to do.');
    } else {
      logger.info('Creating database "sonare"...');
      await sql.unsafe('CREATE DATABASE sonare;');
      logger.info('Database "sonare" created successfully.');
    }
  } catch (error: any) {
    logger.fatal({ err: error }, `Error creating database: ${error.message}`);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

createDatabase();
