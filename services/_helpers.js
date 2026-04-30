/**
 * Shared helpers for news service modules.
 *
 * All API fetchers normalize responses into a common shape:
 *   { title, url, domain, sourcecountry, seendate, _api }
 * which is what the frontend buildNewsPayload() expects.
 */

const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '12000', 10);

/**
 * Fetch with an AbortController-driven timeout.
 * Returns the raw Response — caller decides whether to .json() it.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(tid);
  }
}

/** Strip the protocol + leading www. from a URL string. */
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * De-duplicate a list of articles by URL while preserving order.
 * The first occurrence wins.
 */
function dedupeByUrl(articles) {
  const seen = new Set();
  const out = [];
  for (const a of articles) {
    const u = (a.url || '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(a);
  }
  return out;
}

module.exports = { fetchWithTimeout, extractDomain, dedupeByUrl, API_TIMEOUT_MS };
