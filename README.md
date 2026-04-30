# 🧠 World Cortisol Index

A real-time global "stress map" — a 3D Earth where each country is colored by the sentiment of its current news headlines. Articles are pulled from **GDELT, GNews, NewsData,** and **NewsAPI**, scored with a positive/negative lexicon, and rendered on a rotating globe.

This repo is the **full-stack rewrite** of an earlier single-file HTML build. The original kept API keys in browser JavaScript and routed requests through a cascade of public CORS proxies — fine for a demo, brittle for anything real. The version here moves the API calls to a Node/Express backend so keys stay server-side and the frontend just talks to one endpoint.

## What the app does

- **Globe view** — a Three.js / globe.gl visualization of the world. Each article appears as a dot on its country, packed via a Fibonacci spiral and clipped to the country polygon.
- **Sentiment scoring** — every headline runs through a positive/negative word lexicon. The result is a 0→1 "cortisol" score (calm → stressed).
- **Country averages** — clicking a country shows its average cortisol; clicking a dot opens the underlying article.
- **Bar chart** — the sidebar shows the 20 most-stressed countries, ranked.
- **Rolling archive** — articles persist in `localStorage` for 7 days so the map keeps content between visits.

## Architecture

```
┌──────────────────────────────────┐         ┌──────────────────────────┐
│  Browser  (public/index.html,    │         │   Express server          │
│            css/styles.css,       │         │   (server.js)             │
│            js/app.js)            │         │                          │
│                                  │  ────▶  │  /api/news/all  ─┐       │
│  - 3D globe (globe.gl)           │         │  /api/news/gdelt │       │
│  - Sentiment scoring             │         │  /api/news/gnews │       │
│  - Geocoding (Natural Earth)     │         │  /api/news/...   │       │
│  - localStorage archive          │         │                  ▼       │
└──────────────────────────────────┘         │   In-memory cache (TTL)  │
                                             │                  │       │
                                             │                  ▼       │
                                             │   GDELT / GNews / NewsData │
                                             │   / NewsAPI (keys in .env) │
                                             └──────────────────────────┘
```

### What moved to the backend

| Concern | Before (single file) | Now |
| --- | --- | --- |
| API keys | Hard-coded in client JS | `.env` on server only |
| CORS | 4-deep public proxy cascade | Server-side fetch — no proxies |
| Caching | None | In-memory cache, configurable TTL |
| Rate-limit safety | One user could exhaust the free quota in seconds | Cache absorbs repeat requests |

### What stayed on the frontend

- Sentiment scoring (it's just word-set lookups, fast in the browser)
- Geo-data loading (Natural Earth on `raw.githubusercontent.com` already serves CORS)
- All visual rendering (globe, chart, panels)

## Quick start

You'll need **Node 18 or newer** (the server uses the global `fetch`).

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template and add your keys
cp .env.example .env
# then edit .env

# 3. Start the server
npm start
```

Then open <http://localhost:3000>.

### API keys

GDELT is free and needs no key. The other three need free signups:

| API | Free tier | Sign up |
| --- | --- | --- |
| GDELT | unlimited (rate-limited) | no signup |
| GNews | 100 req/day | <https://gnews.io/> |
| NewsData | 200 credits/day | <https://newsdata.io/> |
| NewsAPI | 100 req/day (dev only) | <https://newsapi.org/> |

If a key is missing, that API is skipped — the app still works with whichever sources are configured. GDELT alone gives you a few hundred articles per refresh, so the map will populate even with zero paid keys.

## API reference

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/news/all` | Fetch from all four sources, dedupe, return `{ count, perApi, articles }` |
| `GET` | `/api/news/gdelt` | GDELT only |
| `GET` | `/api/news/gnews` | GNews only |
| `GET` | `/api/news/newsdata` | NewsData only |
| `GET` | `/api/news/newsapi` | NewsAPI only |
| `POST` | `/api/news/cache/clear` | Force-evict the cache |
| `GET` | `/api/health` | `{ status, time, apis: { gdelt, gnews, newsdata, newsapi } }` — `apis` flags which keys are configured |

Every article has the same shape regardless of source:

```json
{
  "title": "string",
  "url": "string",
  "domain": "bbc.com",
  "sourcecountry": "ukraine",
  "seendate": "2026-04-29T12:34:56Z",
  "_api": "gdelt"
}
```

## Project layout

```
.
├── server.js              # Express entry point
├── routes/
│   └── news.js            # /api/news/* — caching + aggregation
├── services/
│   ├── _helpers.js        # fetchWithTimeout, dedupeByUrl
│   ├── gdelt.js
│   ├── gnews.js
│   ├── newsdata.js
│   └── newsapi.js
├── public/                # Static frontend (served by Express)
│   ├── index.html
│   ├── css/styles.css
│   └── js/app.js
├── package.json
├── .env.example
└── README.md
```

## Deploying

The server is a stock Node + Express app — drop it on Render, Fly.io, Railway, a small VPS, anywhere that supports Node 18+. Set the same env vars from `.env.example` on the host.

For multi-instance deployments, swap the in-memory cache in `routes/news.js` for Redis — the rest of the code already treats the cache as an async black box.

## License

MIT.
