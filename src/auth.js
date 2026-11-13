import { createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { one } from './db.js';
import { ApiError } from './http.js';

const scrypt = promisify(scryptCb);
const KEY_LENGTH = 32;
const BCRYPT_ROUNDS = 10;
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
// A real bcrypt hash of a random string, compared against when there is nothing valid to compare.
const DUMMY_HASH = '$2b$10$lkuZISGYl5RUlW9e9XD4iOAdhUaM7XOoszSIcFOKdCc5tZBYI3F7u';
const COOKIE = 'gs_token';
const SESSION_SECONDS = 7 * 24 * 3600;
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/' };

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

/** Accounts made before bcrypt keep `scrypt$salt$hex` until their next login rehashes it. */
export const isLegacyHash = (stored) => stored.startsWith('scrypt$');

/** Hashes even for an unknown user or foreign hash, so login timing reveals neither. */
export async function verifyPassword(password, stored = '') {
  if (isLegacyHash(stored)) {
    const [, salt = '', hash = ''] = stored.split('$');
    const derived = await scrypt(password, salt, KEY_LENGTH);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === KEY_LENGTH && timingSafeEqual(derived, expected);
  }
  if (BCRYPT_HASH.test(stored)) return bcrypt.compare(password, stored);
  await bcrypt.compare(password, DUMMY_HASH);
  return false;
}

/** Ties a session to the password it was opened with, so changing the password ends the others. */
const passwordStamp = (passwordHash) => sha256(passwordHash).slice(0, 16);

export function setSession(res, userId, passwordHash) {
  const token = jwt.sign({ pw: passwordStamp(passwordHash) }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: SESSION_SECONDS,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS * 1000 });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, COOKIE_OPTIONS);
}

/** Resolves the session cookie to a live user. Deleted users and old passwords fail even with a valid JWT. */
export async function userFromCookie(header) {
  const entry = header?.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!entry) return undefined;
  try {
    const { sub, pw } = jwt.verify(entry.slice(COOKIE.length + 1), config.jwtSecret, { algorithms: ['HS256'] });
    const user = await one(
      'SELECT id, email, name, created_at, password_hash FROM users WHERE id = ?',
      [Number(sub)],
    );
    if (!user || pw !== passwordStamp(user.password_hash)) return undefined;
    const { password_hash: _, ...rest } = user;
    return rest;
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return undefined; // includes expiry
    throw err;
  }
}

export async function requireAuth(req, _res, next) {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) throw new ApiError(401, 'unauthorized', '로그인이 필요합니다.');
  req.user = user;
  next();
}
