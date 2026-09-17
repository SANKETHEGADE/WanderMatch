/**
 * Minimal forward-only migrator. Tracks applied files in schema_migrations
 * and runs each inside a transaction, so a failed migration leaves nothing
 * half-applied.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './pool.js';
import { logger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
// In the container, db/ is mounted at /db. Locally it sits four levels up
// from src/db/. Env var wins so neither path is hard-coded as the only one.
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ??
  (existsSync('/db/migrations') ? '/db/migrations' : join(here, '../../../../db/migrations'));

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await pool.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
);

const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) {
    logger.debug({ file }, 'migration already applied');
    continue;
  }
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
  logger.info({ file }, 'applying migration');
  await withTransaction(async c => {
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  });
}

logger.info('migrations complete');
await pool.end();
