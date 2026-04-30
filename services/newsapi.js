/**
 * NewsAPI.org — https://newsapi.org
 *
 * Free tier: 100 requests/day, developer plan only allows server-side
 * requests (which is exactly what we are). The original frontend had to
 * pipe everything through CORS proxies because NewsAPI blocks browser
 * requests on the dev plan; running server-side means we can call it
 * directly with no proxy gymnastics.
 *
 * Articles flagged as `removed.com` (NewsAPI's tombstone for de-listed
 * stories) are filtered out.
 */

const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const BASE = 'https://newsapi.org/v2';

function buildQueries(key) {
  const auth = `apiKey=${key}&language=en&pageSize=100`;
  return [
    `${BASE}/top-headlines?${auth}&category=general`,
    `${BASE}/top-headlines?${auth}&category=politics`,
    `${BASE}/top-headlines?${auth}&category=business`,
    `${BASE}/top-headlines?${auth}&category=health`,
    `${BASE}/top-headlines?${auth}&category=science`,
    `${BASE}/everything?${auth}&q=war+conflict+crisis&sortBy=publishedAt`,
    `${BASE}/everything?${auth}&q=election+government&sortBy=publishedAt`,
    `${BASE}/everything?${auth}&q=disaster+earthquake+flood&sortBy=publishedAt`,
    `${BASE}/everything?${auth}&q=peace+development+award&sortBy=publishedAt`,
    `${BASE}/everything?${auth}&q=africa+asia+latin+america+europe&sortBy=publishedAt`,
  ];
}

async function fetchNewsapi() {
  const key = process.env.NEWSAPI_KEY;
  if (!key || key === 'your_newsapi_key_here') {
    console.warn('[NewsAPI] NEWSAPI_KEY not configured — skipping');
    return [];
  }

  const queries = buildQueries(key);
  // NewsAPI's "general" category sometimes ignores `category=politics` — that's
  // fine, the duplicate-URL filter below cleans up overlap.
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
      if (!u || u.includes('removed') || u === 'https://removed.com') continue;
      merged.push({
        title: a.title || '',
        url: u,
        domain: extractDomain(u),
        sourcecountry: '',
        seendate: a.publishedAt || '',
        _api: 'newsapi',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[NewsAPI] ${deduped.length} articles`);
  return deduped;
}

module.exports = { fetchNewsapi };
