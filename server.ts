import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Health check endpoint for Cloud Run deployment health checks
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'klocgit-v1',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Serve Vite production build artifacts from dist/
const distPath = join(__dirname, 'dist');

if (existsSync(distPath)) {
  app.use(express.static(distPath));

  // SPA fallback: return index.html for any other route
  app.get('*', (_req, res) => {
    res.sendFile(join(distPath, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.send('KLoCGit v1 is starting. Build in progress...');
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[KLoCGit] Production server listening on http://0.0.0.0:${PORT}`);
});
