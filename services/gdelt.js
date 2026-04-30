/**
 * GDELT — free, no API key required.
 *
 * Multiple thematic queries are issued in parallel; results are merged and
 * de-duplicated. Running on the server means we don't need a CORS proxy any
 * more (the original frontend cascaded through 4 public proxies because
 * gdelt's CORS is hit-or-miss from browsers).
 */

const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

const GDELT_QUERIES = [
  'sourcelang:eng',
  '(domain:bbc.com OR domain:reuters.com OR domain:apnews.com OR domain:cnn.com OR domain:aljazeera.com OR domain:theguardian.com OR domain:nytimes.com OR domain:dw.com OR domain:france24.com OR domain:bloomberg.com OR domain:washingtonpost.com) sourcelang:eng',
  '(theme:KILL OR theme:ARMEDCONFLICT OR theme:PROTEST OR theme:CRISISLEX_T03_DEAD OR theme:TERROR OR theme:ELECTIONS OR theme:POLITICAL_INSTABILITY) sourcelang:eng',
  '(theme:GENERAL_GOVERNMENT OR theme:GENERAL_HEALTH OR theme:ENV_CLIMATECHANGE OR theme:EDUCATION OR theme:SCIENCE) sourcelang:eng',
  '(theme:ECON_BANKRUPTCY OR theme:ECON_DEBT OR theme:ECON_REFORM OR theme:NATURAL_DISASTER) sourcelang:eng',
  '(theme:HUMAN_RIGHTS OR theme:REFUGEES OR theme:DISEASE OR theme:FAMINE) sourcelang:eng',
  '(domain:africanews.com OR domain:allafrica.com OR domain:thenationalnews.com OR domain:straitstimes.com OR domain:hindustantimes.com OR domain:dawn.com OR domain:dailystar.com.lb OR domain:theglobeandmail.com OR domain:smh.com.au) sourcelang:eng',
  '(domain:japantimes.co.jp OR domain:koreaherald.com OR domain:chinadailyhk.com OR domain:khaleejtimes.com OR domain:manilatimes.net OR domain:bangkokpost.com OR domain:voanews.com OR domain:rferl.org) sourcelang:eng',
];

/**
 * Run all GDELT queries in parallel and return a deduped, normalized list.
 * Individual failures are logged but never thrown — partial results are
 * always preferred over total failure.
 */
async function fetchGdelt() {
  const results = await Promise.allSettled(
    GDELT_QUERIES.map(async (q) => {
      const url =
        `${GDELT_BASE}?query=${encodeURIComponent(q)}` +
        `&mode=ArtList&format=json&maxrecords=250&timespan=1d&sort=datedesc`;
      const r = await fetchWithTimeout(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // GDELT occasionally serves text/plain even for JSON, so parse manually.
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        return { articles: [] };
      }
    })
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn('[GDELT] query failed:', r.reason?.message);
      continue;
    }
    for (const a of r.value.articles || []) {
      const u = (a.url || '').trim();
      if (!u) continue;
      merged.push({
        title: a.title || '',
        url: u,
        domain: a.domain || extractDomain(u),
        sourcecountry: a.sourcecountry || '',
        seendate: a.seendate || '',
        _api: 'gdelt',
      });
    }
  }

  const deduped = dedupeByUrl(merged);
  console.log(`[GDELT] ${deduped.length} articles`);
  return deduped;
}

module.exports = { fetchGdelt };
