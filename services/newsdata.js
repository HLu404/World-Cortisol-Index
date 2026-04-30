/**
 * NewsData.io — https://newsdata.io
 *
 * Free tier: 200 credits/day. Each request = 1 credit. We use category
 * filters to fan out across the news landscape; results are merged and
 * de-duplicated. The country field returned by NewsData is an array — we
 * pass through the first entry, which the frontend uses for geocoding.
 */

const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const BASE = 'https://newsdata.io/api/1/news';

function buildQueries(key) {
  const cats = [
    null, // first call has no category filter — top general news
    'politics',
    'world',
    'top',
    'crime',
    'environment',
    'health',
    'science',
    'technology',
    'entertainment',
    'sports',
    'business',
  ];
  return cats.map((c) =>
    c
      ? `${BASE}?apikey=${key}&language=en&category=${c}&size=50`
      : `${BASE}?apikey=${key}&language=en&size=50`
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
    queries.map((u) =>
      fetchWithTimeout(u).then((r) => (r.ok ? r.json() : null))
    )
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const a of r.value.results || []) {
      const u = (a.link || '').trim();
      if (!u) continue;
      // NewsData returns country as an array; we use the first entry.
      const sc = (Array.isArray(a.country) && a.country[0]) || '';
      merged.push({
        title: a.title || '',
        url: u,
        domain: a.source_id || extractDomain(u),
        sourcecountry: sc,
        seendate: a.pubDate || '',
        _api: 'newsdata',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[NewsData] ${deduped.length} articles`);
  return deduped;
}

module.exports = { fetchNewsdata };
