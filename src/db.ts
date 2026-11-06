import mysql, { type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  uri: config.databaseUrl,
  timezone: 'Z',
  decimalNumbers: true,
  connectionLimit: 10,
});
// DATETIME columns hold UTC: NOW() and CURRENT_TIMESTAMP must agree with the Dates we bind.
pool.on('connection', (c) => void c.query("SET time_zone = '+00:00'"));

type Db = Pick<PoolConnection, 'query'>;

export async function rows<T>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const [result] = await db.query<RowDataPacket[]>(sql, params);
  return result as T[];
}

export async function one<T>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await rows<T>(sql, params, db))[0];
}

export async function run(sql: string, params: unknown[] = [], db: Db = pool): Promise<ResultSetHeader> {
  const [result] = await db.query<ResultSetHeader>(sql, params);
  return result;
}

export async function tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
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
