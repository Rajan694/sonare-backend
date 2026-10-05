import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env.test'), override: true });

import postgres from 'postgres';

export const setup = async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('Copy .env.test.example to .env.test and set DATABASE_URL (database sonare_test)');
  }
  const parsed = new URL(dbUrl);
  const dbName = parsed.pathname.replace(/^\//, '') || 'sonare_test';

  if (dbName !== 'sonare_test') {
    throw new Error(`Refusing to run tests against non-test db: ${dbName}`);
  }

  // Connect to maintenance database 'postgres'
  const maintenanceUrl = new URL(dbUrl);
  maintenanceUrl.pathname = '/postgres';
  const sql = postgres(maintenanceUrl.toString());

  try {
    const exists = await sql`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;

    if (exists.length === 0) {
      console.log(`[GlobalSetup] Creating test database "${dbName}"...`);
      await sql.unsafe(`CREATE DATABASE ${dbName};`);
    }
  } finally {
    await sql.end();
  }

  // Re-create public schema in test DB to ensure clean state and avoid duplicate table errors
  console.log('[GlobalSetup] Rebuilding test DB schema...');
  const testSql = postgres(dbUrl);
  try {
    await testSql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `);

    const drizzleDir = path.resolve(__dirname, '../drizzle');
    const files = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sqlContent = fs.readFileSync(path.join(drizzleDir, file), 'utf-8');
      await testSql.unsafe(sqlContent);
    }
    console.log('[GlobalSetup] All migrations applied to test DB successfully.');
  } finally {
    await testSql.end();
  }
};

export const teardown = async () => {
  // Clean up connections if needed
};
