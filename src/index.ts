import { createServer } from './app.js';
import { config } from './config.js';
import { startJobs } from './jobs.js';

createServer().listen(config.port, () => {
  console.log(`Green Server backend listening on :${config.port}`);
  startJobs();
});
