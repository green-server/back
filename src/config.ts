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
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'mysql://root@127.0.0.1:3306/green_server_20401',
  frontOrigin: process.env.FRONT_ORIGIN ?? 'http://localhost:3000',
};
