import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import apiRoutes from './server/routes.ts';

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  await initDatabase();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Clinic360] Server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Clinic360] Fatal startup error:', err);
  process.exit(1);
});
