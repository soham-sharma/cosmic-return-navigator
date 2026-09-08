/**
 * Frontend dev server. Serves `public/` and proxies `/api/v1/*` to the backend,
 * so client code can use same-origin relative URLs and never touch CORS.
 *
 * SHARED FILE — owned by the frontend team, not the KPI dashboard specifically.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3000);
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4000';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();

app.use('/api', async (req, res) => {
  const target = `${BACKEND_URL}/api${req.originalUrl.slice('/api'.length)}`;
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(body);
  } catch {
    // The client falls back to its bundled snapshot when this fires.
    res.status(502).json({
      success: false,
      error: {
        code: 'UPSTREAM_UNREACHABLE',
        message: `Backend not reachable at ${BACKEND_URL}. Start it with: cd backend && npm run dev`,
        retryable: true,
      },
      meta: { requestId: 'proxy', timestamp: new Date().toISOString() },
    });
  }
});

app.use(express.static(publicDir, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Frontend  http://localhost:${PORT}`);
  console.log(`Proxying  /api/v1/*  ->  ${BACKEND_URL}`);
});
