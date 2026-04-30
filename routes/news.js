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
const { analyzeArticles, cortisolToHex } = require('../services/hf');
const { dedupeByUrl } = require('../services/_helpers');

// ─── Brief: keyword sets for the anti-fluff filter ───────────────
// Multi-word phrases work because we use String.includes(), not Set.has().
const MACRO_TERMS = [
  'war','invasion','conflict','military','troops','nuclear','missile',
  'sanctions','ceasefire','treaty','diplomatic','diplomacy','summit',
  'nato','united nations','president','prime minister','parliament',
  'congress','government','election','vote','coup','embargo',
  'inflation','gdp','recession','economy','debt','interest rate',
  'federal reserve','imf','world bank','central bank','tariff',
  'pandemic','epidemic','vaccine','outbreak','climate change',
  'earthquake','tsunami','hurricane','disaster','wildfire',
  'protest','uprising','revolution','crackdown','martial law',
  'breakthrough','space','nasa','genocide','massacre','war crimes',
  'tribunal','refugee','asylum','humanitarian','airstrike','shelling',
  'blockade','siege','trade war','energy crisis','oil price',
];

const FLUFF_TERMS = [
  'celebrity','kardashian','taylor swift','bieber',
  'viral video','tiktok','meme','influencer','reality tv',
  'bachelor','oscars','emmys','grammys','red carpet','fashion week',
  'recipe','horoscope','astrology','zodiac',
  'nba trade','nfl draft','lottery winner','funny video',
  'puppy','puppies','rescued kitten','kitten',
  'box office','movie review','album review','instagram',
];

// ─── Lexicon for cortisol fallback (no HF key) ───────────────────
// Mirrors the frontend word-tone approach so the brief always has real
// 0–1 scores even when the emotion model is not configured.
const LEXICON_HIGH = new Set([
  'killed','dead','death','deaths','died','dies','dying',
  'attack','attacked','attacks','bomb','bombed','bombing','bombers',
  'war','wars','conflict','conflicts','crisis','crises',
  'terror','terrorism','terrorist','terrorists',
  'disaster','disasters','massacre','genocide','atrocity',
  'earthquake','flood','flooding','floods','hurricane','typhoon',
  'wildfire','wildfires','shooting','shootings','explosion','explosions',
  'airstrike','airstrikes','missile','missiles',
  'sanctions','invasion','invaded','invades','coup','nuclear',
  'jailed','convicted','arrested','detained','sentenced',
  'casualties','casualty','pandemic','epidemic','outbreak','famine','drought',
  'collapse','collapsed','collapses','violence','violent','unrest',
  'hostage','hostages','blockade','siege','shelling','shelled',
  'clashes','clash','fighting','combat','offensive','militia','insurgent','rebel',
  'warning','threat','threatened','emergency','evacuated','evacuate',
  'wounded','injured','injuries','assassination','assassinated','executed',
]);

const LEXICON_LOW = new Set([
  'peace','ceasefire','agreement','agreements','treaty','treaties',
  'breakthrough','discovery','discovered','discoveries','innovation',
  'award','awarded','awards','prize','prizes',
  'won','win','wins','victory','victories','triumph','triumphed',
  'growth','growing','recovery','recovered','rebounds',
  'success','successful','achieved','achievement','milestone','milestones',
  'cooperation','partnership','collaboration','alliance','alliances',
  'launch','launched','launches','signed','signs','resolved','freed','released',
  'liberation','liberated','celebrate','celebrated','celebration',
  'improved','improving','progress','prosperity','landmark',
]);

/**
 * Word-count tone score used when HF emotion scores are absent.
 * Same formula as the frontend computeTone():
 *   tone  = (positive − negative) / (positive + negative)   → [-1, 1]
 *   cortisol = (1 − tone) / 2                               → [0, 1]
 */
function lexiconCortisol(title) {
  const words = (title || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  let high = 0, low = 0;
  for (const w of words) {
    if (LEXICON_HIGH.has(w)) high++;
    if (LEXICON_LOW.has(w)) low++;
  }
  const total = high + low;
  if (total === 0) return 0.5;
  const tone = (low - high) / total;
  return Math.max(0, Math.min(1, (1 - tone) / 2));
}

/**
 * Build a 1–2 sentence summary. Real API descriptions are preferred;
 * for articles without one (GDELT, Guardian) a template is generated
 * from the headline so the brief always has something to display.
 */
function makeSummary(title, description) {
  if (description && description.length > 30) {
    const d = description.replace(/\[[\s\S]*?\]/g, '').replace(/\s+/g, ' ').trim();
    if (d.length > 30) return d.length > 200 ? d.slice(0, 197) + '…' : d;
  }
  const t = (title || '').trim();
  const colonIdx = t.indexOf(':');
  if (colonIdx > 2 && colonIdx < 50) {
    const ctx  = t.slice(0, colonIdx).trim();
    const body = t.slice(colonIdx + 1).trim();
    return `${body} Situation developing in ${ctx}; global analysts monitoring closely.`;
  }
  return `${t}. Developments ongoing — regional and global implications under analysis.`;
}

/**
 * Picks 5–7 stories spread across cortisol bands (high / medium / low) so
 * the brief always shows a range of global stress levels, not just alarm.
 * Pure in-memory work (<2ms on 1 000 articles) — no cron needed.
 */
function selectBriefArticles(articles) {
  const lc = s => (s || '').toLowerCase();

  function scoreArticle(a, c) {
    const title = lc(a.title);
    for (const t of FLUFF_TERMS) if (title.includes(t)) return -1;
    let hits = 0;
    for (const t of MACRO_TERMS) if (title.includes(t)) hits++;
    // Need at least one macro keyword hit OR a very high cortisol signal.
    if (hits === 0 && c < 0.60) return -1;
    return c + Math.min(hits * 0.18, 0.54);
  }

  const scored = articles
    .map(a => {
      // Always score with the keyword lexicon — never use the HF cortisol value
      // here, because HF stamps every timed-out article with NEUTRAL_SCORE=0.5,
      // which would make all brief scores identical regardless of content.
      const c = lexiconCortisol(a.title);
      return { a, c, s: scoreArticle(a, c) };
    })
    .filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s);

  // Three cortisol bands — targets: 3 high, 2 mid, 2 low.
  const high = scored.filter(x => x.c >= 0.60);
  const mid  = scored.filter(x => x.c >= 0.35 && x.c < 0.60);
  const low  = scored.filter(x => x.c < 0.35);

  const seenKeys = new Set(), domainCount = {};

  function pick(pool, n) {
    const out = [];
    for (const x of pool) {
      if (out.length >= n) break;
      const key = lc(x.a.title).split(/\s+/).slice(0, 6).join(' ');
      if (seenKeys.has(key)) continue;
      const dom = x.a.domain || '';
      if ((domainCount[dom] || 0) >= 2) continue;
      seenKeys.add(key);
      domainCount[dom] = (domainCount[dom] || 0) + 1;
      out.push(x.a);
    }
    return out;
  }

  const result = [
    ...pick(high, 3),
    ...pick(mid,  2),
    ...pick(low,  2),
  ];

  // If any band was thin, backfill from remaining candidates.
  if (result.length < 5) result.push(...pick(scored, 7 - result.length));

  // Sort high → low so the brief reads most alarming first.
  result.sort((a, b) => lexiconCortisol(b.title) - lexiconCortisol(a.title));

  // Stamp each article with its lexicon cortisol so the frontend badge
  // always shows a real, varied score — never HF's 0.5 timeout fallback.
  return result.slice(0, 7).map(a => {
    const c = lexiconCortisol(a.title);
    return {
      ...a,
      cortisol:      +c.toFixed(3),
      cortisolColor: cortisolToHex(c),
      summary:       makeSummary(a.title, a.description),
    };
  });
}

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

  const raw      = dedupeByUrl([...gdelt, ...gnews, ...newsdata, ...newsapi, ...guardian, ...mediastack]);
  // Enrich with HF emotion scores when HF_API_KEY is configured.
  // analyzeArticles() is a no-op (returns raw unchanged) when the key is absent.
  const articles = await analyzeArticles(raw);
  const brief    = selectBriefArticles(articles);

  res.json({
    count:     articles.length,
    hfEnabled: !!process.env.HF_API_KEY,
    perApi: {
      gdelt:      gdelt.length,
      gnews:      gnews.length,
      newsdata:   newsdata.length,
      newsapi:    newsapi.length,
      guardian:   guardian.length,
      mediastack: mediastack.length,
    },
    articles,
    brief,
  });
});

/** Force-clear the cache. Useful for development or scheduled refreshes. */
router.post('/cache/clear', (_req, res) => {
  cache.clear();
  res.json({ ok: true });
});

module.exports = router;
