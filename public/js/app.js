/* =====================================================================
   WORLD CORTISOL INDEX — Frontend

   Architecture:
     - Browser fetches news from our own backend (/api/news/all),
       which proxies GDELT, GNews, NewsData, and NewsAPI server-side
       so API keys stay private and CORS is no longer a concern.
     - Geo data (country/city/state polygons) is still loaded directly
       from Natural Earth's GitHub mirror — those URLs already serve
       proper CORS headers.
     - localStorage keeps a rolling 7-day archive of articles so the
       map stays populated even between page loads.
   ===================================================================== */

// ── Dynamic script loader with CDN fallback ──
function loadScript(primary, fallback) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = primary;
    s.onload = resolve;
    s.onerror = () => {
      console.warn(`Script failed from ${primary}, trying fallback…`);
      const s2 = document.createElement('script');
      s2.src = fallback;
      s2.onload = resolve;
      s2.onerror = () => reject(new Error(`Could not load script: ${primary}`));
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
}

// Check if already loaded (from the static tags above), else re-fetch from fallback
async function ensureLibs() {
  const tasks = [];
  if (typeof THREE === 'undefined') {
    tasks.push(loadScript(
      'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js',
      'https://unpkg.com/three@0.160.0/build/three.min.js'
    ));
  }
  if (typeof Globe === 'undefined') {
    tasks.push(loadScript(
      'https://cdn.jsdelivr.net/npm/globe.gl@2.32.0/dist/globe.gl.min.js',
      'https://unpkg.com/globe.gl@2.32.0/dist/globe.gl.min.js'
    ));
  }
  if (typeof Chart === 'undefined') {
    tasks.push(loadScript(
      'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
      'https://unpkg.com/chart.js@4.4.1/dist/chart.umd.min.js'
    ));
  }
  if (tasks.length) await Promise.all(tasks);
}

// ── Data URLs ──
const NATURAL_EARTH  = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const COUNTRIES_URL  = `${NATURAL_EARTH}/ne_110m_admin_0_countries.geojson`;
const CITIES_URL     = `${NATURAL_EARTH}/ne_50m_populated_places_simple.geojson`;
// Admin-1: states, provinces, territories. ne_50m gives a good balance of
// detail vs. download size — ne_10m would more than double the payload.
const STATES_URL     = `${NATURAL_EARTH}/ne_50m_admin_1_states_provinces.geojson`;

// ── LocalStorage ──
const STORE_KEY   = 'wci_v2_store';
const MAX_AGE_MS  = 30 * 24 * 3600 * 1000; // 30 days
const MAX_STORED  = 30000;

// ─────────────────────────────────────────
// SENTIMENT LEXICONS
// ─────────────────────────────────────────
const NEGATIVE_WORDS = new Set(`
war wars killed kills death deaths dead dies died dying attack attacks attacked
attacker bomb bombs bombed bombing crisis crashes crashed crash riot riots
protest protests protesting arrest arrests arrested controversy conflict
conflicts unrest terror terrorism disaster disasters shooting shootings
tragedy tragic fraud scandal scandals recession collapse collapsed massacre
massacres suicide murder murders murdered assault assaulted victim victims
injured injuries casualties casualty threat threats threaten threatened
warn warns warning panic crackdown condemn condemns condemned sanction
sanctions impeach impeached indict indicted jailed convict convicted crime
criminal crimes rob robbed robbery theft hate hatred tension tensions clash
clashes militant militants terrorist terrorists rebel rebels insurgent
insurgents outrage outraged plunge plunged slump slumps plummet plummeted
tumble default bankrupt bankruptcy layoff layoffs sued lawsuit probe probes
dictator suspend suspended ban banned quit resign resigned sacked expel
expelled flee fled famine outbreak epidemic pandemic rape raped abuse abused
hostage hostages genocide hostile illegal lethal deadly wounded wound flood
floods earthquake quake hurricane typhoon wildfire wildfires drought drone
strikes strike bombing missile missiles invade invaded invasion seized siege
blockade evacuate evacuated evacuation stab stabbed stabbing hijack hijacked
poison poisoned shot shoot shooter gunman gunmen militia militias raid raided
fighting fight fights deny denied denial protester protesters loot looted
looters looting smuggle smuggled trafficking trafficked abusive corrupt
corruption blackmail extort extortion harass harassment harassed explosion
exploded explosive explosions detonated detonation injured hostility nuclear
biological chemical weapons weapon armed airstrike airstrikes shelling shelled
displaced displacement refugee refugees asylum crisis emergenc
`.trim().split(/\s+/));

const POSITIVE_WORDS = new Set(`
win wins won winner winners victory victories peace peaceful agreement
agreements breakthrough treaty treaties donation donations donate donated
raised raise raises award awarded awards recover recovered recovers recovery
save saves saved saving rescue rescues rescued celebrate celebrated celebration
prosperity prosperous education educated educate health healthy healed healing
vaccine vaccines cure cures hero heroes heroic progress milestone achieve
achieved achievement success successes successful growth grow grows grew growing
thrive thrived thrives reform reforms reformed approve approved endorses support
supports supported partnership partnerships partner reconcile reconciled reunite
reunited liberate liberated freedom liberty justice fair fairness equality
dignity honor honored kindness kind generous generosity charity charities
volunteer volunteers medal medals gold silver bronze champion championship
remarkable excellent excellence wonderful amazing impressive spectacular
beautiful glorious triumph triumphs triumphant prevail prevailed optimistic
optimism hope hopes hopeful positive inspire inspired inspiring inspiration
uplift uplifted joy joyful happiness happy delight delighted grateful gratitude
thanks thanked blessing blessed pioneer pioneering innovate innovated innovation
innovative launch launches launched boost boosts boosted strengthen collaborate
collaborated collaboration unite united unify renew renewed prosper prosperity
flourish flourishing thriving vibrant sustainable development advance advances
advanced invest investment investment fund funded funding breakthrough discovery
discovered alliance peace-deal diplomatic diplomacy accord historically record
surpass surpassed exceeded exceeding landmark achieve historic monumental
humanitarian aid helping helped awarded scholarship donated clean renewable
`.trim().split(/\s+/));

const AMBIGUOUS_CITIES = new Set([
  'search','page','home','news','today','world','global','report',
  'city','town','state','north','south','east','west','of','the',
  'and','york','lincoln','victoria','mobile','phoenix','venus',
  'jupiter','amazon','apple','shell','santiago',
]);

const COUNTRY_ALIASES = {
  'america':'US','u.s.':'US','u.s':'US','us':'US','usa':'US','united states':'US',
  'uk':'GB','u.k.':'GB','britain':'GB','england':'GB','scotland':'GB','wales':'GB','great britain':'GB',
  'russia':'RU','russian':'RU','china':'CN','chinese':'CN','beijing':'CN',
  'iran':'IR','iranian':'IR','iraq':'IQ','iraqi':'IQ',
  'israel':'IL','israeli':'IL','palestine':'PS','palestinian':'PS','gaza':'PS','west bank':'PS',
  'ukraine':'UA','ukrainian':'UA','kyiv':'UA','kyiv':'UA','syria':'SY','syrian':'SY',
  'north korea':'KP','south korea':'KR','korea':'KR',
  'japan':'JP','japanese':'JP','tokyo':'JP','india':'IN','indian':'IN','delhi':'IN','mumbai':'IN',
  'pakistan':'PK','afghan':'AF','afghanistan':'AF',
  'germany':'DE','german':'DE','berlin':'DE','france':'FR','french':'FR','paris':'FR',
  'spain':'ES','spanish':'ES','madrid':'ES','italy':'IT','italian':'IT','rome':'IT',
  'turkey':'TR','turkish':'TR','ankara':'TR','egypt':'EG','egyptian':'EG','cairo':'EG',
  'brazil':'BR','brazilian':'BR','mexico':'MX','mexican':'MX',
  'canada':'CA','canadian':'CA','ottawa':'CA','australia':'AU','australian':'AU',
  'south africa':'ZA','nigeria':'NG','kenya':'KE','ethiopia':'ET',
  'saudi':'SA','saudi arabia':'SA','yemen':'YE','lebanon':'LB','lebanese':'LB',
  'venezuela':'VE','argentina':'AR','chile':'CL','colombia':'CO',
  'vietnam':'VN','thailand':'TH','indonesia':'ID','malaysia':'MY',
  'philippines':'PH','filipino':'PH','taiwan':'TW','hong kong':'HK',
  'sudan':'SD','south sudan':'SS','myanmar':'MM','burma':'MM',
  'european union':'EU','poland':'PL','ukraine':'UA',
  'bangladesh':'BD','sri lanka':'LK','nepal':'NP','cambodia':'KH',
  'peru':'PE','ecuador':'EC','bolivia':'BO','paraguay':'PY','uruguay':'UY',
  'morocco':'MA','algeria':'DZ','tunisia':'TN','libya':'LY',
  'ghana':'GH','senegal':'SN','cameroon':'CM','ivory coast':'CI','tanzania':'TZ',
  'angola':'AO','mozambique':'MZ','zambia':'ZM','zimbabwe':'ZW',
  'sweden':'SE','norway':'NO','finland':'FI','denmark':'DK','netherlands':'NL',
  'belgium':'BE','austria':'AT','switzerland':'CH','portugal':'PT','greece':'GR',
  'czech republic':'CZ','czechia':'CZ','hungary':'HU','romania':'RO','bulgaria':'BG',
  'serbia':'RS','croatia':'HR','slovakia':'SK','slovenia':'SI',
  'israel':'IL','jordan':'JO','uae':'AE','united arab emirates':'AE',
  'kuwait':'KW','qatar':'QA','bahrain':'BH','oman':'OM',
  'singapore':'SG','new zealand':'NZ','ireland':'IE',
};

// ─────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────
const $status      = document.getElementById('status');
const $articlePanel= document.getElementById('article-panel');
const $chartSummary= document.getElementById('chart-summary');
const $refresh     = document.getElementById('refresh');
const $overlay     = document.getElementById('loading-overlay');
const $loaderText  = document.getElementById('loader-text');
const $loaderFill  = document.getElementById('loader-fill');
const $arcTotal    = document.getElementById('arc-total');
const $arcSession  = document.getElementById('arc-session');
const $arcCountries= document.getElementById('arc-countries');
const $arcSince    = document.getElementById('arc-since');

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
let news         = null;
let countriesGeo = null;
let statesGeo    = null;
let citiesGeo    = null;
let globe        = null;
let chart        = null;
let citiesIndex  = null;
let citiesRegex  = null;
let countryCentroids  = null;
let countryRegex      = null;
let countryTopCities  = null;
let sessionNewCount   = 0;
let globeInitialized  = false;
let hoveredCountry    = null;
let briefArticles     = [];

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function isoOf(f) {
  const p = f.properties || {};
  for (const k of ['ISO_A2_EH','ISO_A2','WB_A2','FIPS_10_']) {
    const v = p[k]; if (v && v !== '-99' && v.trim()) return v;
  }
  return null;
}
function nameOf(f) {
  const p = f.properties || {};
  return p.NAME || p.ADMIN || p.NAME_LONG || 'Unknown';
}
function cortisolColor(c, alpha=1) {
  const x = Math.max(0, Math.min(1, c));
  const hue = (1 - x) * 120;
  const sat = 55 + Math.abs(0.5 - x) * 30;
  const light = 50 - Math.abs(0.5 - x) * 5;
  return `hsla(${hue.toFixed(1)}, ${sat.toFixed(0)}%, ${light.toFixed(0)}%, ${alpha})`;
}
// Deterministic earthy-green for a polygon
function landColor(seedStr, alpha=1) {
  const h = hashStr(seedStr || '');
  const hue   = 78 + (h % 42);
  const sat   = 22 + ((h >> 7)  % 18);
  const light = 24 + ((h >> 13) % 12);
  return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) >>> 0;
}
function jitter(url, lat, lon, deg=2.5) {
  const h = hashStr(url);
  const rx = ((h & 0xFFFF) / 0xFFFF) - 0.5;
  const ry = (((h >> 16) & 0xFFFF) / 0xFFFF) - 0.5;
  return [lat + ry * deg, lon + rx * deg];
}
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Fetch with AbortController timeout
async function fetchWithTimeout(url, ms=14000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    return r;
  } catch(e) { clearTimeout(tid); throw e; }
}

async function fetchJsonAny(url) {
  const r = await fetchWithTimeout(url, 12000);
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.json();
}

function setProgress(pct) {
  $loaderFill.style.width = `${Math.min(100, pct)}%`;
}
function fmtNum(n) {
  return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);
}
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

// ─────────────────────────────────────────
// SENTIMENT
// ─────────────────────────────────────────
const wordRe = /[A-Za-z][A-Za-z'-]+/g;
function computeTone(text) {
  if (!text) return 0;
  let pos = 0, neg = 0;
  for (const w of (text.toLowerCase().match(wordRe) || [])) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  if (pos === 0 && neg === 0) return 0;
  return (pos - neg) / (pos + neg);
}
function toneToCortisol(tone) {
  return Math.max(0, Math.min(1, (1 - tone) / 2));
}

// ─────────────────────────────────────────
// LOCALSTORE ACCUMULATION
// ─────────────────────────────────────────
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { articles: [], firstFetch: null };
    const s = JSON.parse(raw);
    const cutoff = Date.now() - MAX_AGE_MS;
    const fresh = (s.articles || []).filter(a => a.fetchedAt > cutoff);
    return { articles: fresh, firstFetch: s.firstFetch || null };
  } catch { return { articles: [], firstFetch: null }; }
}

function mergeIntoStore(newArticles) {
  const store = loadStore();
  const seenUrls = new Set(store.articles.map(a => a.url));
  let added = 0;
  for (const a of newArticles) {
    if (!a.url || seenUrls.has(a.url)) continue;
    seenUrls.add(a.url);
    store.articles.push({ ...a, fetchedAt: Date.now() });
    added++;
  }
  if (store.articles.length > MAX_STORED) {
    store.articles.sort((a,b) => b.fetchedAt - a.fetchedAt);
    store.articles = store.articles.slice(0, MAX_STORED);
  }
  if (!store.firstFetch) store.firstFetch = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ articles: store.articles, firstFetch: store.firstFetch }));
  } catch(e) {
    store.articles = store.articles.slice(0, 3000);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
  }
  return { merged: store.articles, added, firstFetch: store.firstFetch };
}

function updateArchivePanel(total, session, countryCount, firstFetch) {
  $arcTotal.textContent    = fmtNum(total);
  $arcSession.textContent  = `+${fmtNum(session)}`;
  $arcCountries.textContent= countryCount;
  $arcSince.textContent    = fmtDate(firstFetch);
  const hpTotal    = document.getElementById('hp-total');
  const hpCountries= document.getElementById('hp-countries');
  const hpSince    = document.getElementById('hp-since');
  if (hpTotal)     hpTotal.textContent    = fmtNum(total);
  if (hpCountries) hpCountries.textContent= countryCount || '—';
  if (hpSince)     hpSince.textContent    = fmtDate(firstFetch);
}

// ─────────────────────────────────────────
// GEO INDEXES
// ─────────────────────────────────────────
function buildCitiesIndex() {
  if (citiesIndex) return;
  const rows = [], seen = new Set();
  for (const f of citiesGeo.features) {
    const p = f.properties || {};
    const name = (p.name || p.NAME || '').trim();
    if (!name || name.length < 4 || AMBIGUOUS_CITIES.has(name.toLowerCase())) continue;
    const coords = (f.geometry || {}).coordinates || [];
    if (coords.length < 2) continue;
    const country = (p.adm0name || p.ADM0NAME || '').trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, name, lat: coords[1], lon: coords[0], country });
  }
  rows.sort((a, b) => b.key.length - a.key.length);
  citiesIndex = new Map(rows.map(r => [r.key, r]));
  const pattern = '\\b(' + rows.map(r => r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b';
  citiesRegex = new RegExp(pattern, 'i');
}

function buildCountryCentroids() {
  if (countryCentroids) return;
  const byName = {}, byIso = {};
  for (const f of countriesGeo.features) {
    const p = f.properties || {};
    const bb = bbox(f.geometry || {});
    if (!bb) continue;
    let cx = (bb[0]+bb[2])/2, cy = (bb[1]+bb[3])/2;
    if (p.LABEL_X != null && p.LABEL_Y != null) { cx = +p.LABEL_X; cy = +p.LABEL_Y; }
    const iso = isoOf(f), name = nameOf(f);
    const rec = { lat: cy, lon: cx, name, iso, bbox: bb };
    if (iso) byIso[iso] = rec;
    for (const nk of [name, p.NAME_LONG, p.ADMIN, p.FORMAL_EN, p.NAME_SORT]) {
      if (nk) byName[String(nk).trim().toLowerCase()] = rec;
    }
  }
  for (const [alias, iso] of Object.entries(COUNTRY_ALIASES)) {
    if (byIso[iso]) byName[alias] = byIso[iso];
  }
  const nameKeys = Object.keys(byName).filter(k => k.length >= 3).sort((a,b) => b.length - a.length);
  const pattern = '\\b(' + nameKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b';
  countryRegex = new RegExp(pattern, 'i');
  countryCentroids = { byName, byIso };
}

function buildCountryTopCities() {
  if (countryTopCities) return;
  const byCountry = {};
  for (const f of citiesGeo.features) {
    const p = f.properties || {};
    const name = (p.name || '').trim();
    const country = (p.adm0name || '').trim();
    const coords = (f.geometry || {}).coordinates || [];
    if (!name || !country || coords.length < 2) continue;
    const pop = parseInt(p.pop_max) || 0;
    const key = country.toLowerCase();
    if (!byCountry[key]) byCountry[key] = [];
    byCountry[key].push({ name, lat: coords[1], lon: coords[0], pop });
  }
  for (const k of Object.keys(byCountry)) {
    byCountry[k].sort((a, b) => b.pop - a.pop);
    byCountry[k] = byCountry[k].slice(0, 25);
  }
  countryTopCities = byCountry;
}

function bbox(geom) {
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity, rings;
  if (geom.type==='Polygon') rings=[geom.coordinates[0]];
  else if (geom.type==='MultiPolygon') rings=geom.coordinates.map(p=>p[0]);
  else return null;
  for (const ring of rings) for (const [x,y] of ring) {
    if (x<minx) minx=x; if (x>maxx) maxx=x; if (y<miny) miny=y; if (y>maxy) maxy=y;
  }
  return [minx, miny, maxx, maxy];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat))
      && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeom(lon, lat, geom, cachedBbox) {
  if (!geom) return false;
  if (cachedBbox) {
    const [x0, y0, x1, y1] = cachedBbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  }
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
              : geom.type === 'MultiPolygon' ? geom.coordinates
              : null;
  if (!polys) return false;
  for (const poly of polys) {
    if (!poly.length) continue;
    if (!pointInRing(lon, lat, poly[0])) continue; // outside outer ring
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

let countryFeatureByIso = null;
function getCountryFeature(iso) {
  if (!iso || !countriesGeo) return null;
  if (!countryFeatureByIso) {
    countryFeatureByIso = {};
    for (const f of countriesGeo.features) {
      const code = isoOf(f);
      if (code) countryFeatureByIso[code] = f;
    }
  }
  return countryFeatureByIso[iso] || null;
}

function pickCountryCity(countryName, url) {
  if (!countryName) return null;
  const cities = countryTopCities[countryName.trim().toLowerCase()];
  if (!cities || !cities.length) return null;
  return cities[hashStr(url) % cities.length];
}

// ─────────────────────────────────────────
// GEOCODING
// ─────────────────────────────────────────
function geocodeArticle(title, sourcecountry, url) {
  if (!citiesRegex || !countryRegex || !countryCentroids) return null;
  if (title) {
    const cm = citiesRegex.exec(title);
    if (cm) {
      const row = citiesIndex.get(cm[1].toLowerCase());
      if (row) {
        let ciso = null;
        if (row.country) {
          const cr = countryCentroids.byName[row.country.toLowerCase()];
          if (cr) ciso = cr.iso;
        }
        const [jlat, jlon] = jitter(url, row.lat, row.lon, 0.4);
        return { lat: jlat, lon: jlon, place: row.name, iso: ciso, country: row.country || null };
      }
    }
    const crm = countryRegex.exec(title);
    if (crm) {
      const rec = countryCentroids.byName[crm[1].toLowerCase()];
      if (rec) {
        const city = pickCountryCity(rec.name, url);
        if (city) {
          const [jl, jo] = jitter(url, city.lat, city.lon, 0.3);
          return { lat: jl, lon: jo, place: city.name, iso: rec.iso, country: rec.name };
        }
        const [jl, jo] = jitter(url, rec.lat, rec.lon, 2.5);
        return { lat: jl, lon: jo, place: rec.name, iso: rec.iso, country: rec.name };
      }
    }
  }
  if (sourcecountry) {
    const sc = sourcecountry.trim().toLowerCase();
    const aliasIso = COUNTRY_ALIASES[sc];
    let rec = null;
    if (aliasIso && countryCentroids.byIso[aliasIso]) {
      rec = countryCentroids.byIso[aliasIso];
    } else {
      rec = countryCentroids.byName[sc];
      if (!rec && sc.length === 2) rec = countryCentroids.byIso[sc.toUpperCase()];
    }
    if (rec) {
      const city = pickCountryCity(rec.name, url);
      if (city) {
        const [jl, jo] = jitter(url, city.lat, city.lon, 0.3);
        return { lat: jl, lon: jo, place: city.name, iso: rec.iso, country: rec.name };
      }
      const [jl, jo] = jitter(url, rec.lat, rec.lon, 2.5);
      return { lat: jl, lon: jo, place: rec.name, iso: rec.iso, country: rec.name };
    }
  }
  return null;
}

// ─────────────────────────────────────────
// NEWS API — talks to our backend
// ─────────────────────────────────────────
async function fetchAllApis() {
  setProgress(10);
  $loaderText.textContent = 'Fetching live news from backend…';

  let data;
  try {
    const r = await fetchWithTimeout('/api/news/all', 30000);
    if (!r.ok) throw new Error(`Backend returned HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    console.warn('[backend] /api/news/all failed:', e.message);
    setProgress(65);
    return [];
  }

  setProgress(65);
  window.__lastPerApiCounts = data.perApi || null;
  briefArticles = data.brief || [];
  if (data.perApi) {
    console.log('[backend] per-API counts:', data.perApi);
    updateApiBadges(data.perApi);
  }
  console.log(`[backend] ${data.count} unique articles, ${briefArticles.length} brief`);
  return data.articles || [];
}

function updateApiBadges(perApi) {
  const $badges = document.getElementById('api-badges');
  if (!$badges) return;
  for (const badge of $badges.querySelectorAll('.api-badge')) {
    const cls = [...badge.classList].find(c => c !== 'api-badge');
    const got = perApi[cls] || 0;
    if (got === 0) {
      badge.style.opacity = '0.35';
      badge.title = `${cls.toUpperCase()} returned no articles — check API key or quota`;
    } else {
      badge.style.opacity = '';
      badge.title = `${cls.toUpperCase()}: ${got} articles`;
    }
  }
}

function animateBriefSummaries() {
  const items = document.querySelectorAll('#brief-list .brief-summary[data-text]');
  items.forEach((el, idx) => {
    const text = el.dataset.text || '';
    el.textContent = '';
    setTimeout(() => {
      let i = 0;
      const id = setInterval(() => {
        if (i < text.length) {
          el.textContent = text.slice(0, ++i) + '▋';
        } else {
          el.textContent = text;
          clearInterval(id);
        }
      }, 10);
    }, idx * 160);
  });
}

function renderBriefPanel(articles) {
  const $list = document.getElementById('brief-list');
  if (!$list) return;
  if (!articles || articles.length === 0) {
    $list.innerHTML = '<li class="brief-placeholder">No high-signal global stories yet — try refreshing.</li>';
    return;
  }
  $list.innerHTML = articles.map((a, i) => {
    const c       = typeof a.cortisol === 'number' ? a.cortisol : 0.5;
    const col     = cortisolColor(c, 0.9);
    const where   = escapeHtml(a.sourcecountry || '');
    const title   = escapeHtml(a.title || 'Untitled');
    const url     = escapeHtml(a.url || '#');
    const summary = escapeHtml(a.summary || '');
    return `<li>
      <a class="brief-item" href="${url}" target="_blank" rel="noopener noreferrer">
        <span class="brief-rank">${i + 1}.</span>
        <div class="brief-body">
          <div class="brief-headline">${title}</div>
          <div class="brief-meta">
            ${where ? `<span class="brief-where">📍 ${where}</span>` : ''}
            <span class="brief-score-badge" style="background:${col}">cortisol ${c.toFixed(2)}</span>
          </div>
          ${summary ? `<div class="brief-summary" data-text="${summary}"></div>` : ''}
        </div>
      </a>
    </li>`;
  }).join('');

  // If the panel is already open (e.g. refresh fired while panel was expanded),
  // kick off the typewriter immediately.
  const panel = document.getElementById('brief-panel');
  if (panel && panel.classList.contains('open')) animateBriefSummaries();
}

// ─────────────────────────────────────────
// BUILD NEWS PAYLOAD
// ─────────────────────────────────────────
function buildNewsPayload(articles) {
  // Cap to the 3000 most-recent articles so the city/country regex pass
  // doesn't freeze the main thread when localStorage has accumulated
  // tens of thousands of entries across multiple reloads.
  const MAX_BUILD = 3000;
  const MAX_DOTS_PER_CLUSTER = 25;
  const input = articles.length > MAX_BUILD
    ? articles.slice().sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0)).slice(0, MAX_BUILD)
    : articles;

  const locationBuckets = {}, byCountry = {};

  for (const art of input) {
    const title = (art.title || '').trim();
    const url   = (art.url || '').trim();
    if (!title || !url) continue;

    const loc = geocodeArticle(title, art.sourcecountry || '', url);
    if (!loc) continue;

    const tone = computeTone(title);
    // Prefer the HF-computed cortisol score supplied by the backend;
    // fall back to the local word-lexicon when it is absent (no HF key,
    // or article loaded from a pre-HF localStorage snapshot).
    const cortisol = (typeof art.cortisol === 'number')
      ? art.cortisol
      : toneToCortisol(tone);
    const key = `${(Math.round(loc.lat*2)/2).toFixed(1)},${(Math.round(loc.lon*2)/2).toFixed(1)}`;

    if (!locationBuckets[key]) {
      locationBuckets[key] = {
        lat: loc.lat, lon: loc.lon, name: loc.place,
        country: loc.iso, countryName: loc.country, articles: [],
      };
    }
    // Cap dots per cluster to keep rendering fast and prevent overlap
    if (locationBuckets[key].articles.length < MAX_DOTS_PER_CLUSTER) {
      locationBuckets[key].articles.push({
        url, title, meta: art.domain || '', api: art._api || '',
        tone: +tone.toFixed(3), cortisol: +cortisol.toFixed(3),
      });
    }

    if (loc.iso) {
      if (!byCountry[loc.iso]) byCountry[loc.iso] = { name: loc.country || loc.iso, tones: [], cortisols: [], count: 0 };
      byCountry[loc.iso].tones.push(tone);
      byCountry[loc.iso].cortisols.push(cortisol);
      byCountry[loc.iso].count++;
    }
  }

  const locations = [];
  for (const bucket of Object.values(locationBuckets)) {
    if (!bucket.articles.length) continue;
    const avgCortisol = bucket.articles.reduce((s, a) => s + a.cortisol, 0) / bucket.articles.length;
    bucket.tone     = +(bucket.articles.reduce((s, a) => s + a.tone, 0) / bucket.articles.length).toFixed(3);
    bucket.cortisol = +avgCortisol.toFixed(3);
    locations.push(bucket);
  }

  const countries = {};
  for (const [iso, v] of Object.entries(byCountry)) {
    const avgTone     = v.tones.length     ? v.tones.reduce((s,t) => s+t, 0)     / v.tones.length     : 0;
    const avgCortisol = v.cortisols.length ? v.cortisols.reduce((s,c) => s+c, 0) / v.cortisols.length : toneToCortisol(avgTone);
    countries[iso] = {
      name: v.name, avgTone: +avgTone.toFixed(3),
      cortisol: +avgCortisol.toFixed(3), count: v.count,
    };
  }

  return { locations, countries, fetchedAt: Date.now()/1000, totalArticles: articles.length };
}

// ─────────────────────────────────────────
// GLOBE
// ─────────────────────────────────────────
function initGlobe() {
  const el = document.getElementById('globe');

  const oc = document.createElement('canvas');
  oc.width = 512; oc.height = 256;
  const octx = oc.getContext('2d');
  const grad = octx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0,   '#020a1a');
  grad.addColorStop(0.3, '#04162e');
  grad.addColorStop(0.5, '#062043');
  grad.addColorStop(0.7, '#04162e');
  grad.addColorStop(1,   '#020a1a');
  octx.fillStyle = grad;
  octx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 6000; i++) {
    octx.fillStyle = `rgba(${40+Math.random()*40}, ${90+Math.random()*40}, 160, ${0.010+Math.random()*0.018})`;
    octx.fillRect(Math.random()*512, Math.random()*256, 1+Math.random()*2, 1);
  }

  globe = Globe()(el)
    .globeImageUrl(oc.toDataURL())
    .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
    .atmosphereColor('rgba(40, 110, 220, 0.5)')
    .atmosphereAltitude(0.22)
    .showGraticules(false);

  function retintGraticules() {
    if (!globe.scene()) return;
    globe.scene().traverse(obj => {
      if ((obj.isLine || obj.isLineSegments) && obj.material && !obj.userData.__wciRecolored) {
        obj.userData.__wciRecolored = true;
        obj.material.color.setHex(0x102040);
        obj.material.opacity = 0.1;
        obj.material.transparent = true;
        obj.material.needsUpdate = true;
      }
    });
  }
  setTimeout(retintGraticules, 150);
  setTimeout(() => {
    updateGlobeData();
    retintGraticules();
  }, 350);

  globe.controls().autoRotate      = true;
  globe.controls().autoRotateSpeed = 0.3;
  el.addEventListener('mousedown', () => { globe.controls().autoRotate = false; });
  el.addEventListener('touchstart', () => { globe.controls().autoRotate = false; }, { passive: true });

  const resize = () => globe.width(el.clientWidth).height(el.clientHeight);
  resize();
  window.addEventListener('resize', resize);
  globeInitialized = true;
}

function updateGlobeData() {
  if (!globe) return;

  if (countriesGeo) {
    globe
      .polygonsData(countriesGeo.features)
      .polygonAltitude(d => d === hoveredCountry ? 0.014 : 0.008)
      .polygonCapColor(d => {
        if (d === hoveredCountry) {
          const c = news?.countries?.[isoOf(d)];
          if (c) return cortisolColor(c.cortisol, 0.92);
          return 'rgba(180, 200, 170, 0.65)';
        }
        return landColor(isoOf(d) || nameOf(d), 0.92);
      })
      .polygonSideColor(d => {
        if (d === hoveredCountry) {
          const c = news?.countries?.[isoOf(d)];
          if (c) return cortisolColor(c.cortisol, 0.4);
          return 'rgba(180, 200, 170, 0.3)';
        }
        return landColor(isoOf(d) || nameOf(d), 0.35);
      })
      .polygonStrokeColor(() => 'rgba(20, 60, 30, 0.55)')
      .polygonLabel(d => {
        const iso = isoOf(d), c = news?.countries?.[iso], name = nameOf(d);
        if (!c) return `<div class="tt"><b>${escapeHtml(name)}</b><br><span style="color:var(--text-dim)">No recent news</span></div>`;
        return `<div class="tt"><b>${escapeHtml(name)}</b><br>Avg cortisol: <b style="color:${cortisolColor(c.cortisol)}">${c.cortisol.toFixed(2)}</b><br>${c.count} article${c.count===1?'':'s'} · click for details</div>`;
      })
      .onPolygonClick(d => {
        const iso = isoOf(d);
        const c = news?.countries?.[iso];
        const name = nameOf(d);
        if (c) showCountryAverage(d, iso, c, name);
        else   showCountryAverage(d, iso, null, name);
      })
      .onPolygonHover(d => {
        document.getElementById('globe').style.cursor = d ? 'pointer' : 'default';
        if (d === hoveredCountry) return;
        hoveredCountry = d;
        globe
          .polygonAltitude(globe.polygonAltitude())
          .polygonCapColor(globe.polygonCapColor())
          .polygonSideColor(globe.polygonSideColor());
      });
  }

  const allPaths = [];

  if (statesGeo && statesGeo.features) {
    for (const f of statesGeo.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Polygon') {
        for (const ring of g.coordinates) {
          allPaths.push({ kind: 'border', pts: ring.map(([lon, lat]) => [lat, lon]) });
        }
      } else if (g.type === 'MultiPolygon') {
        for (const poly of g.coordinates) {
          for (const ring of poly) {
            allPaths.push({ kind: 'border', pts: ring.map(([lon, lat]) => [lat, lon]) });
          }
        }
      }
    }
  }

  const GRID_STEP = 15;
  for (let lat = -75; lat <= 75; lat += GRID_STEP) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 1) pts.push([lat, lon]);
    allPaths.push({ kind: lat === 0 ? 'gridMain' : 'grid', pts });
  }
  for (let lon = -180; lon < 180; lon += GRID_STEP) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 1) pts.push([lat, lon]);
    allPaths.push({ kind: lon === 0 ? 'gridMain' : 'grid', pts });
  }

  if (allPaths.length) {
    const pathColors = {
      border:   'rgba(15, 45, 25, 0.7)',
      grid:     'rgba(120, 160, 200, 0.18)',
      gridMain: 'rgba(160, 190, 220, 0.32)',
    };
    const pathStrokes = {
      border:   0.5,
      grid:     0.35,
      gridMain: 0.55,
    };
    globe
      .pathsData(allPaths)
      .pathPoints(d => d.pts)
      .pathPointLat(p => p[0])
      .pathPointLng(p => p[1])
      // -------------------------------------------------------------
      // 3D FIX: Borders raised to 0.0145 to sit above hovered country
      // -------------------------------------------------------------
      .pathPointAlt(d => d.kind === 'border' ? 0.0145 : 0.0142)
      .pathColor(d => pathColors[d.kind] || 'rgba(15, 45, 25, 0.7)')
      .pathStroke(d => pathStrokes[d.kind] || 0.5)
      .pathDashLength(1)
      .pathDashGap(0)
      .pathTransitionDuration(0);
  }

  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); 

  function packInsideFeature(lat0, lon0, n, feature) {
    if (n <= 0) return { positions: [], dotRadius: 0.55 };
    const cosLat = Math.max(0.15, Math.cos(lat0 * Math.PI / 180));
    const geom = feature ? feature.geometry : null;
    const featBbox = geom ? bbox(geom) : null;

    const tiers = [
      [2.50, 0.38], [1.90, 0.29], [1.40, 0.21],
      [1.00, 0.15], [0.75, 0.11], [0.55, 0.09], [0.40, 0.07],
    ];
    const budget = Math.max(100, n * 12);

    for (const [stepDeg, dotRadius] of tiers) {
      const positions = [];
      for (let i = 0; positions.length < n && i < budget; i++) {
        const r = stepDeg * Math.sqrt(i);
        const theta = i * GOLDEN_ANGLE;
        const lat = lat0 + r * Math.sin(theta);
        const lon = lon0 + (r * Math.cos(theta)) / cosLat;
        if (geom && !pointInGeom(lon, lat, geom, featBbox)) continue;
        positions.push([lat, lon]);
      }
      if (positions.length === n) return { positions, dotRadius };
    }
    
    const [stepDeg, dotRadius] = tiers[tiers.length - 1];
    const positions = [];
    for (let i = 0; positions.length < n; i++) {
      if (i > n * 30) {
        const gi = positions.length;
        const gx = (gi % 7) - 3;
        const gy = Math.floor(gi / 7) - 3;
        positions.push([
          lat0 + gy * 0.06,
          lon0 + (gx * 0.06) / cosLat,
        ]);
        continue;
      }
      
      const r = stepDeg * Math.sqrt(i);
      const theta = i * GOLDEN_ANGLE;
      const lat = lat0 + r * Math.sin(theta);
      const lon = lon0 + (r * Math.cos(theta)) / cosLat;
      
      if (geom && !pointInGeom(lon, lat, geom, featBbox)) continue;
      positions.push([lat, lon]);
    }
    return { positions, dotRadius };
  }

  const dots = [];
  for (const loc of news.locations) {
    const n = loc.articles.length;
    const feature = getCountryFeature(loc.country);
    const { positions, dotRadius } = packInsideFeature(loc.lat, loc.lon, n, feature);
    for (let i = 0; i < n; i++) {
      const [lat, lon] = positions[i];
      const altHash = hashStr((loc.articles[i].url || '') + String(i));
      dots.push({
        lat, lon,
        cortisol: loc.articles[i].cortisol,
        article: loc.articles[i],
        radius: dotRadius,
        loc,
        alt: 0.016 + (altHash % 1000) / 500000,
      });
    }
  }
  
  globe
    .pointsData(dots)
    .pointLat('lat').pointLng('lon')
    // -------------------------------------------------------------
    // 3D FIX: Dots raised to 0.016 to sit above the borders
    // -------------------------------------------------------------
    .pointAltitude(d => d.alt)
    .pointRadius(d => d.radius)
    .pointColor(d => cortisolColor(d.cortisol, 0.95))
    .pointResolution(8)
    .pointLabel(d => {
      const t = d.article.title || '(untitled)';
      const short = t.length > 80 ? t.slice(0, 77) + '…' : t;
      return `<div class="tt"><b>${escapeHtml(short)}</b>${d.loc.countryName?`<br><span class="tt-sub">${escapeHtml(d.loc.countryName)}</span>`:''}<br>cortisol <b style="color:${cortisolColor(d.article.cortisol)}">${d.article.cortisol.toFixed(2)}</b></div>`;
    })
    .onPointClick(d => showArticle(d.article, d.loc))
    .onPointHover(p => { document.getElementById('globe').style.cursor = p ? 'pointer' : 'default'; });
}

// ─────────────────────────────────────────
// CORTISOL METER (semicircle gauge)
// ─────────────────────────────────────────
function cortisolMeterSVG(cortisol) {
  const c = Math.max(0, Math.min(1, cortisol));
  const segs = [
    { c: '#3aa84a' }, { c: '#9bcc36' }, { c: '#e8d736' },
    { c: '#f0a836' }, { c: '#ef6b3b' }, { c: '#e63838' },
  ];
  const cx = 110, cy = 105, rOuter = 92, rInner = 56;
  const polar = (r, deg) => {
    const a = (180 - deg) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const wedges = segs.map((s, i) => {
    const a0 = (i / 6) * 180;
    const a1 = ((i + 1) / 6) * 180;
    const [x0o, y0o] = polar(rOuter, a0);
    const [x1o, y1o] = polar(rOuter, a1);
    const [x0i, y0i] = polar(rInner, a0);
    const [x1i, y1i] = polar(rInner, a1);
    return `<path d="M ${x0o} ${y0o} A ${rOuter} ${rOuter} 0 0 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${rInner} ${rInner} 0 0 0 ${x0i} ${y0i} Z" fill="${s.c}" stroke="#fff" stroke-width="2"/>`;
  }).join('');
  const ang = 180 * c;
  const [nx, ny] = polar(rOuter - 8, ang);
  return `
  <svg class="meter-svg" viewBox="0 0 220 130" xmlns="http://www.w3.org/2000/svg">
    ${wedges}
    <text x="14"  y="118" class="meter-lbl meter-lbl-low">LOW</text>
    <text x="110" y="7"  class="meter-lbl meter-lbl-mid" text-anchor="middle">MEDIUM</text>
    <text x="206" y="118" class="meter-lbl meter-lbl-high" text-anchor="end">HIGH</text>
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#0e2348" stroke-width="4" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="9" fill="#1a3566"/>
    <text x="${cx}" y="${cy + 28}" class="meter-val" text-anchor="middle">${c.toFixed(2)}</text>
  </svg>`;
}

// ─────────────────────────────────────────
// COUNTRY AVERAGE PANEL
// ─────────────────────────────────────────
function showCountryAverage(feature, iso, c, name) {
  const bb = bbox(feature.geometry || {});
  if (bb) {
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    globe.pointOfView({ lat: cy, lng: cx, altitude: 1.7 }, 1000);
  }
  if (!c) {
    $articlePanel.innerHTML = `
      <h2>🗺️ ${escapeHtml(name)}</h2>
      <p class="hint">No recent news collected for this country yet. Try refreshing.</p>`;
    return;
  }
  $articlePanel.innerHTML = `
    <h2>🗺️ ${escapeHtml(name)} — Country Average</h2>
    <div class="meter-wrap">${cortisolMeterSVG(c.cortisol)}</div>
    <div class="loc-summary">
      <span class="badge big" style="background:${cortisolColor(c.cortisol, 0.7)}">avg cortisol ${c.cortisol.toFixed(2)}</span>
      <span class="count">${c.count} article${c.count===1?'':'s'}</span>
    </div>
    <p class="hint" style="margin-top:8px">Click an individual dot on the map to read a specific article.</p>`;
}

// ─────────────────────────────────────────
// SINGLE ARTICLE PANEL (from scatter-dot click)
// ─────────────────────────────────────────
function showArticle(a, loc) {
  globe.pointOfView({ lat: loc.lat, lng: loc.lon, altitude: 1.4 }, 900);
  const apiColors = { gdelt:'#4da8ff', gnews:'#a47cff', newsdata:'#2dd47a', newsapi:'#e8c840', guardian:'#ff6b6b', mediastack:'#ff9900' };
  const apiTag = a.api ? `<span class="api-tag" style="background:${apiColors[a.api]||'#666'}22;color:${apiColors[a.api]||'#aaa'}">${a.api.toUpperCase()}</span>` : '';
  $articlePanel.innerHTML = `
    <h2>📰 Article</h2>
    <div class="loc-name">${escapeHtml(loc.name || loc.countryName || 'News location')}</div>
    ${loc.countryName ? `<div class="country" style="margin-top:2px">${escapeHtml(loc.countryName)}</div>` : ''}
    <div class="meter-wrap">${cortisolMeterSVG(a.cortisol)}</div>
    <div class="article article-detail">
      <a class="article-title" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
      <div class="article-meta">
        <span class="badge" style="background:${cortisolColor(a.cortisol, 0.65)}">cortisol ${a.cortisol.toFixed(2)}</span>
        ${a.meta ? `<span class="src">${escapeHtml(a.meta)}</span>` : ''}
        ${apiTag}
      </div>
    </div>
    <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener" class="open-article-btn">Open article ↗</a>`;
}

function showLocation(loc) {
  globe.pointOfView({ lat: loc.lat, lng: loc.lon, altitude: 1.6 }, 1200);

  const apiColors = { gdelt:'#4da8ff', gnews:'#a47cff', newsdata:'#2dd47a', newsapi:'#e8c840', guardian:'#ff6b6b', mediastack:'#ff9900' };

  const arts = loc.articles.slice(0, 20).map(a => `
    <li class="article">
      <a class="article-title" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
      <div class="article-meta">
        <span class="badge" style="background:${cortisolColor(a.cortisol, 0.65)}">cortisol ${a.cortisol.toFixed(2)}</span>
        ${a.meta ? `<span class="src">${escapeHtml(a.meta)}</span>` : ''}
        ${a.api ? `<span class="api-tag" style="background:${apiColors[a.api]||'#666'}22;color:${apiColors[a.api]||'#aaa'}">${a.api.toUpperCase()}</span>` : ''}
      </div>
    </li>`).join('');

  $articlePanel.innerHTML = `
    <h2>📍 Selected Location</h2>
    <div class="loc-name">${escapeHtml(loc.name || 'News location')}</div>
    <div class="loc-summary">
      <span class="badge big" style="background:${cortisolColor(loc.cortisol, 0.7)}">cortisol ${loc.cortisol.toFixed(2)}</span>
      ${loc.countryName ? `<span class="country">${escapeHtml(loc.countryName)}${loc.country?` (${escapeHtml(loc.country)})`:''}</span>` : ''}
      <span class="count">${loc.articles.length} article${loc.articles.length===1?'':'s'}</span>
    </div>
    <ul class="articles">${arts}</ul>`;
}

// ─────────────────────────────────────────
// CHART
// ─────────────────────────────────────────
function initChart() {
  const allEntries = Object.entries(news.countries || {})
    .filter(([,v]) => v && v.count >= 1);

  if (allEntries.length === 0) { $chartSummary.textContent = 'No data — try refreshing.'; return; }

  // Weighted global mean used as Bayesian prior
  const totalArt = allEntries.reduce((s,[,v]) => s + v.count, 0);
  const globalMean = allEntries.reduce((s,[,v]) => s + v.cortisol * v.count, 0) / Math.max(1, totalArt);

  // Confidence-weighted rank score: a country with k=5 articles worth of
  // "prior" needs ~5 real articles before its own cortisol dominates.
  // This prevents 1-article outliers (e.g. VN cortisol=1.0) from topping
  // the chart over countries with many high-stress articles.
  const PRIOR = 5;
  const entries = allEntries
    .map(([iso, v]) => [iso, v, (v.count * v.cortisol + PRIOR * globalMean) / (v.count + PRIOR)])
    .sort((a, b) => b[2] - a[2]);

  const top = entries.slice(0, 20);
  const ctx = document.getElementById('chart').getContext('2d');
  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map(([iso, v]) => v.name || iso),
      datasets: [{
        label: 'Cortisol',
        data: top.map(([,v]) => v.cortisol),
        backgroundColor: top.map(([,v]) => cortisolColor(v.cortisol, 0.8)),
        borderColor: top.map(([,v]) => cortisolColor(v.cortisol, 1)),
        borderWidth: 1, borderRadius: 3,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          titleFont: { family: "'Space Mono', monospace", size: 11 },
          bodyFont:  { family: "'Outfit', sans-serif", size: 12 },
          padding: 9,
          callbacks: {
            label: ctx => {
              const [, v, rankScore] = top[ctx.dataIndex];
              return [`Cortisol: ${v.cortisol.toFixed(2)}`, `Articles: ${v.count}`, `Rank score: ${rankScore.toFixed(2)}`];
            },
          },
        },
      },
      scales: {
        x: {
          min: 0, max: 1,
          ticks: { color: '#4a5a72', font: { family:"'Space Mono',monospace", size:10 }, stepSize: 0.25 },
          grid: { color: 'rgba(255,255,255,0.035)' },
          title: { display: true, text: 'CORTISOL  0 CALM → 1 STRESSED', color: '#4a5a72', font: { family:"'Space Mono',monospace", size: 9 } },
        },
        y: {
          ticks: { color: '#7a8aa4', font: { family:"'Outfit',sans-serif", size: 11 } },
          grid: { display: false },
        },
      },
    },
  });

  const weighted = globalMean;
  $chartSummary.innerHTML = `WORLD: <b style="color:${cortisolColor(weighted)}">${weighted.toFixed(2)}</b> · ${allEntries.length} COUNTRIES · ${fmtNum(totalArt)} ARTICLES`;
}

// ─────────────────────────────────────────
// REFRESH
// ─────────────────────────────────────────
async function refresh() {
  $refresh.disabled = true;
  $status.textContent = 'FETCHING NEW ARTICLES…';
  try {
    const fresh = await fetchAllApis();
    const { merged, added, firstFetch } = mergeIntoStore(fresh);
    sessionNewCount += added;
    news = buildNewsPayload(merged.length > 0 ? merged : DEMO_ARTICLES);
    if (globeInitialized) updateGlobeData();
    initChart();
    renderBriefPanel(briefArticles);
    const countryCount = Object.keys(news.countries).length;
    updateArchivePanel(merged.length, sessionNewCount, countryCount, firstFetch);
    $status.textContent = `${news.locations.length} LOCATIONS · ${countryCount} COUNTRIES · +${added} NEW`;
  } catch(e) {
    $status.textContent = `REFRESH FAILED: ${e.message}`;
  } finally {
    $refresh.disabled = false;
  }
}

// ─────────────────────────────────────────
// HOMEPAGE CANVAS ANIMATION
// ─────────────────────────────────────────
function initHpCanvas() {
  const canvas = document.getElementById('hp-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function hslToRgba(h, s, l, a) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1/6) return p + (q-p)*6*t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q-p)*(2/3-t)*6;
        return p;
      };
      const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
      r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
    }
    return `rgba(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)},${a})`;
  }

  function mkParticle() {
    const cortisol = Math.random();
    const hue = (1-cortisol)*120;
    const size = 1.5 + Math.random()*3.5;
    return {
      x: Math.random()*W, y: Math.random()*H,
      vx: (Math.random()-0.5)*0.3, vy: (Math.random()-0.5)*0.3,
      size, cortisol, hue,
      alpha: 0.04 + Math.random()*0.25,
      pulse: Math.random()*Math.PI*2,
      pulseSpeed: 0.008 + Math.random()*0.015,
    };
  }

  function initParticles() {
    particles = Array.from({ length: 180 }, mkParticle);
  }

  let raf;
  function animate() {
    raf = requestAnimationFrame(animate);
    ctx.fillStyle = 'rgba(4,6,14,0.15)';
    ctx.fillRect(0, 0, W, H);

    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      p.pulse += p.pulseSpeed;
      if (p.x < -50) p.x = W+50;
      if (p.x > W+50) p.x = -50;
      if (p.y < -50) p.y = H+50;
      if (p.y > H+50) p.y = -50;

      const a = p.alpha * (0.7 + 0.3*Math.sin(p.pulse));
      const r = p.size  * (0.9 + 0.1*Math.sin(p.pulse*1.3));
      const color = hslToRgba(p.hue, 60, 55, a);
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r*6);
      grd.addColorStop(0, color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r*6, 0, Math.PI*2);
      ctx.fill();
    }
  }

  resize();
  initParticles();
  animate();
  window.addEventListener('resize', () => { resize(); initParticles(); });

  return () => cancelAnimationFrame(raf);
}

// ─────────────────────────────────────────
// LOAD ALL (main init)
// ─────────────────────────────────────────
async function loadAll() {
  $loaderText.textContent = 'Loading country boundaries…';
  $status.textContent = 'LOADING GEO DATA…';
  setProgress(0);

  let geoOk = false;
  try {
    $loaderText.textContent = 'Fetching country shapes…';
    const [countriesResp, citiesResp] = await Promise.all([
      fetchJsonAny(COUNTRIES_URL),
      fetchJsonAny(CITIES_URL),
    ]);
    countriesGeo = countriesResp;
    citiesGeo    = citiesResp;
    geoOk = true;
  } catch(e) {
    console.error('Geo data failed:', e);
    try {
      $loaderText.textContent = 'Trying alternate geo source…';
      const alt = 'https://cdn.jsdelivr.net/npm/world-atlas@2';
      const [countriesResp, citiesResp] = await Promise.all([
        fetchJsonAny(`https://unpkg.com/natural-earth-data@1.1.0/ne_110m_admin_0_countries.geojson`),
        fetchJsonAny(`https://unpkg.com/natural-earth-data@1.1.0/ne_50m_populated_places_simple.geojson`),
      ]);
      countriesGeo = countriesResp;
      citiesGeo    = citiesResp;
      geoOk = true;
    } catch(e2) {
      console.error('Alternate geo also failed:', e2);
      $status.textContent = 'GEO DATA UNAVAILABLE — USING DEMO MODE';
      $loaderText.textContent = 'Geo load failed — using demo data…';
    }
  }
  setProgress(15);

  if (geoOk) {
    try {
      $loaderText.textContent = 'Fetching state & province borders…';
      statesGeo = await fetchJsonAny(STATES_URL);
    } catch(e) {
      console.warn('States/provinces failed (non-fatal):', e.message);
      statesGeo = null;
    }
  }

  if (geoOk) {
    $loaderText.textContent = 'Building geo indexes…';
    buildCitiesIndex();
    buildCountryCentroids();
    buildCountryTopCities();
  }
  setProgress(20);

  const { articles: stored, firstFetch } = loadStore();
  $loaderText.textContent = `Loaded ${fmtNum(stored.length)} archived articles…`;
  setProgress(25);

  $loaderText.textContent = 'Fetching live news from 4 APIs…';
  let fresh = [];
  try {
    fresh = await fetchAllApis();
  } catch(e) {
    console.warn('fetchAllApis threw:', e.message);
  }
  setProgress(70);

  const combined = [...stored, ...fresh];
  const allArticles = combined.length > 0 ? combined : DEMO_ARTICLES;
  if (combined.length === 0) {
    $status.textContent = 'ALL APIS UNAVAILABLE — SHOWING DEMO DATA';
  }

  $loaderText.textContent = 'Merging into archive…';
  const { merged, added, firstFetch: fp } = mergeIntoStore(fresh.length > 0 ? fresh : DEMO_ARTICLES);
  sessionNewCount = added;
  setProgress(80);

  $loaderText.textContent = 'Analyzing sentiment…';
  news = geoOk ? buildNewsPayload(merged) : buildNewsPayload(allArticles);
  renderBriefPanel(briefArticles);
  setProgress(92);

  const nLoc     = news.locations.length;
  const nCountry = Object.keys(news.countries).length;
  updateArchivePanel(merged.length, sessionNewCount, nCountry, fp || firstFetch);
  $status.textContent = `${nLoc} LOCATIONS · ${nCountry} COUNTRIES · ${fmtNum(merged.length)} TOTAL ARTICLES`;
  setProgress(100);
}

// ─────────────────────────────────────────
// DEMO FALLBACK
// ─────────────────────────────────────────
const DEMO_ARTICLES = [
  { title:'Ukraine conflict: frontline updates from Kharkiv', url:'https://bbc.com/ukraine1', domain:'bbc.com', sourcecountry:'ukraine', _api:'demo' },
  { title:'Gaza ceasefire talks resume in Cairo amid ongoing conflict', url:'https://aljazeera.com/gaza1', domain:'aljazeera.com', sourcecountry:'egypt', _api:'demo' },
  { title:'Russia launches missile strikes on Kyiv overnight', url:'https://reuters.com/kyiv1', domain:'reuters.com', sourcecountry:'ukraine', _api:'demo' },
  { title:'Israel military operations continue in northern Gaza', url:'https://apnews.com/israel1', domain:'apnews.com', sourcecountry:'israel', _api:'demo' },
  { title:'Sudan civil war: thousands flee to Chad as fighting intensifies', url:'https://guardian.com/sudan1', domain:'theguardian.com', sourcecountry:'sudan', _api:'demo' },
  { title:'Nobel Peace Prize awarded to democracy activists in Myanmar', url:'https://bbc.com/myanmar1', domain:'bbc.com', sourcecountry:'myanmar', _api:'demo' },
  { title:'India launches record-breaking satellite into orbit', url:'https://reuters.com/india1', domain:'reuters.com', sourcecountry:'india', _api:'demo' },
  { title:'Brazil Amazon deforestation falls to ten-year low', url:'https://guardian.com/brazil1', domain:'theguardian.com', sourcecountry:'brazil', _api:'demo' },
  { title:'North Korea fires ballistic missile into Sea of Japan', url:'https://apnews.com/nkorea1', domain:'apnews.com', sourcecountry:'north korea', _api:'demo' },
  { title:'China economy: manufacturing growth beats expectations', url:'https://reuters.com/china1', domain:'reuters.com', sourcecountry:'china', _api:'demo' },
  { title:'Japan earthquake: rescue teams search for survivors in Tokyo suburbs', url:'https://bbc.com/japan1', domain:'bbc.com', sourcecountry:'japan', _api:'demo' },
  { title:'Nigeria presidential election marred by violence and fraud claims', url:'https://guardian.com/nigeria1', domain:'theguardian.com', sourcecountry:'nigeria', _api:'demo' },
  { title:'Kenya drought emergency declared as crops fail across eastern regions', url:'https://apnews.com/kenya1', domain:'apnews.com', sourcecountry:'kenya', _api:'demo' },
  { title:'Ethiopia peace deal signed bringing end to Tigray conflict', url:'https://bbc.com/ethiopia1', domain:'bbc.com', sourcecountry:'ethiopia', _api:'demo' },
  { title:'Germany announces record investment in green hydrogen energy', url:'https://dw.com/germany1', domain:'dw.com', sourcecountry:'germany', _api:'demo' },
  { title:'France protests against pension reform turn violent in Paris', url:'https://france24.com/france1', domain:'france24.com', sourcecountry:'france', _api:'demo' },
  { title:'Spain wildfires rage across Valencia region, thousands evacuated', url:'https://reuters.com/spain1', domain:'reuters.com', sourcecountry:'spain', _api:'demo' },
  { title:'Italy floods: Venice underwater after record rainfall', url:'https://apnews.com/italy1', domain:'apnews.com', sourcecountry:'italy', _api:'demo' },
  { title:'Mexico cartel violence: army deploys to border cities', url:'https://nytimes.com/mexico1', domain:'nytimes.com', sourcecountry:'mexico', _api:'demo' },
  { title:'Argentina economic crisis: IMF agrees new bailout terms', url:'https://reuters.com/argentina1', domain:'reuters.com', sourcecountry:'argentina', _api:'demo' },
  { title:'Colombia celebrates record low murder rate in Bogotá', url:'https://apnews.com/colombia1', domain:'apnews.com', sourcecountry:'colombia', _api:'demo' },
  { title:'USA Congress passes landmark AI regulation bill', url:'https://nytimes.com/usa1', domain:'nytimes.com', sourcecountry:'america', _api:'demo' },
  { title:'Canada wildfires threaten Alberta oil sands operations', url:'https://reuters.com/canada1', domain:'reuters.com', sourcecountry:'canada', _api:'demo' },
  { title:'Australia floods: Queensland declares disaster as rivers burst banks', url:'https://bbc.com/australia1', domain:'bbc.com', sourcecountry:'australia', _api:'demo' },
  { title:'Iran nuclear talks collapse after latest IAEA inspection', url:'https://apnews.com/iran1', domain:'apnews.com', sourcecountry:'iran', _api:'demo' },
  { title:'Pakistan floods: millions displaced as monsoon season worsens', url:'https://aljazeera.com/pakistan1', domain:'aljazeera.com', sourcecountry:'pakistan', _api:'demo' },
  { title:'Indonesia announces new capital city Nusantara officially open', url:'https://bbc.com/indonesia1', domain:'bbc.com', sourcecountry:'indonesia', _api:'demo' },
  { title:'Philippines typhoon kills dozens, hundreds missing in Mindanao', url:'https://apnews.com/philippines1', domain:'apnews.com', sourcecountry:'philippines', _api:'demo' },
  { title:'Vietnam achieves record GDP growth driven by semiconductor exports', url:'https://reuters.com/vietnam1', domain:'reuters.com', sourcecountry:'vietnam', _api:'demo' },
  { title:'Turkey earthquake kills hundreds in eastern provinces', url:'https://bbc.com/turkey1', domain:'bbc.com', sourcecountry:'turkey', _api:'demo' },
  { title:'Egypt hosts peace summit for Horn of Africa nations', url:'https://aljazeera.com/egypt1', domain:'aljazeera.com', sourcecountry:'egypt', _api:'demo' },
  { title:'South Africa power cuts ease as new solar plants come online', url:'https://reuters.com/za1', domain:'reuters.com', sourcecountry:'south africa', _api:'demo' },
  { title:'Poland wins landmark climate compensation case at European court', url:'https://dw.com/poland1', domain:'dw.com', sourcecountry:'germany', _api:'demo' },
  { title:'Sweden NATO integration complete with joint Arctic exercises', url:'https://dw.com/sweden1', domain:'dw.com', sourcecountry:'germany', _api:'demo' },
  { title:'Saudi Arabia mega-city NEOM construction accelerates', url:'https://reuters.com/saudi1', domain:'reuters.com', sourcecountry:'saudi', _api:'demo' },
  { title:'Bangladesh floods displace millions ahead of election', url:'https://aljazeera.com/bangladesh1', domain:'aljazeera.com', sourcecountry:'bangladesh', _api:'demo' },
  { title:'Morocco earthquake recovery efforts praised by UN', url:'https://apnews.com/morocco1', domain:'apnews.com', sourcecountry:'morocco', _api:'demo' },
  { title:'Thailand election results contested by opposition parties', url:'https://guardian.com/thailand1', domain:'theguardian.com', sourcecountry:'thailand', _api:'demo' },
  { title:'Greece wildfires force mass evacuations near Athens', url:'https://bbc.com/greece1', domain:'bbc.com', sourcecountry:'greece', _api:'demo' },
  { title:'Ghana election: incumbent wins landslide victory', url:'https://bbc.com/ghana1', domain:'bbc.com', sourcecountry:'ghana', _api:'demo' },
  { title:'Ukraine celebrates liberation of key eastern city', url:'https://reuters.com/ukraine2', domain:'reuters.com', sourcecountry:'ukraine', _api:'demo' },
  { title:'Singapore announces bold green economy plan', url:'https://straitstimes.com/sg1', domain:'straitstimes.com', sourcecountry:'singapore', _api:'demo' },
  { title:'New Zealand PM unveils historic indigenous rights accord', url:'https://bbc.com/nz1', domain:'bbc.com', sourcecountry:'new zealand', _api:'demo' },
  { title:'South Korea K-pop industry wins UNESCO cultural recognition', url:'https://reuters.com/sk1', domain:'reuters.com', sourcecountry:'south korea', _api:'demo' },
  { title:'Taiwan holds landmark trade agreement signing with US', url:'https://nytimes.com/taiwan1', domain:'nytimes.com', sourcecountry:'taiwan', _api:'demo' },
];

// ─────────────────────────────────────────
// HOMEPAGE LOGIC
// ─────────────────────────────────────────
let stopHpCanvas;

function initHomepage() {
  stopHpCanvas = initHpCanvas();

  const { articles: stored, firstFetch } = loadStore();
  const hpTotal    = document.getElementById('hp-total');
  const hpSince    = document.getElementById('hp-since');
  if (hpTotal) hpTotal.textContent = stored.length > 0 ? fmtNum(stored.length) : '—';
  if (hpSince) hpSince.textContent = fmtDate(firstFetch);

  document.getElementById('hp-enter').addEventListener('click', () => {
    const hp  = document.getElementById('homepage');
    const app = document.getElementById('app');
    hp.classList.add('exiting');
    app.classList.remove('app-hidden');
    setTimeout(() => {
      app.classList.add('visible');
      if (stopHpCanvas) stopHpCanvas();
    }, 200);
    setTimeout(() => { hp.style.display = 'none'; }, 1000);
  });

  document.getElementById('home-btn').addEventListener('click', () => {
    const hp  = document.getElementById('homepage');
    const app = document.getElementById('app');
    hp.style.display = '';
    hp.classList.remove('exiting');
    app.classList.remove('visible');
    setTimeout(() => { app.classList.add('app-hidden'); }, 700);
    stopHpCanvas = initHpCanvas();
    const { articles, firstFetch: fp } = loadStore();
    const hpT = document.getElementById('hp-total');
    const hpS = document.getElementById('hp-since');
    const hpC = document.getElementById('hp-countries');
    if (hpT) hpT.textContent = fmtNum(articles.length);
    if (hpS) hpS.textContent = fmtDate(fp);
    if (hpC && news) hpC.textContent = Object.keys(news.countries).length;
  });
}

// ─────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────
$refresh.addEventListener('click', refresh);

// Brief panel toggle
(function () {
  const panel  = document.getElementById('brief-panel');
  const toggle = document.getElementById('brief-toggle');
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) animateBriefSummaries();
  });
})();

initHomepage();

(async function main() {
  try {
    await ensureLibs();
  } catch(e) {
    $status.textContent = 'FAILED TO LOAD GLOBE LIBRARY — CHECK CONNECTION';
    $loaderText.textContent = 'Could not load required scripts. Please reload.';
    return;
  }
  try {
    await loadAll();
  } catch(e) {
    console.error('loadAll failed:', e);
    $status.textContent = `NETWORK ERROR — DEMO MODE`;
    $loaderText.textContent = 'Using built-in demo dataset…';
    if (!countriesGeo || !citiesGeo) {
      $loaderText.textContent = 'Cannot load map data. Check your internet connection and reload.';
      $status.textContent = 'OFFLINE — RELOAD TO RETRY';
      return;
    }
    const { merged, added, firstFetch } = mergeIntoStore(DEMO_ARTICLES);
    sessionNewCount = added;
    news = buildNewsPayload(merged);
    updateArchivePanel(merged.length, sessionNewCount, Object.keys(news.countries).length, firstFetch);
  }
  try {
    initGlobe();
    initChart();
  } catch(e) {
    console.error('Globe/chart init failed:', e);
    $status.textContent = `RENDER ERROR: ${e.message}`;
  }
  $overlay.classList.add('hidden');
})();