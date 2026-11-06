// Must load before anything under src/: config reads these at import time.
process.env.DATABASE_URL = 'mysql://root@127.0.0.1:3306/green_server_test';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONT_ORIGIN = 'http://front.test';
