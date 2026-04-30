/**
 * World Cortisol Index — Express server.
 *
 * Responsibilities:
 *   1. Serve the static frontend from /public.
 *   2. Proxy news API requests under /api/news/* — keeping API keys
 *      server-side and eliminating the CORS workarounds the original
 *      single-file build needed.
 *   3. Provide a /api/health endpoint for uptime checks.
 *
 * Run locally:
 *   cp .env.example .env   # add your keys
 *   npm install
 *   npm start
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');

const newsRoutes = require('./routes/news');
const chatRoute  = require('./routes/chat');

// Bail early if Node is too old — global fetch() lands in 18.
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 18) {
  console.error(`Node ${process.versions.node} is too old. Need Node 18+ for global fetch.`);
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Middleware ───────────────────────────────────────────────────
app.use(compression()); // gzips static + JSON responses
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS: by default the frontend is served from the same origin so CORS
// isn't strictly needed, but enabling it lets you point a separate dev
// frontend at the backend during local development.
app.use(cors());

// ─── API routes ───────────────────────────────────────────────────
app.use('/api/news', newsRoutes);
app.use('/api/chat', chatRoute);

app.get('/api/health', (_req, res) => {
  // Don't echo the actual key values — we just want to know which APIs
  // are configured. The frontend uses this to grey out unavailable badges.
  const have = (k) => Boolean(process.env[k] && !process.env[k].startsWith('your_'));
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    apis: {
      gdelt: true, // no key required
      gnews: have('GNEWS_KEY'),
      newsdata: have('NEWSDATA_KEY'),
      newsapi: have('NEWSAPI_KEY'),
    },
  });
});

// ─── Static frontend ──────────────────────────────────────────────
// `maxAge: 0` for HTML, longer for hashed assets in production. We keep
// it simple here since assets aren't fingerprinted.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res, filepath) => {
      if (filepath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// SPA fallback: any unknown GET that's not /api/* should serve index.html.
// Right now the frontend is single-page, but this gives you room to add
// client-side routes later without rewiring the server.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧠 World Cortisol Index — server up on http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/news/all`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
