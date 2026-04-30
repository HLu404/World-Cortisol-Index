const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const GUARDIAN_QUERIES = [
  'world news',
  'politics government election',
  'conflict war military',
  'environment climate disaster',
  'economy trade finance',
  'health medicine pandemic',
];

async function fetchGuardianNews() {
  const key = process.env.GUARDIAN_API_KEY;
  if (!key || key === 'your_guardian_api_key_here') {
    console.warn('[Guardian] GUARDIAN_API_KEY not configured — skipping');
    return [];
  }

  const results = await Promise.allSettled(
    GUARDIAN_QUERIES.map(async (q) => {
      const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(q)}&api-key=${key}&page-size=50&order-by=newest`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const article of r.value.response?.results || []) {
      const u = (article.webUrl || '').trim();
      if (!u) continue;
      merged.push({
        title: article.webTitle || '',
        url: u,
        domain: extractDomain(u) || 'theguardian.com',
        sourcecountry: 'uk',
        seendate: article.webPublicationDate || '',
        _api: 'guardian',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[Guardian] articles retrieved: ${deduped.length}`);
  return deduped;
}

module.exports = { fetchGuardianNews };
