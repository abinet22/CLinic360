import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { closeDatabase, initDatabase } from './server/db.ts';
import apiRoutes from './server/routes.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  app.set('trust proxy', 1);

  await initDatabase();

  const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL') {
    allowedOrigins.push(process.env.APP_URL.trim());
  }

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (
          allowedOrigins.includes(origin) ||
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
          /^https:\/\/[a-z0-9-]+\.[a-z0-9.-]*run\.app$/i.test(origin)
        ) {
          return callback(null, true);
        }
        return callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
    })
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  app.use('/api', apiRoutes);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.type === 'entity.too.large' ? 413 : err.status || 500;
    console.error('[Clinic360] Unhandled request error:', err.message);
    if (res.headersSent) return;
    res.status(status).json({
      error: status >= 500 ? 'Internal server error processing request.' : err.message || 'Request failed.',
    });
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Clinic360] Server listening on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[Clinic360] Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await closeDatabase().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error('[Clinic360] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Clinic360] Uncaught exception:', err);
});

startServer().catch((err) => {
  console.error('[Clinic360] Fatal startup error:', err);
  process.exit(1);
});
