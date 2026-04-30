/**
 * NewsData.io — https://newsdata.io
 */

const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const BASE = 'https://newsdata.io/api/1/news';

function buildQueries(key) {
  const cats = [
    null, 'politics', 'world', 'top', 'crime', 'environment',
    'health', 'science', 'technology', 'entertainment', 'sports', 'business',
  ];
  return cats.map((c) =>
    c ? `${BASE}?apikey=${key}&language=en&category=${c}&size=50` : `${BASE}?apikey=${key}&language=en&size=50`
  );
}

async function fetchNewsdata() {
  const key = process.env.NEWSDATA_KEY;
  if (!key || key === 'your_newsdata_key_here') {
    console.warn('[NewsData] NEWSDATA_KEY not configured — skipping');
    return [];
  }

  const queries = buildQueries(key);
  const results = await Promise.allSettled(
    queries.map((u) => fetchWithTimeout(u).then((r) => (r.ok ? r.json() : null)))
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const a of r.value.results || []) {
      const u = (a.link || '').trim();
      if (!u) continue;
      const sc = (Array.isArray(a.country) && a.country[0]) || '';
      merged.push({
        title: a.title || '',
        description: (a.description || '').slice(0, 250),
        url: u,
        domain: a.source_id || extractDomain(u),
        sourcecountry: sc,
        seendate: a.pubDate || '',
        _api: 'newsdata',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[NewsData] articles retrieved: ${deduped.length}`);
  return deduped;
}

module.exports = { fetchNewsdata };