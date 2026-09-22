import postgres from 'postgres';
import { dbConfig } from '../config.js';

async function createDatabase() {
  const maintenanceConfig = {
    ...dbConfig,
    database: 'postgres',
  };
  
  console.log(`Connecting to maintenance database 'postgres' on host ${maintenanceConfig.host}...`);
  const sql = postgres(maintenanceConfig);

  try {
    const exists = await sql`
      SELECT 1 FROM pg_database WHERE datname = 'sonare'
    `;

    if (exists.length > 0) {
      console.log('Database "sonare" already exists. Nothing to do.');
    } else {
      console.log('Creating database "sonare"...');
      await sql.unsafe('CREATE DATABASE sonare;');
      console.log('Database "sonare" created successfully.');
    }
  } catch (error: any) {
    console.error('Error creating database:', error.message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

createDatabase();
