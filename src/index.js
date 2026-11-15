// First: config reads the environment at import time. Variables already set win over .env.
import 'dotenv/config';
import { createServer } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { agents, webClients } from './hub.js';
import { startJobs } from './jobs.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = createServer();
server.listen(config.port, () => {
  console.log(`Green Server backend listening on :${config.port}`);
  startJobs();
});

// Stops taking connections, lets in-flight requests finish, then releases the database.
function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    pool.end().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  });
  // Upgraded sockets hold server.close() open until they end.
  for (const ws of agents.values()) ws.terminate();
  for (const clients of webClients.values()) for (const ws of clients) ws.terminate();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
