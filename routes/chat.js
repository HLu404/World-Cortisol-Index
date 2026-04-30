'use strict';

/**
 * POST /api/chat — RAG chatbot via Groq (free tier).
 *
 * Groq provides Llama 3.1 8B at ~500 tokens/s on their free plan
 * (~200 req/day, no credit card).  Get a key at console.groq.com.
 *
 * The Groq API is OpenAI-compatible so we use a plain fetch call —
 * no extra dependency needed.
 */

const express = require('express');
const router  = express.Router();
const { fetchWithTimeout } = require('../services/_helpers');

// ─── Config ───────────────────────────────────────────────────────
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant'; // free, fast, 128k context

// ─── Rate limiting ────────────────────────────────────────────────
const ipWindows      = new Map();
const RATE_LIMIT     = 10;
const RATE_WINDOW_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, win] of ipWindows) if (now > win.resetAt) ipWindows.delete(ip);
}, 5 * 60_000);

function isRateLimited(ip) {
  const now = Date.now();
  const win = ipWindows.get(ip);
  if (!win || now > win.resetAt) {
    ipWindows.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (win.count >= RATE_LIMIT) return true;
  win.count++;
  return false;
}

// ─── System prompt ────────────────────────────────────────────────
const SYSTEM_PROMPT =
`You are an analytical assistant embedded in the World Cortisol Index — \
a real-time global news stress mapping application that maps planetary \
stress through live news sentiment analysis.

HOW TO ANSWER:
1. A set of current news articles from the live feed will be provided. \
   When the question is about those events, prioritise that information \
   and cite source domains (e.g. "According to bbc.com…").
2. For general questions — history, geopolitics, concepts, background \
   context, or anything not covered by the articles — answer from your \
   own knowledge. Clearly distinguish article-sourced facts from \
   background knowledge when mixing both.
3. You may reference cortisol stress scores (0 = calm, 1 = high stress) \
   when relevant to the question.
4. Be concise: 2-4 sentences for most answers; longer only when genuinely \
   necessary.
5. Maintain a measured, analytical tone. Avoid sensationalism.`;

// ─── Context builder ──────────────────────────────────────────────
function buildContext(articles) {
  return articles
    .slice(0, 15)
    .map((a, i) => {
      const score  = typeof a.cortisol === 'number'
        ? ` [cortisol: ${a.cortisol.toFixed(2)}]` : '';
      const source = a.domain        ? ` (${a.domain})`         : '';
      const where  = a.sourcecountry ? ` — ${a.sourcecountry}`  : '';
      const blurb  = a.summary       ? `\n   ${a.summary}`      : '';
      return `${i + 1}. "${a.title}"${source}${where}${score}${blurb}`;
    })
    .join('\n');
}

// ─── POST /api/chat ───────────────────────────────────────────────
router.post('/', async (req, res) => {
  const ip = (req.ip || req.socket?.remoteAddress || 'unknown').replace('::ffff:', '');
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests — please wait a moment.' });
  }

  const { question, articles } = req.body || {};

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }
  if (question.trim().length > 500) {
    return res.status(400).json({ error: 'Question too long (max 500 characters).' });
  }
  if (!Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({
      error: 'No article context found. Make sure the news feed has loaded.',
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    return res.status(503).json({
      error: 'AI chat needs a GROQ_API_KEY. Get a free key at console.groq.com and add it to your .env file.',
    });
  }

  const context     = buildContext(articles);
  const userMessage = `CURRENT NEWS ARTICLES:\n${context}\n\nQUESTION: ${question.trim()}`;

  try {
    const r = await fetchWithTimeout(
      GROQ_URL,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:       GROQ_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userMessage   },
          ],
          max_tokens:  400,
          temperature: 0.3,
        }),
      },
      20_000,
    );

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[chat] Groq ${r.status}:`, body.slice(0, 300));

      if (r.status === 401) {
        return res.status(503).json({ error: 'Invalid GROQ_API_KEY — check your .env file.' });
      }
      if (r.status === 429) {
        return res.status(429).json({ error: 'Groq rate limit reached — try again in a moment.' });
      }
      return res.status(503).json({ error: `AI service error (${r.status}) — try again shortly.` });
    }

    const data   = await r.json();
    const answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      console.error('[chat] empty Groq response:', JSON.stringify(data).slice(0, 200));
      return res.status(503).json({ error: 'Model returned an empty response — please try again.' });
    }

    res.json({ answer });

  } catch (err) {
    console.error('[chat] error:', err.message);
    const isTimeout = err.name === 'AbortError' || err.message.includes('abort');
    res.status(503).json({
      error: isTimeout
        ? 'Request timed out — please try again.'
        : 'Could not reach the AI service — check your internet connection.',
    });
  }
});

module.exports = router;
