import { createServer as createHttpServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { ApiError, notFound } from './http.js';
import { api } from './routes.js';
import { attachWebSockets } from './ws.js';

function errorHandler(err, _req, res, _next) {
  let error = err;
  const parseError = err.type;
  if (parseError === 'entity.parse.failed') error = new ApiError(400, 'invalid_json', 'JSON 형식이 올바르지 않습니다.');
  if (parseError === 'entity.too.large') error = new ApiError(413, 'payload_too_large', '요청이 너무 큽니다.');
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: '서버 오류가 발생했습니다.' } });
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // An array, not a string: a string origin is sent to every caller, this only on a match.
  // Every OPTIONS request ends here with 204.
  app.use(
    cors({
      origin: [config.frontOrigin],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type'],
    }),
  );
  app.use(express.json());
  app.use('/api', api);
  app.use(() => {
    throw notFound();
  });
  app.use(errorHandler);
  const server = createHttpServer(app);
  attachWebSockets(server);
  return server;
}
