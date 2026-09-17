import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

/**
 * NUMERIC comes back from node-postgres as a string by default, because
 * JS floats cannot represent every NUMERIC exactly. For money we WANT that
 * — silently coercing NUMERIC(12,2) to float is how cent-level drift gets
 * into a shared budget. So we leave 1700 (NUMERIC) alone and convert
 * explicitly, per-field, where we know the magnitude is safe.
 *
 * DATE (1082) we do override: the provided schema uses plain DATE for trip
 * windows, and the default Date parsing shifts them by the server's
 * timezone offset, which turns a 5-day trip into a 4-day one at UTC+5:30.
 */
types.setTypeParser(1082, v => v); // DATE -> 'YYYY-MM-DD' string, untouched

export const pool = new Pool({
  connectionString: config.db.connectionString,
  max: config.db.max,
  idleTimeoutMillis: config.db.idleTimeoutMillis,
  connectionTimeoutMillis: config.db.connectionTimeoutMillis,
  // A runaway query holding a row lock on `itineraries` would stall every
  // editor on that trip. Bounded statements make that self-healing.
  statement_timeout: config.db.statementTimeoutMs,
  application_name: 'wandermatch-api'
});

pool.on('error', err => {
  logger.error({ err }, 'idle postgres client error');
});

/**
 * Run a function inside a transaction, with automatic rollback.
 *
 * Every mutating route goes through this. The itinerary conflict check
 * (SELECT ... FOR UPDATE, compare version, write, bump) is only correct
 * inside one transaction — split across two, two writers can both pass the
 * version check before either bumps.
 */
export async function withTransaction(fn, { isolation } = {}) {
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience for read-only queries that need no transaction. */
export function query(text, params) {
  return pool.query(text, params);
}

export async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

export async function closePool() {
  await pool.end();
}
