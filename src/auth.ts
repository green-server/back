import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { one } from './db.js';
import { ApiError } from './http.js';

const scrypt = promisify(scryptCb) as (password: string, salt: string, length: number) => Promise<Buffer>;
const KEY_LENGTH = 32;
const COOKIE = 'gs_token';
const SESSION_SECONDS = 7 * 24 * 3600;
const COOKIE_OPTIONS: CookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' };

export type UserRow = { id: number; email: string; name: string; created_at: Date };

declare global {
  namespace Express {
    interface Request {
      user: UserRow;
    }
  }
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await scrypt(password, salt, KEY_LENGTH)).toString('hex')}`;
}

/** Derives a key even for an unknown user or foreign hash, so login timing reveals neither. */
export async function verifyPassword(password: string, stored = ''): Promise<boolean> {
  const [, salt = '', hash = ''] = stored.split('$');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === KEY_LENGTH && timingSafeEqual(derived, expected);
}

export function setSession(res: Response, userId: number): void {
  const token = jwt.sign({}, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: SESSION_SECONDS,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS * 1000 });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, COOKIE_OPTIONS);
}

/** Resolves the session cookie to a live user. Deleted users fail even with a valid JWT. */
export async function userFromCookie(header: string | undefined): Promise<UserRow | undefined> {
  const entry = header?.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!entry) return undefined;
  try {
    const { sub } = jwt.verify(entry.slice(COOKIE.length + 1), config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    return await one<UserRow>('SELECT id, email, name, created_at FROM users WHERE id = ?', [Number(sub)]);
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return undefined; // includes expiry
    throw err;
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) throw new ApiError(401, 'unauthorized', '로그인이 필요합니다.');
  req.user = user;
  next();
}
