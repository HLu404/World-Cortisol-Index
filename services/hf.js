/**
 * Hugging Face Inference API — emotion analysis service.
 *
 * Model: j-hartmann/emotion-english-distilroberta-base
 *   A DistilRoBERTa model fine-tuned on six emotion datasets.
 *   Output labels (all scores sum to 1.0 per article):
 *     anger · disgust · fear · joy · neutral · sadness · surprise
 *
 * Architecture
 * ────────────
 *  1. Article titles are de-duplicated by normalised text so the same
 *     headline is never sent to HF twice, even from different sources.
 *  2. Unique uncached titles are chunked into batches of BATCH_SIZE and
 *     sent with up to MAX_CONCURRENCY parallel HF requests.
 *  3. A hard wall-clock timeout (ANALYSIS_TIMEOUT_MS) ensures the /all
 *     route never blocks indefinitely — any titles not processed in time
 *     silently receive NEUTRAL_SCORE = 0.5.
 *  4. On HTTP 503 ("model loading") we honour the server's estimated_time
 *     and retry once; all other errors are caught per-batch so one failure
 *     never aborts the rest.
 *  5. Scores are stored in an in-memory LRU cache keyed by normalised
 *     title text and capped at MAX_CACHE_SIZE entries.
 */

'use strict';

const { fetchWithTimeout } = require('./_helpers');

// ── Configuration ────────────────────────────────────────────────────────────

const HF_MODEL_URL       = 'https://api-inference.huggingface.co/models/j-hartmann/emotion-english-distilroberta-base';
const BATCH_SIZE         = 16;      // titles per HF request
const MAX_CONCURRENCY    = 3;       // parallel HF requests at once
const ANALYSIS_TIMEOUT_MS = 14000; // total ms budget for enriching one /all response
const HF_REQUEST_TIMEOUT  = 26000; // ms for a single HF HTTP call (includes cold-start retry wait)

const NEUTRAL_SCORE  = 0.5;
const NEUTRAL_COLOR  = '#808000';   // olive – used before HF key is set

// ── In-memory title → cortisol cache ─────────────────────────────────────────

const scoreCache     = new Map();   // normalised title → cortisol (0–1)
const MAX_CACHE_SIZE = 15000;

function cacheSet(key, value) {
  if (scoreCache.size >= MAX_CACHE_SIZE) {
    // Evict the oldest entry (Map preserves insertion order)
    scoreCache.delete(scoreCache.keys().next().value);
  }
  scoreCache.set(key, value);
}

function normaliseTitle(t) {
  return (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── Cortisol Score algorithm ──────────────────────────────────────────────────
//
// Each HF output is a {label, score} pair; all scores in one prediction sum
// to 1.0.  We weight each emotion by how strongly it drives physiological
// stress (cortisol release):
//
//   High-stress drivers  → positive weight  (pushes score toward 1.0)
//   Low-stress / calm    → negative weight  (pushes score toward 0.0)
//   Ambiguous            → near-zero weight
//
// The weighted sum therefore lies in [-1, 1].  Shifting by +1 and halving
// maps that onto [0, 1] without any arbitrary "squashing":
//
//   pure fear    → weighted ≈  1.0 → cortisol = 1.0
//   pure joy     → weighted ≈ -1.0 → cortisol = 0.0
//   pure neutral → weighted =  0.0 → cortisol = 0.5  (the NEUTRAL_SCORE)

const EMOTION_WEIGHTS = {
  fear:     1.00,
  anger:    0.85,
  disgust:  0.65,
  sadness:  0.55,
  surprise: 0.10,  // surprise alone tells us little about valence
  neutral:  0.00,
  joy:     -1.00,
};

function emotionsToCortisol(labelScores) {
  let weighted = 0;
  for (const { label, score } of labelScores) {
    const w = EMOTION_WEIGHTS[label.toLowerCase()];
    if (w !== undefined) weighted += w * score;
  }
  return Math.max(0, Math.min(1, (weighted + 1) / 2));
}

// ── Color mapping ─────────────────────────────────────────────────────────────
//
// We traverse the HSL hue arc from 120° (green) to 0° (red).
// Saturation increases slightly toward red to keep both extremes vivid;
// lightness drops a touch toward red for the same reason.
//
//   score 0.0 → hue 120°, sat 70%, lit 44%  →  bright green  (#1ccc1c-ish)
//   score 0.5 → hue  60°, sat 80%, lit 42%  →  amber / yellow
//   score 1.0 → hue   0°, sat 90%, lit 40%  →  bright red    (#cc1414-ish)

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const ch = n => {
    const k     = (n + h / 30) % 12;
    const value = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * value).toString(16).padStart(2, '0');
  };
  return `#${ch(0)}${ch(8)}${ch(4)}`;
}

function cortisolToHex(score) {
  const s   = Math.max(0, Math.min(1, score));
  const hue = Math.round((1 - s) * 120);     // 120 → 0
  const sat = Math.round(70 + s * 20);        // 70% → 90%
  const lit = Math.round(44 - s * 4);         // 44% → 40%
  return hslToHex(hue, sat, lit);
}

// ── HF API call ───────────────────────────────────────────────────────────────

/**
 * POST a batch of title strings to the HF Inference endpoint.
 *
 * Returns an array-of-arrays – one inner [{label,score},...] per input title.
 * Retries once if the model is still cold-starting (HTTP 503 + estimated_time).
 */
async function callHF(titles, retried = false) {
  const apiKey = process.env.HF_API_KEY;

  const r = await fetchWithTimeout(
    HF_MODEL_URL,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ inputs: titles }),
    },
    HF_REQUEST_TIMEOUT,
  );

  // 503 = model cold-start. Honour the server's estimated warm-up time.
  if (r.status === 503 && !retried) {
    let waitMs = 20000;
    try {
      const body = await r.json();
      if (body.estimated_time) waitMs = Math.min(body.estimated_time * 1000, 30000);
      console.log(`[HF] model loading – retrying in ${Math.round(waitMs / 1000)} s…`);
    } catch { /* ignore JSON parse error on 503 body */ }
    await new Promise(res => setTimeout(res, waitMs));
    return callHF(titles, true);
  }

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 150)}`);
  }

  const data = await r.json();

  // The API returns a flat array when given a single string input.
  // We always send an array, but guard defensively in case the server
  // normalises it back.
  if (data.length && !Array.isArray(data[0])) return [data];
  return data;
}

// ── Batch processor ───────────────────────────────────────────────────────────

async function processBatch(batch) {
  // Truncate each title to 512 chars to stay within model token limits
  const titles = batch.map(({ art }) => (art.title || '').slice(0, 512));

  try {
    const results = await callHF(titles);
    hfConsecutiveFailures = 0; // reset on success
    for (let j = 0; j < batch.length; j++) {
      const labelScores = results[j];
      if (Array.isArray(labelScores) && labelScores.length) {
        cacheSet(batch[j].cacheKey, emotionsToCortisol(labelScores));
      }
    }
  } catch (e) {
    hfConsecutiveFailures++;
    // 404 means HF is blocking this server's IP (common on cloud deployments).
    // Trip the circuit breaker so we stop spamming the logs.
    if (e.message.includes('404') || e.message.includes('Cannot POST')) {
      hfDisabled = true;
      console.warn('[HF] 404 from inference API — likely datacenter IP block. Disabling HF scoring for this session; lexicon fallback will be used instead.');
      return;
    }
    if (hfConsecutiveFailures >= HF_FAILURE_THRESHOLD) {
      hfDisabled = true;
      console.warn(`[HF] ${hfConsecutiveFailures} consecutive failures — disabling for this session.`);
      return;
    }
    console.warn(`[HF] batch (${titles.length} titles) failed: ${e.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich an array of article objects with:
 *   cortisol      {number}  0.0 (calm) – 1.0 (stressed)
 *   cortisolColor {string}  hex colour matching the cortisol score
 *
 * - Titles already in the in-memory cache are served instantly.
 * - Uncached titles are sent to HF in parallel batches.
 * - After ANALYSIS_TIMEOUT_MS the function stops waiting and returns
 *   whatever it has; remaining articles get NEUTRAL_SCORE.
 * - If HF_API_KEY is absent, every article gets NEUTRAL_SCORE so the
 *   rest of the pipeline degrades gracefully to the lexicon fallback.
 */
// Circuit breaker: if HF returns consistent 404s (datacenter IP blocked),
// stop calling it for the rest of the process lifetime to avoid log spam.
let hfDisabled = false;
let hfConsecutiveFailures = 0;
const HF_FAILURE_THRESHOLD = 3;

async function analyzeArticles(articles) {
  if (!articles.length) return articles;
  if (!process.env.HF_API_KEY) return articles;
  if (hfDisabled) return articles;

  // Find articles whose titles aren't in the score cache yet
  const uncached = [];
  for (const art of articles) {
    const key = normaliseTitle(art.title);
    if (!scoreCache.has(key)) uncached.push({ art, cacheKey: key });
  }

  if (uncached.length > 0) {
    const batches = [];
    for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
      batches.push(uncached.slice(i, i + BATCH_SIZE));
    }

    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;

    // Walk through batches MAX_CONCURRENCY at a time
    for (let i = 0; i < batches.length; i += MAX_CONCURRENCY) {
      if (Date.now() >= deadline) {
        console.warn(`[HF] timeout – skipped ${batches.length - i} batch(es), using neutral fallback`);
        break;
      }
      const group = batches.slice(i, i + MAX_CONCURRENCY);
      await Promise.allSettled(group.map(processBatch));
    }
  }

  // Attach scores from cache (or neutral for anything that timed out / errored)
  return articles.map(art => {
    const key      = normaliseTitle(art.title);
    const cortisol = scoreCache.has(key) ? scoreCache.get(key) : NEUTRAL_SCORE;
    return {
      ...art,
      cortisol:      +cortisol.toFixed(3),
      cortisolColor: cortisolToHex(cortisol),
    };
  });
}

module.exports = { analyzeArticles, cortisolToHex, NEUTRAL_SCORE, NEUTRAL_COLOR };
