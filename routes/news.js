/**
 * /api/news/* — proxy + aggregation routes.
 *
 * The free-tier API quotas (~100–200 req/day each) are tiny. Without
 * caching, a single user clicking refresh a few times would burn through
 * the daily allotment in minutes. We keep an in-memory cache keyed by API
 * name; CACHE_TTL_SECONDS controls how long entries stay fresh.
 *
 * For more than one server instance you'd swap this for Redis — but for
 * the typical solo-deploy case, in-memory is plenty.
 */

const express = require('express');
const { fetchGdelt } = require('../services/gdelt');
const { fetchGnews } = require('../services/gnews');
const { fetchNewsdata } = require('../services/newsdata');
const { fetchNewsapi } = require('../services/newsapi');
const { fetchGuardianNews } = require('../services/guardian');
const { fetchMediastackNews } = require('../services/mediastack');
const { dedupeByUrl } = require('../services/_helpers');

const router = express.Router();
const TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10) * 1000;

// ─── In-memory cache ──────────────────────────────────────────────
// { [key]: { value, expiresAt } }
const cache = new Map();

/**
 * Get a cached value if still fresh, otherwise call `producer()` and cache
 * its result. Concurrent requests for the same key share a single in-flight
 * promise so a thundering herd doesn't fan out into many upstream calls.
 */
const inflight = new Map();
async function getCached(key, producer) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  // Already fetching? Piggyback on the existing promise.
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await producer();
      cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Wrap an async fetcher so that if it throws, we surface a stale cached
 * value (if any) instead of bubbling the failure to the user. This makes
 * the dashboard much more forgiving when one upstream API is flaky.
 */
async function fetchOrStale(key, producer) {
  try {
    return await getCached(key, producer);
  } catch (e) {
    console.warn(`[cache] producer failed for ${key}: ${e.message}`);
    const stale = cache.get(key);
    if (stale) return stale.value;
    return [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────

router.get('/gdelt', async (_req, res) => {
  const articles = await fetchOrStale('gdelt', fetchGdelt);
  res.json({ count: articles.length, articles });
});

router.get('/gnews', async (_req, res) => {
  const articles = await fetchOrStale('gnews', fetchGnews);
  res.json({ count: articles.length, articles });
});

router.get('/newsdata', async (_req, res) => {
  const articles = await fetchOrStale('newsdata', fetchNewsdata);
  res.json({ count: articles.length, articles });
});

router.get('/newsapi', async (_req, res) => {
  const articles = await fetchOrStale('newsapi', fetchNewsapi);
  res.json({ count: articles.length, articles });
});

router.get('/guardian', async (_req, res) => {
  const articles = await fetchOrStale('guardian', fetchGuardianNews);
  res.json({ count: articles.length, articles });
});

router.get('/mediastack', async (_req, res) => {
  const articles = await fetchOrStale('mediastack', fetchMediastackNews);
  res.json({ count: articles.length, articles });
});

/**
 * /api/news/all — fetch from all APIs in parallel, merge and dedupe.
 * Each upstream is independently cached, so a failure in one doesn't taint
 * the others. Per-API counts are returned alongside the merged list for
 * UI display.
 */
router.get('/all', async (_req, res) => {
  const [gdelt, gnews, newsdata, newsapi, guardian, mediastack] = await Promise.all([
    fetchOrStale('gdelt', fetchGdelt),
    fetchOrStale('gnews', fetchGnews),
    fetchOrStale('newsdata', fetchNewsdata),
    fetchOrStale('newsapi', fetchNewsapi),
    fetchOrStale('guardian', fetchGuardianNews),
    fetchOrStale('mediastack', fetchMediastackNews),
  ]);

  const merged = dedupeByUrl([...gdelt, ...gnews, ...newsdata, ...newsapi, ...guardian, ...mediastack]);
  res.json({
    count: merged.length,
    perApi: {
      gdelt: gdelt.length,
      gnews: gnews.length,
      newsdata: newsdata.length,
      newsapi: newsapi.length,
      guardian: guardian.length,
      mediastack: mediastack.length,
    },
    articles: merged,
  });
});

/** Force-clear the cache. Useful for development or scheduled refreshes. */
router.post('/cache/clear', (_req, res) => {
  cache.clear();
  res.json({ ok: true });
});

module.exports = router;
