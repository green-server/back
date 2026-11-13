// First: config reads the environment at import time. Variables already set win over .env.
import 'dotenv/config';
import { createServer } from './app.js';
import { config } from './config.js';
import { startJobs } from './jobs.js';

createServer().listen(config.port, () => {
  console.log(`Green Server backend listening on :${config.port}`);
  startJobs();
});
