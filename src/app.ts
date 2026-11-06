import { createServer as createHttpServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { ApiError, notFound } from './http.js';
import { api } from './routes.js';
import { attachWebSockets } from './ws.js';

function cors(req: Request, res: Response, next: NextFunction): void {
  res.vary('Origin');
  if (req.headers.origin === config.frontOrigin) {
    res.set({
      'Access-Control-Allow-Origin': config.frontOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }
  if (req.method === 'OPTIONS') res.status(204).end();
  else next();
}

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  let error = err;
  const parseError = (err as { type?: string }).type;
  if (parseError === 'entity.parse.failed') error = new ApiError(400, 'invalid_json', 'JSON 형식이 올바르지 않습니다.');
  if (parseError === 'entity.too.large') error = new ApiError(413, 'payload_too_large', '요청이 너무 큽니다.');
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: '서버 오류가 발생했습니다.' } });
}

export function createServer(): Server {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors);
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
