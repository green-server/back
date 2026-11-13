import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  uri: config.databaseUrl,
  timezone: 'Z',
  decimalNumbers: true,
  connectionLimit: 10,
});
// DATETIME columns hold UTC: NOW() and CURRENT_TIMESTAMP must agree with the Dates we bind.
pool.on('connection', (c) => void c.query("SET time_zone = '+00:00'"));

export async function rows(sql, params = [], db = pool) {
  const [result] = await db.query(sql, params);
  return result;
}

export async function one(sql, params = [], db = pool) {
  return (await rows(sql, params, db))[0];
}

export async function run(sql, params = [], db = pool) {
  const [result] = await db.query(sql, params);
  return result;
}

export async function tx(fn) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const result = await fn(c);
    await c.commit();
    return result;
  } catch (err) {
    await c.rollback();
    throw err;
  } finally {
    c.release();
  }
}
