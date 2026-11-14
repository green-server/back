// Must load before anything under src/: config reads these at import time.
// TEST_DB lets parallel runs use separate copies (green_server_test_*); the default is unchanged.
process.env.DATABASE_URL = `mysql://root@127.0.0.1:3306/${process.env.TEST_DB ?? 'green_server_test'}`;
process.env.JWT_SECRET = 'test-secret';
process.env.FRONT_ORIGIN = 'http://front.test';
