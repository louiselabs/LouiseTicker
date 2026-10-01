'use strict';
// LouiseTicker – RSS aggregator & curated ticker feed compiler.
// Zero dependencies: requires Node.js 18+ (uses built-in fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { fetchFeed, escapeXml, parseFeed } = require('./lib/rss');
const { categorize } = require('./public/categorize');
const schedule = require('./public/schedule');
const weather = require('./lib/weather');
const { Store, defaultOutput, DEFAULT_OUTPUT_SETTINGS, DEFAULT_LOOK } = require('./lib/store');

const PORT = parseInt(process.env.PORT || '4400', 10);
const LAN = process.env.LAN === '1';
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');
const auth = require('./lib/auth');
const { AsRun } = require('./lib/asrun');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'louiseticker.json');
const store = new Store(DATA_FILE);
const asrun = new AsRun(path.join(path.dirname(DATA_FILE), path.basename(DATA_FILE, '.json') + '-asrun.jsonl'));
const sessions = new auth.Sessions(() => store.state, () => store.save());
const S = () => store.state;

const FEED_COLORS = ['#e4572e', '#29a3d6', '#f2b134', '#6bbf59', '#b86bd6', '#ef6f9a', '#3ec7b0', '#8f9bff', '#d98c4a', '#9ccf3a'];
const fetching = new Set();

// ---------------------------------------------------------------- helpers

const rid = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n);
const now = () => Date.now();

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'output';
}

// "Le Monde.fr - Actualités et Infos…" -> "Le Monde.fr"
function shortLabel(title) {
  return String(title || '').split(/\s[-|–—:»]\s/)[0].trim().slice(0, 30);
}

function keywordRegex(k) {
  const esc = k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[\\p{L}\\p{N}]*');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
}
function matchesAny(text, keywords) {
  return (keywords || []).some((k) => k && k.trim() && keywordRegex(k).test(text));
}

const feedById = (id) => S().feeds.find((f) => f.id === id);
const outputById = (id) => S().outputs.find((o) => o.id === id);
// Category a story gets when nobody picks one: the feed's own category, plus guessing when it's switched on.
const autoCategory = (item, feed) => S().settings.autoCategorize === false
  ? (feed && categoryById(feed.category) ? feed.category : null)
  : categorize(item, feed, S().categories);
const categoryById = (id) => (id && S().categories.find((c) => c.id === id)) || null;
const sourceName = (entry) => {
  const f = entry.feedId && feedById(entry.feedId);
  return (f && (f.shortName || f.title)) || entry.source || '';
};

// ---------------------------------------------------------------- live updates (SSE)

const clients = new Set();
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function outputChanged(o) {
  store.save();
  broadcast('output', { id: o.id });
}

// ---------------------------------------------------------------- feeds

function publicFeed(f) {
  return { ...f, fetching: fetching.has(f.id), itemCount: (S().items[f.id] || []).length };
}

async function refreshFeed(feed) {
  if (fetching.has(feed.id)) return;
  fetching.add(feed.id);
  broadcast('feed', { id: feed.id, fetching: true });
  try {
    const r = await fetchFeed(feed.url);
    const t = now();
    const existing = S().items[feed.id] || [];
    const byId = new Map(existing.map((i) => [i.id, i]));
    const fresh = [];
    const merged = r.items.map((it) => {
      const old = byId.get(it.id);
      if (!old) fresh.push(it);
      return { ...it, firstSeen: old ? old.firstSeen : t };
    });
    const freshIds = new Set(merged.map((i) => i.id));
    for (const old of existing) if (!freshIds.has(old.id)) merged.push(old);
    merged.sort((a, b) => (Date.parse(b.date || '') || b.firstSeen) - (Date.parse(a.date || '') || a.firstSeen));
    S().items[feed.id] = merged.slice(0, S().settings.maxItemsPerFeed || 150);

    if (!feed.customTitle && r.title) feed.title = r.title;
    if (!feed.shortName) feed.shortName = shortLabel(feed.title);
    feed.siteLink = r.siteLink || feed.siteLink || null;
    feed.lastFetched = t;
    feed.lastError = null;
    feed.lastNewCount = existing.length ? fresh.length : 0;
    if (existing.length) applyAutoRules(feed, fresh.map((i) => ({ ...i, firstSeen: t })));
  } catch (e) {
    feed.lastFetched = now();
    feed.lastError = e.name === 'TimeoutError' ? 'Timed out' : e.message;
  } finally {
    fetching.delete(feed.id);
    store.save();
    broadcast('feed', { id: feed.id, fetching: false });
  }
}

function makeEntry(o, feed, item, extra = {}) {
  const t = now();
  const h = Number(o.settings.expiryHours) || 0;
  return {
    id: rid(10),
    itemId: item.id || null,
    feedId: feed ? feed.id : null,
    source: feed ? feed.shortName || feed.title : extra.source || '',
    title: item.title,
    originalTitle: item.title,
    link: item.link || null,
    description: item.description || '',
    date: item.date || null,
    image: item.image || null,
    addedAt: t,
    expiresAt: h > 0 ? t + h * 3600000 : null,
    breaking: false,
    auto: false,
    categories: item.categories || [], // the story's own RSS tags, kept for re-categorising
    category: autoCategory(item, feed),
    ...extra,
  };
}

// Keyword rules: new items matching an output's include keywords get added automatically.
function applyAutoRules(feed, freshItems) {
  const t = now();
  for (const o of S().outputs) {
    const inc = o.rules.include || [];
    if (!inc.length) continue;
    if (o.rules.includeFeeds.length && !o.rules.includeFeeds.includes(feed.id)) continue;
    let changed = false;
    for (const it of freshItems) {
      if (it.date && t - Date.parse(it.date) > 12 * 3600000) continue;
      if (o.entries.some((e) => e.itemId === it.id) || o.dismissed.includes(it.id)) continue;
      const text = `${it.title} ${it.description}`;
      if (matchesAny(text, inc) && !matchesAny(text, o.rules.block)) {
        const e = makeEntry(o, feed, it, { auto: true, addedBy: 'keyword rule' });
        o.entries.push(e);
        audit('keyword rule', 'entry.add', `Auto-added ${o.takeMode ? 'to preview' : 'on air'}: ${quote(e.title)}`, { output: o.id, title: e.title });
        changed = true;
      }
    }
    if (changed) outputChanged(o);
  }
}

// ---------------------------------------------------------------- outputs

// ---------------------------------------------------------------- preview / program

// With TAKE mode on, o.entries is the preview being edited and o.program is what's on air.
const clone = (v) => JSON.parse(JSON.stringify(v));
const onAir = (o) => (o.takeMode ? o.program : o.entries);

// What a ticker shows right now: on-air entries inside their schedule, sorted and capped,
// with live-data entries expanded into their current lines. view = 'preview' shows the preview instead.
function liveEntries(o, view = 'program') {
  const t = now();
  const s = o.settings;
  const tz = s.clockTimezone || '';
  let list = (view === 'preview' ? o.entries : onAir(o)).filter((e) => schedule.isOnAir(e, t, tz));
  if (s.newestFirst) list = [...list].sort((a, b) => (Date.parse(b.date || '') || b.addedAt) - (Date.parse(a.date || '') || a.addedAt));
  if (s.breakingFirst) list = [...list.filter((e) => e.breaking), ...list.filter((e) => !e.breaking)];
  if (s.maxItems > 0) list = list.slice(0, s.maxItems);
  return list.flatMap((e) => {
    if (!e.data) return [e];
    const lines = (dataCache.get(dataKey(e.data)) || {}).lines || [];
    return lines.map((line, i) => ({ ...e, id: lines.length > 1 ? `${e.id}-${i}` : e.id, title: line, originalTitle: line }));
  });
}

// ---------------------------------------------------------------- live data (weather)

// Cached text per data config (keyed by the config itself, so a config edited in preview
// doesn't change what's on air until TAKE, while both keep refreshing).
const dataCache = new Map(); // key → { lines, updatedAt, error }
const dataKey = (d) => JSON.stringify(d);
const DATA_EVERY = 10 * 60000;
const dataFetching = new Set();

async function refreshData(d, force = false) {
  const key = dataKey(d);
  const c = dataCache.get(key);
  if (dataFetching.has(key) || (!force && c && now() - c.updatedAt < DATA_EVERY)) return c;
  dataFetching.add(key);
  try {
    if (d.type !== 'weather') throw new Error('Unknown data type');
    const results = await weather.fetchWeather(d.locations, { units: d.units, apiKey: openMeteoKey() });
    const lines = weather.formatWeather(d, results);
    const changed = !c || JSON.stringify(c.lines) !== JSON.stringify(lines);
    dataCache.set(key, { lines, updatedAt: now(), error: null });
    if (changed) for (const o of S().outputs) if ([...o.entries, ...(o.program || [])].some((e) => e.data && dataKey(e.data) === key)) broadcast('output', { id: o.id });
  } catch (e) {
    // keep the last good text on air; retry in about a minute
    dataCache.set(key, { lines: (c && c.lines) || [], updatedAt: now() - DATA_EVERY + 60000, error: e.name === 'TimeoutError' ? 'Timed out' : e.message });
  } finally {
    dataFetching.delete(key);
  }
  return dataCache.get(key);
}

function refreshAllData() {
  const seen = new Set();
  for (const o of S().outputs) {
    for (const e of [...o.entries, ...(o.program || [])]) {
      if (!e.data) continue;
      const k = dataKey(e.data);
      if (!seen.has(k)) { seen.add(k); refreshData(e.data); }
    }
  }
}

const openMeteoKey = () => process.env.OPENMETEO_API_KEY || S().settings.openMeteoKey || '';

const SOURCE_STYLES = ['none', 'prefix', 'suffix', 'badge'];
const CATEGORY_STYLES = ['none', 'badge', 'text', 'label'];

const LOOK_CHOICES = { mode: ['crawl', 'flip'], transition: ['slide', 'push', 'fade', 'none'], position: ['bottom', 'top'] };
const LOOK_LIMITS = { speed: [10, 1000], flipSeconds: [1, 120], margin: [0, 400], radius: [0, 200], fontSize: [8, 200], fontWeight: [100, 900], height: [0, 600], bgOpacity: [0, 100], maxLines: [1, 4], breakingEvery: [0, 20] };
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Merge user-supplied look values over the current ones, ignoring anything invalid.
function sanitizeLook(input, current) {
  const look = { ...DEFAULT_LOOK, ...(current || {}) };
  for (const [k, def] of Object.entries(DEFAULT_LOOK)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof def === 'boolean') look[k] = !!v;
    else if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = LOOK_LIMITS[k] || [0, 1e6];
      look[k] = Math.min(hi, Math.max(lo, n));
    } else if (LOOK_CHOICES[k]) {
      if (LOOK_CHOICES[k].includes(v)) look[k] = v;
    } else if (/^(bg|fg|accent|labelBg|labelFg|clockBg|clockFg|badgeColor)$/.test(k)) {
      if (COLOR_RE.test(v) || (k === 'badgeColor' && v === '')) look[k] = v;
    } else {
      look[k] = String(v ?? '').slice(0, 500);
    }
  }
  return look;
}

// Headline alone: truncated (so the source is never cut off) and cased.
function formatTitle(e, o) {
  const s = o.settings;
  let t = (e.title || '').replace(/\s+/g, ' ').trim();
  if (s.maxLength > 0 && t.length > s.maxLength) t = t.slice(0, Math.max(1, s.maxLength - 1)).trimEnd() + '…';
  return s.uppercase ? t.toUpperCase() : t;
}

// Full text line. "badge" is drawn as a coloured tag by the ticker page; text outputs fall back to a prefix.
function formatHeadline(e, o, withLabel = true) {
  const s = o.settings;
  let t = formatTitle(e, o);
  let src = sourceName(e);
  if (s.uppercase) src = src.toUpperCase();
  if (src && (s.sourceStyle === 'prefix' || s.sourceStyle === 'badge')) t = `${src}: ${t}`;
  if (src && s.sourceStyle === 'suffix') t = `${t} (${src})`;
  const cat = s.categoryStyle !== 'none' && categoryById(e.category);
  if (cat) t = `${s.uppercase ? cat.name.toUpperCase() : cat.name} | ${t}`;
  if (withLabel && e.breaking && s.breakingLabel) t = `${s.uppercase ? s.breakingLabel.toUpperCase() : s.breakingLabel}: ${t}`;
  return t;
}

function baseUrl(req) {
  return `http://${req.headers.host || `localhost:${PORT}`}`;
}

function renderRss(o, req) {
  const s = o.settings;
  const base = baseUrl(req);
  const self = `${base}/out/${o.id}.rss`;
  const items = liveEntries(o).map((e) => {
    const f = e.feedId && feedById(e.feedId);
    const desc = s.includeDescription ? e.description : '';
    return `    <item>
      <title>${escapeXml(formatHeadline(e, o))}</title>
      ${e.link ? `<link>${escapeXml(e.link)}</link>` : ''}
      <guid isPermaLink="false">louiseticker-${escapeXml(e.id)}</guid>
      <pubDate>${new Date(e.date || e.addedAt).toUTCString()}</pubDate>
      ${desc ? `<description>${escapeXml(desc)}</description>` : ''}
      ${e.breaking ? '<category>Breaking</category>' : ''}
      ${categoryById(e.category) ? `<category>${escapeXml(categoryById(e.category).name)}</category>` : ''}
      ${sourceName(e) ? `<source url="${escapeXml(f ? f.url : self)}">${escapeXml(sourceName(e))}</source>` : ''}
    </item>`.replace(/\n\s*\n/g, '\n');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(s.title)}</title>
    <link>${escapeXml(base)}</link>
    <description>${escapeXml(s.description)}</description>
    <language>en</language>
    <generator>LouiseTicker</generator>
    <ttl>1</ttl>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>
${items.join('\n')}
  </channel>
</rss>
`;
}

function renderJson(o, view) {
  return {
    view: view === 'preview' ? 'preview' : 'program',
    id: o.id,
    title: o.settings.title,
    separator: o.settings.separator,
    breakingLabel: o.settings.breakingLabel,
    uppercase: !!o.settings.uppercase,
    sourceStyle: o.settings.sourceStyle,
    categoryStyle: o.settings.categoryStyle,
    look: o.look,
    clock: {
      show: o.settings.showClock,
      format: o.settings.clockFormat,
      timezone: o.settings.clockTimezone || null,
      label: o.settings.clockLabel,
      seconds: o.settings.clockSeconds,
    },
    updated: new Date().toISOString(),
    items: liveEntries(o, view).map((e) => ({
      id: e.id,
      title: formatTitle(e, o),
      headline: formatHeadline(e, o, false),
      text: formatHeadline(e, o, true),
      source: sourceName(e),
      sourceColor: (e.feedId && feedById(e.feedId) || {}).color || null,
      category: categoryById(e.category) ? { id: e.category, name: categoryById(e.category).name, color: categoryById(e.category).color } : null,
      breaking: !!e.breaking,
      link: e.link,
      date: e.date,
      description: o.settings.includeDescription ? e.description : undefined,
    })),
  };
}

function renderTxt(o) {
  return liveEntries(o).map((e) => formatHeadline(e, o)).join(o.settings.separator || '  •  ');
}

// ---------------------------------------------------------------- OPML

function exportOpml() {
  const body = S().feeds.map((f) => `    <outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.url)}"${f.siteLink ? ` htmlUrl="${escapeXml(f.siteLink)}"` : ''}/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>LouiseTicker subscriptions</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>
  <body>
${body}
  </body>
</opml>
`;
}

function addFeedRecord(url, title) {
  const exists = S().feeds.find((f) => f.url === url);
  if (exists) return exists;
  const feed = {
    id: rid(8),
    url,
    title: title || url,
    customTitle: false,
    shortName: '',
    color: FEED_COLORS[S().feeds.length % FEED_COLORS.length],
    enabled: true,
    refreshMinutes: 0, // 0 = use global default
    addedAt: now(),
    lastFetched: null,
    lastError: null,
  };
  S().feeds.push(feed);
  return feed;
}

// ---------------------------------------------------------------- HTTP plumbing

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(data);
}
const ok = (res, body = { ok: true }) => send(res, 200, body);
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const t = await readBody(req);
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/ticker') pathname = '/ticker.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

// ---------------------------------------------------------------- routes

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// Who may call what. Everything under /api needs a logged-in user unless listed as public;
// admin-only routes are listed here too. (PATCH /api/outputs/:id is checked field by field.)
const PUBLIC = [
  ['GET', /^\/out\//], ['GET', /^\/(feed\.rss|rss|output\.rss)$/],      // what the ticker system reads
  ['GET', /^\/api\/events$/],                                            // live updates for ticker pages (ids only)
  ['POST', /^\/api\/login$/], ['GET', /^\/api\/me$/],
];
const ADMIN = [
  ['PATCH', /^\/api\/settings$/],
  ['POST', /^\/api\/outputs$/], ['DELETE', /^\/api\/outputs\/[\w-]+$/],
  ['*', /^\/api\/users/],
  ['GET', /^\/api\/asrun\.csv$/],
];
const matches = (list, method, p) => list.some(([m, re]) => (m === '*' || m === method) && re.test(p));
function accessFor(method, p) {
  if (matches(PUBLIC, method, p)) return 'public';
  if (matches(ADMIN, method, p)) return 'admin';
  return p.startsWith('/api/') ? 'user' : 'public'; // static files (control panel, ticker page) are public
}

// ---------------------------------------------------------------- as-run log

// Record who did what. `who` is a request (logged-in user) or a name such as 'system'.
function audit(who, action, summary, extra = {}) {
  const u = who && who.user;
  asrun.add({ user: u ? u.username : typeof who === 'string' ? who : 'system', role: u ? u.role : 'system', action, summary, ...extra });
}
// How an entry is named in the log: its headline, or the current weather text.
const entryLabel = (e) => (e.data ? ((dataCache.get(dataKey(e.data)) || {}).lines || []).join(' / ') || e.title : e.title);
const timingText = (e) => schedule.describe(e);
const quote = (t) => `“${String(t || '').slice(0, 120)}”`;

route('GET', /^\/api\/state$/, (req, res) => ok(res, {
  // the Open-Meteo key never leaves the server; the browser only learns whether one is set
  settings: { ...S().settings, openMeteoKey: undefined, openMeteoKeySet: !!openMeteoKey(), openMeteoKeyFromEnv: !!process.env.OPENMETEO_API_KEY },
  data: Object.fromEntries(dataCache),
  feeds: S().feeds.map(publicFeed),
  outputs: S().outputs.map(({ dismissed, ...o }) => o),
  categories: S().categories,
  defaults: DEFAULT_OUTPUT_SETTINGS,
  lookDefaults: DEFAULT_LOOK,
  server: { port: PORT, lan: HOST !== '127.0.0.1', lanUrls: HOST !== '127.0.0.1' ? lanUrls() : [], canEdit: true },
}));

route('GET', /^\/api\/items$/, (req, res) => ok(res, S().items));
route('GET', /^\/api\/feeds\/([\w]+)\/items$/, (req, res, [id]) => ok(res, S().items[id] || []));

route('PATCH', /^\/api\/settings$/, async (req, res) => {
  const b = await readJson(req);
  if (b.refreshMinutes != null) S().settings.refreshMinutes = Math.max(1, Number(b.refreshMinutes) || 10);
  if (typeof b.autoCategorize === 'boolean') S().settings.autoCategorize = b.autoCategorize;
  if (typeof b.openMeteoKey === 'string') { S().settings.openMeteoKey = b.openMeteoKey.trim(); dataCache.clear(); refreshAllData(); }
  if (b.maxItemsPerFeed != null) S().settings.maxItemsPerFeed = Math.min(1000, Math.max(10, Number(b.maxItemsPerFeed) || 150));
  audit(req, 'settings', `Changed settings: ${Object.keys(b).map((k) => (k === 'openMeteoKey' ? (b[k] ? 'Open-Meteo key set' : 'Open-Meteo key removed') : `${k} = ${b[k]}`)).join(', ')}`);
  store.save();
  broadcast('state');
  ok(res, S().settings);
});

// Subscribe: fetches first so bad URLs are rejected and HTML pages get auto-discovered.
route('POST', /^\/api\/feeds$/, async (req, res) => {
  const b = await readJson(req);
  let url = String(b.url || '').trim();
  if (!url) return fail(res, 400, 'URL required');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let parsed;
  try { parsed = await fetchFeed(url); } catch (e) { return fail(res, 400, `Could not load feed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`); }
  if (S().feeds.find((f) => f.url === parsed.url || f.url === url)) return fail(res, 409, 'Already subscribed to this feed');
  const feed = addFeedRecord(parsed.url, b.title || parsed.title);
  if (b.title) feed.customTitle = true;
  feed.shortName = b.shortName ? String(b.shortName).trim() : shortLabel(feed.title);
  const t = now();
  S().items[feed.id] = parsed.items.map((i) => ({ ...i, firstSeen: t })).slice(0, S().settings.maxItemsPerFeed);
  feed.siteLink = parsed.siteLink;
  feed.lastFetched = t;
  audit(req, 'feed.add', `Subscribed to ${quote(feed.title)}`, { details: feed.url });
  store.save();
  broadcast('state');
  ok(res, publicFeed(feed));
});

route('PATCH', /^\/api\/feeds\/(\w+)$/, async (req, res, [id]) => {
  const f = feedById(id);
  if (!f) return fail(res, 404, 'No such feed');
  const b = await readJson(req);
  if (typeof b.title === 'string' && b.title.trim() && b.title.trim() !== f.title) { f.title = b.title.trim(); f.customTitle = true; }
  if (typeof b.shortName === 'string') f.shortName = b.shortName.trim();
  if (typeof b.color === 'string') f.color = b.color;
  if (typeof b.category === 'string') f.category = categoryById(b.category) ? b.category : '';
  if (typeof b.enabled === 'boolean') f.enabled = b.enabled;
  if (b.refreshMinutes != null) f.refreshMinutes = Math.max(0, Number(b.refreshMinutes) || 0);
  if (typeof b.url === 'string' && b.url.trim() && b.url.trim() !== f.url) { f.url = b.url.trim(); f.lastFetched = null; }
  audit(req, 'feed.edit', `Edited feed ${quote(f.title)}`, { details: Object.keys(b).join(', ') });
  store.save();
  broadcast('state');
  ok(res, publicFeed(f));
});

route('DELETE', /^\/api\/feeds\/(\w+)$/, (req, res, [id]) => {
  const gone = feedById(id);
  if (gone) audit(req, 'feed.delete', `Unsubscribed from ${quote(gone.title)}`, { details: gone.url });
  S().feeds = S().feeds.filter((f) => f.id !== id);
  delete S().items[id];
  for (const o of S().outputs) o.rules.includeFeeds = o.rules.includeFeeds.filter((x) => x !== id);
  store.save();
  broadcast('state');
  ok(res);
});

route('PUT', /^\/api\/feeds\/order$/, async (req, res) => {
  const { ids = [] } = await readJson(req);
  const pos = new Map(ids.map((id, i) => [id, i]));
  S().feeds.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  store.save();
  broadcast('state');
  ok(res);
});

route('POST', /^\/api\/feeds\/(\w+)\/refresh$/, async (req, res, [id]) => {
  const f = feedById(id);
  if (!f) return fail(res, 404, 'No such feed');
  await refreshFeed(f);
  ok(res, publicFeed(f));
});

route('POST', /^\/api\/refresh$/, async (req, res) => {
  await Promise.all(S().feeds.filter((f) => f.enabled).map(refreshFeed));
  ok(res);
});

route('GET', /^\/api\/opml$/, (req, res) => send(res, 200, exportOpml(), 'text/x-opml; charset=utf-8', { 'Content-Disposition': 'attachment; filename="louiseticker.opml"' }));

route('POST', /^\/api\/opml$/, async (req, res) => {
  const text = await readBody(req);
  const urls = [];
  for (const m of text.matchAll(/<outline\b[^>]*>/gi)) {
    const u = m[0].match(/xmlUrl\s*=\s*["']([^"']+)["']/i);
    const t = m[0].match(/(?:title|text)\s*=\s*["']([^"']*)["']/i);
    if (u) urls.push({ url: u[1].replace(/&amp;/g, '&'), title: t ? t[1].replace(/&amp;/g, '&') : null });
  }
  let added = 0;
  for (const { url, title } of urls) {
    if (S().feeds.find((f) => f.url === url)) continue;
    addFeedRecord(url, title);
    added++;
  }
  audit(req, 'feed.import', `Imported OPML: ${added} new of ${urls.length} feeds`);
  store.save();
  broadcast('state');
  ok(res, { found: urls.length, added });
  scheduler(); // fetch the new ones right away
});

// ---------------------------------------------------------------- accounts

route('POST', /^\/api\/login$/, async (req, res) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (auth.tooManyFailures(ip)) return fail(res, 429, 'Too many failed attempts — wait a few minutes');
  const { username, password } = await readJson(req);
  const name = String(username || '').trim().toLowerCase();
  const u = S().users.find((x) => x.username === name);
  if (!u || u.disabled || !auth.checkPassword(u, password)) {
    auth.noteFailure(ip);
    asrun.add({ user: name.slice(0, 32) || '?', role: '—', action: 'login.failed', summary: `Failed login from ${ip}` });
    return fail(res, 401, 'Wrong username or password');
  }
  u.lastLogin = now();
  const token = sessions.create(u);
  req.user = u;
  audit(req, 'login', `Logged in from ${ip}`);
  send(res, 200, { user: auth.publicUser(u) }, 'application/json; charset=utf-8', { 'Set-Cookie': auth.sessionCookie(token) });
});

route('POST', /^\/api\/logout$/, (req, res) => {
  audit(req, 'logout', 'Logged out');
  sessions.destroy(req);
  send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': auth.clearCookie() });
});

route('GET', /^\/api\/me$/, (req, res) => ok(res, { user: req.user ? auth.publicUser(req.user) : null }));

route('POST', /^\/api\/me\/password$/, async (req, res) => {
  const { current, next } = await readJson(req);
  if (!auth.checkPassword(req.user, current)) return fail(res, 400, 'Your current password is wrong');
  if (!auth.validPassword(next)) return fail(res, 400, 'The new password needs at least 6 characters');
  Object.assign(req.user, auth.hashPassword(next));
  req.user.defaultPassword = false;
  sessions.destroyForUser(req.user.id, req); // log out other devices
  store.save();
  audit(req, 'user.password', 'Changed own password');
  ok(res);
});

const findUser = (id) => S().users.find((u) => u.id === id);
const activeAdmins = () => S().users.filter((u) => u.role === 'admin' && !u.disabled);

route('GET', /^\/api\/users$/, (req, res) => ok(res, S().users.map(auth.publicUser)));

route('POST', /^\/api\/users$/, async (req, res) => {
  const b = await readJson(req);
  const username = String(b.username || '').trim().toLowerCase();
  if (!auth.validUsername(username)) return fail(res, 400, 'Username: 2–32 characters (letters, numbers, . _ -)');
  if (S().users.some((u) => u.username === username)) return fail(res, 409, 'That username is already taken');
  if (!auth.validPassword(b.password)) return fail(res, 400, 'The password needs at least 6 characters');
  const u = auth.makeUser({ username, name: b.name, role: b.role, password: b.password });
  S().users.push(u);
  store.save();
  audit(req, 'user.create', `Created ${u.role} account “${u.username}”`);
  ok(res, auth.publicUser(u));
});

route('PATCH', /^\/api\/users\/(\w+)$/, async (req, res, [id]) => {
  const u = findUser(id);
  if (!u) return fail(res, 404, 'No such account');
  const b = await readJson(req);
  const losesAdmin = u.role === 'admin' && !u.disabled && ((b.role && b.role !== 'admin') || b.disabled === true);
  if (losesAdmin && activeAdmins().length <= 1) return fail(res, 400, 'At least one active admin account is needed');
  if (b.disabled === true && u.id === req.user.id) return fail(res, 400, 'You can’t disable your own account');
  if (b.password && !auth.validPassword(b.password)) return fail(res, 400, 'The password needs at least 6 characters');
  const changes = [];
  if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== u.name) { u.name = b.name.trim(); changes.push(`name → ${u.name}`); }
  if (auth.ROLES.includes(b.role) && b.role !== u.role) { u.role = b.role; changes.push(`role → ${u.role}`); }
  if (typeof b.disabled === 'boolean' && b.disabled !== !!u.disabled) {
    u.disabled = b.disabled;
    changes.push(u.disabled ? 'disabled' : 'enabled');
    if (u.disabled) sessions.destroyForUser(u.id);
  }
  if (b.password) {
    Object.assign(u, auth.hashPassword(b.password));
    u.defaultPassword = false;
    sessions.destroyForUser(u.id, u.id === req.user.id ? req : null);
    changes.push('password reset');
  }
  store.save();
  audit(req, 'user.edit', `Account “${u.username}”: ${changes.join(', ') || 'no change'}`);
  ok(res, auth.publicUser(u));
});

route('DELETE', /^\/api\/users\/(\w+)$/, (req, res, [id]) => {
  const u = findUser(id);
  if (!u) return fail(res, 404, 'No such account');
  if (u.id === req.user.id) return fail(res, 400, 'You can’t delete your own account');
  if (u.role === 'admin' && !u.disabled && activeAdmins().length <= 1) return fail(res, 400, 'At least one active admin account is needed');
  S().users = S().users.filter((x) => x.id !== id);
  sessions.destroyForUser(id);
  store.save();
  audit(req, 'user.delete', `Deleted account “${u.username}”`);
  ok(res);
});

// As-run log: everyone can read it; exporting is for admins.
const asrunQuery = (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const num = (k) => (q.get(k) ? Number(q.get(k)) : undefined);
  return { from: num('from'), to: num('to'), user: q.get('user') || undefined, action: q.get('action') || undefined, output: q.get('output') || undefined, q: q.get('q') || undefined, limit: Math.min(5000, num('limit') || 500) };
};
route('GET', /^\/api\/asrun$/, (req, res) => ok(res, asrun.query(asrunQuery(req))));
route('GET', /^\/api\/asrun\.csv$/, (req, res) => {
  const rows = asrun.query({ ...asrunQuery(req), limit: 100000 });
  send(res, 200, '﻿' + asrun.toCsv(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="louiseticker-asrun-${new Date().toISOString().slice(0, 10)}.csv"` });
});

// Categories: replace the whole list (order = matching priority).
route('PUT', /^\/api\/categories$/, async (req, res) => {
  const { categories } = await readJson(req);
  if (!Array.isArray(categories)) return fail(res, 400, 'categories must be a list');
  const seen = new Set();
  const clean = [];
  for (const c of categories) {
    const name = String(c.name || '').trim().slice(0, 30);
    if (!name) continue;
    let id = String(c.id || '') || slugify(name);
    while (seen.has(id)) id = `${slugify(name)}-${rid(3).toLowerCase()}`;
    seen.add(id);
    const match = (Array.isArray(c.match) ? c.match : String(c.match || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 100);
    clean.push({ id, name, color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#8d95a5', match });
  }
  S().categories = clean;
  audit(req, 'categories', `Saved ${clean.length} categories: ${clean.map((c) => c.name).join(', ')}`);
  for (const f of S().feeds) if (f.category && !seen.has(f.category)) f.category = '';
  store.save();
  broadcast('state');
  for (const o of S().outputs) broadcast('output', { id: o.id });
  ok(res, clean);
});

// Re-run automatic categorisation on an output's items (keeps categories picked by hand).
route('POST', /^\/api\/outputs\/([\w-]+)\/recategorize$/, (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  let changed = 0;
  for (const e of o.entries) {
    if (e.categoryManual || e.custom) continue;
    const item = (S().items[e.feedId] || []).find((i) => i.id === e.itemId) || { link: e.link, categories: e.categories || [] };
    const c = autoCategory(item, feedById(e.feedId));
    if (c !== e.category) { e.category = c; changed++; }
  }
  if (changed) audit(req, 'entry.category', `Re-applied automatic categories (${changed} changed)`, { output: o.id });
  outputChanged(o);
  ok(res, { changed });
});

// Outputs
route('POST', /^\/api\/outputs$/, async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name || 'New output').trim();
  let id = slugify(name);
  while (outputById(id)) id = `${slugify(name)}-${rid(3).toLowerCase()}`;
  const o = defaultOutput(id, name);
  S().outputs.push(o);
  audit(req, 'output.create', `Created output ${quote(name)}`, { output: id });
  store.save();
  broadcast('state');
  ok(res, o);
});

route('PATCH', /^\/api\/outputs\/([\w-]+)$/, async (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const b = await readJson(req);
  // journalists may only change the keyword rules; everything else is admin
  if (req.user.role !== 'admin' && (b.name || b.settings || b.look || 'takeMode' in b)) return fail(res, 403, 'Only an admin can change output settings and the ticker look');
  const tz = b.settings && b.settings.clockTimezone;
  if (tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: String(tz) }); } catch { return fail(res, 400, `Unknown time zone "${tz}"`); }
  }
  if (typeof b.name === 'string' && b.name.trim()) o.name = b.name.trim();
  if (typeof b.takeMode === 'boolean' && b.takeMode !== o.takeMode) {
    // switching TAKE on starts from what is currently on air, so nothing jumps
    o.takeMode = b.takeMode;
    if (o.takeMode) { o.program = clone(o.entries); o.programAt = now(); }
  }
  if (b.settings) {
    for (const k of Object.keys(DEFAULT_OUTPUT_SETTINGS)) {
      if (!(k in b.settings)) continue;
      const def = DEFAULT_OUTPUT_SETTINGS[k];
      o.settings[k] = typeof def === 'number' ? Math.max(0, Number(b.settings[k]) || 0) : typeof def === 'boolean' ? !!b.settings[k] : String(b.settings[k]);
    }
    if (!SOURCE_STYLES.includes(o.settings.sourceStyle)) o.settings.sourceStyle = 'none';
    if (!CATEGORY_STYLES.includes(o.settings.categoryStyle)) o.settings.categoryStyle = 'badge';
    if (!['12h', '24h'].includes(o.settings.clockFormat)) o.settings.clockFormat = '24h';
  }
  if (b.look) o.look = sanitizeLook(b.look, o.look);
  if (b.rules) {
    const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
    if ('include' in b.rules) o.rules.include = list(b.rules.include);
    if ('block' in b.rules) o.rules.block = list(b.rules.block);
    if ('includeFeeds' in b.rules) o.rules.includeFeeds = list(b.rules.includeFeeds);
  }
  const what = [b.name && 'name', b.settings && 'settings', b.look && 'ticker look', 'takeMode' in b && (b.takeMode ? 'TAKE mode on' : 'direct mode on'), b.rules && 'keyword rules'].filter(Boolean);
  audit(req, b.look ? 'output.design' : b.rules && what.length === 1 ? 'output.rules' : 'output.settings', `Changed ${what.join(', ')}`, {
    output: o.id, details: b.rules ? `auto-add: ${o.rules.include.join(', ') || '—'} · block: ${o.rules.block.join(', ') || '—'}` : undefined,
  });
  outputChanged(o);
  broadcast('state');
  ok(res, o);
});

route('DELETE', /^\/api\/outputs\/([\w-]+)$/, (req, res, [id]) => {
  if (S().outputs.length <= 1) return fail(res, 400, 'At least one output is required');
  if (outputById(id)) audit(req, 'output.delete', `Deleted output ${quote(outputById(id).name)}`, { output: id });
  S().outputs = S().outputs.filter((o) => o.id !== id);
  store.save();
  broadcast('state');
  ok(res);
});

route('POST', /^\/api\/outputs\/([\w-]+)\/entries$/, async (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const b = await readJson(req);
  const added = [];
  const by = req.user.username;
  const requests = Array.isArray(b.items) ? b.items : [b];
  for (const r of requests) {
    if (r.feedId && r.itemId) {
      const feed = feedById(r.feedId);
      const item = (S().items[r.feedId] || []).find((i) => i.id === r.itemId);
      if (!feed || !item) continue;
      if (o.entries.some((e) => e.itemId === item.id)) continue;
      o.dismissed = o.dismissed.filter((x) => x !== item.id);
      // a category picked while adding ("" = none) overrides the automatic one
      const picked = 'category' in r ? { category: categoryById(r.category) ? r.category : null, categoryManual: true } : {};
      const e = makeEntry(o, feed, item, { breaking: !!r.breaking, addedBy: by, ...picked });
      r.top ? o.entries.unshift(e) : o.entries.push(e);
      added.push(e);
    } else if (r.data) {
      // live-data line (weather): its text comes from the data cache
      const cfg = weather.cleanWeatherConfig(r.data);
      if (!cfg.locations.length) return fail(res, 400, 'Add at least one place');
      const e = makeEntry(o, null, { title: cfg.title || (cfg.lang === 'fr' ? 'Météo' : 'Weather') }, { custom: true, data: cfg, addedBy: by, breaking: !!r.breaking, category: categoryById(r.category) ? r.category : categoryById('weather') ? 'weather' : null });
      applyTiming(e, r);
      r.top ? o.entries.unshift(e) : o.entries.push(e);
      added.push(e);
      await refreshData(cfg, true);
    } else if (r.title && String(r.title).trim()) {
      const e = makeEntry(o, null, { title: String(r.title).trim(), link: r.link || null }, { source: r.source || '', custom: true, addedBy: by, breaking: !!r.breaking, category: categoryById(r.category) ? r.category : null });
      if (r.expiresInMinutes) e.expiresAt = now() + Number(r.expiresInMinutes) * 60000;
      applyTiming(e, r);
      r.top ? o.entries.unshift(e) : o.entries.push(e);
      added.push(e);
    }
  }
  for (const e of added) {
    audit(req, 'entry.add', `${o.takeMode ? 'Added to preview' : 'Added on air'}: ${quote(entryLabel(e))}`, {
      output: o.id, title: entryLabel(e), details: [e.breaking && 'breaking', categoryById(e.category) && `category ${categoryById(e.category).name}`, timingText(e)].filter(Boolean).join(' · ') || undefined,
    });
  }
  outputChanged(o);
  ok(res, added);
});

route('PATCH', /^\/api\/outputs\/([\w-]+)\/entries\/(\w+)$/, async (req, res, [id, eid]) => {
  const o = outputById(id);
  const e = o && o.entries.find((x) => x.id === eid);
  if (!e) return fail(res, 404, 'No such entry');
  const b = await readJson(req);
  const before = { title: e.title, breaking: !!e.breaking, hold: !!e.hold, category: e.category || null, timing: timingText(e), data: JSON.stringify(e.data || null) };
  if (typeof b.title === 'string' && b.title.trim()) e.title = b.title.trim();
  if (b.resetTitle) e.title = e.originalTitle;
  if (typeof b.breaking === 'boolean') e.breaking = b.breaking;
  if (typeof b.hold === 'boolean') e.hold = b.hold;
  if ('category' in b) { e.category = categoryById(b.category) ? b.category : null; e.categoryManual = true; }
  if (typeof b.source === 'string' && e.custom) e.source = b.source;
  applyTiming(e, b);
  if (b.data && e.data) {
    const cfg = weather.cleanWeatherConfig(b.data);
    if (!cfg.locations.length) return fail(res, 400, 'Add at least one place');
    e.data = cfg;
    await refreshData(cfg, true);
  }
  const changes = [];
  if (e.title !== before.title) changes.push(`headline ${quote(before.title)} → ${quote(e.title)}`);
  if (!!e.breaking !== before.breaking) changes.push(e.breaking ? 'breaking ON' : 'breaking off');
  if (!!e.hold !== before.hold) changes.push(e.hold ? 'held' : 'unheld');
  if ((e.category || null) !== before.category) changes.push(`category → ${categoryById(e.category) ? categoryById(e.category).name : 'none'}`);
  if (timingText(e) !== before.timing) changes.push(`timing → ${timingText(e) || 'none'}`);
  if (JSON.stringify(e.data || null) !== before.data) changes.push('weather settings');
  e.editedBy = req.user.username;
  if (changes.length) audit(req, 'entry.edit', `${quote(entryLabel(e))}: ${changes.join(', ')}`, { output: o.id, title: entryLabel(e) });
  outputChanged(o);
  ok(res, e);
});

// Timing fields shared by create and edit: one-off start/end and a daily window.
function applyTiming(e, b) {
  if ('startsAt' in b) e.startsAt = Number(b.startsAt) > 0 ? Number(b.startsAt) : null;
  if ('expiresAt' in b) e.expiresAt = Number(b.expiresAt) > 0 ? Number(b.expiresAt) : null;
  if ('repeat' in b) e.repeat = schedule.cleanRepeat(b.repeat);
}

// Put the preview on air / throw away preview changes.
route('POST', /^\/api\/outputs\/([\w-]+)\/take$/, (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const was = new Map(o.program.map((e) => [e.id, e]));
  const added = o.entries.filter((e) => !was.has(e.id));
  const removed = o.program.filter((p) => !o.entries.some((e) => e.id === p.id));
  o.program = clone(o.entries);
  o.programAt = now();
  audit(req, 'take', `TAKE: ${o.program.length} item${o.program.length === 1 ? '' : 's'} on air (+${added.length} / −${removed.length})`, {
    output: o.id,
    details: [
      added.length && `ON: ${added.map((e) => quote(entryLabel(e))).join(' ')}`,
      removed.length && `OFF: ${removed.map((e) => quote(entryLabel(e))).join(' ')}`,
      `NOW ON AIR: ${o.program.map((e) => quote(entryLabel(e))).join(' ')}`,
    ].filter(Boolean).join(' | '),
  });
  outputChanged(o);
  ok(res, { programAt: o.programAt });
});
route('POST', /^\/api\/outputs\/([\w-]+)\/revert$/, (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  o.entries = clone(o.program);
  audit(req, 'revert', 'Reverted preview to what is on air', { output: o.id });
  outputChanged(o);
  ok(res);
});

// Weather: place search and a live preview of the text, for the Live data dialog.
route('GET', /^\/api\/weather\/geocode$/, async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  if (!(q.get('q') || '').trim()) return ok(res, []);
  try { ok(res, await weather.geocode(q.get('q').trim(), q.get('lang') === 'en' ? 'en' : 'fr', openMeteoKey())); }
  catch (e) { fail(res, 502, e.message); }
});
route('POST', /^\/api\/weather\/preview$/, async (req, res) => {
  const cfg = weather.cleanWeatherConfig((await readJson(req)).data || {});
  if (!cfg.locations.length) return ok(res, { lines: [] });
  const c = await refreshData(cfg);
  ok(res, { lines: c.lines, error: c.error, updatedAt: c.updatedAt });
});

route('DELETE', /^\/api\/outputs\/([\w-]+)\/entries\/(\w+)$/, (req, res, [id, eid]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const e = o.entries.find((x) => x.id === eid);
  if (e) audit(req, 'entry.remove', `${o.takeMode ? 'Removed from preview' : 'Removed from air'}: ${quote(entryLabel(e))}`, { output: o.id, title: entryLabel(e) });
  if (e && e.itemId) o.dismissed = [...o.dismissed.slice(-1999), e.itemId];
  o.entries = o.entries.filter((x) => x.id !== eid);
  outputChanged(o);
  ok(res);
});

route('POST', /^\/api\/outputs\/([\w-]+)\/clear$/, (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  for (const e of o.entries) if (e.itemId) o.dismissed.push(e.itemId);
  o.dismissed = o.dismissed.slice(-2000);
  audit(req, 'clear', `Cleared ${o.entries.length} items from the ${o.takeMode ? 'preview' : 'air'}`, { output: o.id });
  o.entries = [];
  outputChanged(o);
  ok(res);
});

route('PUT', /^\/api\/outputs\/([\w-]+)\/order$/, async (req, res, [id]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const { ids = [] } = await readJson(req);
  const pos = new Map(ids.map((x, i) => [x, i]));
  o.entries.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  audit(req, 'entry.order', 'Changed the order', { output: o.id });
  outputChanged(o);
  ok(res);
});

// Copy entries into another output
route('POST', /^\/api\/outputs\/([\w-]+)\/copy-to\/([\w-]+)$/, async (req, res, [from, to]) => {
  const a = outputById(from), b = outputById(to);
  if (!a || !b) return fail(res, 404, 'No such output');
  const { ids } = await readJson(req);
  for (const e of a.entries) {
    if (ids && !ids.includes(e.id)) continue;
    if (e.itemId && b.entries.some((x) => x.itemId === e.itemId)) continue;
    b.entries.push({ ...e, id: rid(10), addedAt: now(), addedBy: req.user.username });
  }
  audit(req, 'output.copy', `Copied items from ${quote(a.name)} to ${quote(b.name)}`, { output: b.id });
  outputChanged(b);
  ok(res);
});

route('GET', /^\/api\/events$/, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Public output endpoints (for the ticker system)
route('GET', /^\/out\/([\w-]+)\.(rss|xml|json|txt)$/, (req, res, [id, ext]) => {
  const o = outputById(id);
  if (!o) return fail(res, 404, 'No such output');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (ext === 'json') return send(res, 200, renderJson(o, new URL(req.url, 'http://x').searchParams.get('view')), 'application/json; charset=utf-8', cors);
  if (ext === 'txt') return send(res, 200, renderTxt(o), 'text/plain; charset=utf-8', cors);
  send(res, 200, renderRss(o, req), 'application/rss+xml; charset=utf-8', cors);
});
route('GET', /^\/(feed\.rss|rss|output\.rss)$/, (req, res) => send(res, 200, renderRss(S().outputs[0], req), 'application/rss+xml; charset=utf-8', { 'Access-Control-Allow-Origin': '*' }));

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    const access = accessFor(req.method, pathname);
    req.user = sessions.userFor(req);
    if (access !== 'public' && !req.user) return fail(res, 401, 'Please log in');
    if (access === 'admin' && req.user.role !== 'admin') return fail(res, 403, 'Only an admin can do this');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m.slice(1));
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    fail(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.message);
  }
});

// ---------------------------------------------------------------- scheduler

function scheduler() {
  const t = now();
  const def = S().settings.refreshMinutes || 10;
  for (const f of S().feeds) {
    if (!f.enabled || fetching.has(f.id)) continue;
    const every = (f.refreshMinutes || def) * 60000;
    // retry failed feeds sooner (2 min) than the regular interval
    const due = !f.lastFetched || t - f.lastFetched >= (f.lastError ? Math.min(every, 120000) : every);
    if (due) refreshFeed(f);
  }
  for (const o of S().outputs) {
    // drop items whose end time has passed, from both preview and program
    const alive = (e) => !e.expiresAt || e.expiresAt > t;
    const before = o.entries.length + (o.program || []).length;
    for (const e of onAir(o)) if (!alive(e)) audit('system', 'air.end', `Ended (end time reached): ${quote(entryLabel(e))}`, { output: o.id, title: entryLabel(e) });
    o.entries = o.entries.filter(alive);
    if (o.program) o.program = o.program.filter(alive);
    if (o.entries.length + (o.program || []).length !== before) outputChanged(o);
    // tell tickers when a scheduled item starts or stops (no TAKE needed for that)
    const sig = liveEntries(o).map((e) => e.id).join() + '|' + liveEntries(o, 'preview').map((e) => e.id).join();
    if (airSig.has(o.id) && airSig.get(o.id) !== sig) broadcast('output', { id: o.id });
    airSig.set(o.id, sig);
    // as-run: scheduled items starting or stopping by themselves
    const tz = o.settings.clockTimezone || '';
    const nowOn = new Set(onAir(o).filter((e) => e.startsAt || e.repeat).filter((e) => schedule.isOnAir(e, t, tz)).map((e) => e.id));
    const prev = schedOn.get(o.id);
    if (prev) {
      for (const e of onAir(o)) {
        if (nowOn.has(e.id) && !prev.has(e.id)) audit('system', 'air.on', `Scheduled ON AIR: ${quote(entryLabel(e))}`, { output: o.id, title: entryLabel(e), details: timingText(e) });
        if (!nowOn.has(e.id) && prev.has(e.id) && (e.startsAt || e.repeat)) audit('system', 'air.off', `Scheduled OFF AIR: ${quote(entryLabel(e))}`, { output: o.id, title: entryLabel(e), details: timingText(e) });
      }
    }
    schedOn.set(o.id, nowOn);
  }
  refreshAllData();
  sessions.prune();
}
const airSig = new Map(); // output id → ids on air at the last tick
const schedOn = new Map(); // output id → scheduled entries that were on air at the last tick

server.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  console.log(`\n  LouiseTicker is running`);
  console.log(`  Control panel : ${local}`);
  console.log(`  Output RSS    : ${local}/out/${S().outputs[0].id}.rss`);
  console.log(`  Ticker page   : ${local}/ticker?out=${S().outputs[0].id}`);
  if (HOST !== '127.0.0.1') for (const u of lanUrls()) console.log(`  On network    : ${u}`);
  const defaults = S().users.filter((u) => u.defaultPassword && !u.disabled).map((u) => u.username);
  if (defaults.length) console.log(`\n  ⚠ Default password still in use for: ${defaults.join(', ')} (password: "password") — change it after logging in.`);
  if (store.seededUsers) store.save();
  console.log('');
  scheduler();
  setInterval(scheduler, 20000);
});

function shutdown() { try { store.flush(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { parseFeed };
