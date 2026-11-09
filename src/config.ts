const production = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (production) throw new Error('JWT_SECRET is required in production');
  console.warn('JWT_SECRET is not set: using an insecure development secret');
  jwtSecret = 'insecure-dev-secret';
}

export const config = {
  production,
  jwtSecret,
  // Kept apart so rotating JWT_SECRET (which ends every session) does not also change the key
  // every root helper pinned. Changing GRANT_SECRET itself does, and means reinstalling the helpers.
  grantSecret: process.env.GRANT_SECRET || jwtSecret, // || : an empty line copied from .env.example means unset
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/green_server_20401',
  frontOrigin: process.env.FRONT_ORIGIN ?? 'http://localhost:3000',
};
