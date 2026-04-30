/**
 * GNews — https://gnews.io
 *
 * Free tier: 100 requests/day. We issue ~10 thematic queries per refresh,
 * so users will exhaust the quota fast — backend caching (see routes/news.js)
 * is essential.
 *
 * The API key is read from process.env.GNEWS_KEY and is NEVER sent to the
 * client (in the original single-file build it was hardcoded in the JS).
 */

const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const BASE = 'https://gnews.io/api/v4';

function buildQueries(key) {
  return [
    `${BASE}/top-headlines?topic=world&lang=en&max=100&token=${key}`,
    `${BASE}/top-headlines?topic=politics&lang=en&max=100&token=${key}`,
    `${BASE}/top-headlines?topic=business&lang=en&max=100&token=${key}`,
    `${BASE}/top-headlines?topic=health&lang=en&max=100&token=${key}`,
    `${BASE}/top-headlines?topic=nation&lang=en&max=100&token=${key}`,
    `${BASE}/top-headlines?topic=science&lang=en&max=100&token=${key}`,
    `${BASE}/search?q=war+conflict+crisis+disaster&lang=en&max=100&sortby=publishedAt&token=${key}`,
    `${BASE}/search?q=election+government+president+minister&lang=en&max=100&sortby=publishedAt&token=${key}`,
    `${BASE}/search?q=peace+growth+development+innovation+award&lang=en&max=100&sortby=publishedAt&token=${key}`,
    `${BASE}/search?q=earthquake+flood+hurricane+wildfire+climate&lang=en&max=100&sortby=publishedAt&token=${key}`,
  ];
}

async function fetchGnews() {
  const key = process.env.GNEWS_KEY;
  if (!key || key === 'your_gnews_key_here') {
    console.warn('[GNews] GNEWS_KEY not configured — skipping');
    return [];
  }

  const queries = buildQueries(key);
  const results = await Promise.allSettled(
    queries.map((u) =>
      fetchWithTimeout(u).then((r) => (r.ok ? r.json() : null))
    )
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const a of r.value.articles || []) {
      const u = (a.url || '').trim();
      if (!u) continue;
      merged.push({
        title: a.title || a.description || '',
        url: u,
        domain: extractDomain(u),
        sourcecountry: '',
        seendate: a.publishedAt || '',
        _api: 'gnews',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[GNews] ${deduped.length} articles`);
  return deduped;
}

module.exports = { fetchGnews };
