'use strict';
// JSON-file persistence with debounced atomic writes.

const fs = require('fs');
const path = require('path');
const { defaultUsers } = require('./auth');

const DEFAULT_OUTPUT_SETTINGS = {
  title: 'LouiseTicker',
  description: 'Compiled headlines for the news ticker',
  maxItems: 0,            // 0 = unlimited
  maxLength: 0,           // truncate headlines (chars), 0 = off
  uppercase: false,
  sourceStyle: 'badge',   // none | prefix ("BBC: …") | suffix ("… (BBC)") | badge (coloured tag on the ticker page)
  categoryStyle: 'badge', // none | badge (coloured tag) | text (coloured word) | label (category replaces the label block, one-at-a-time mode)
  breakingLabel: 'BREAKING',
  breakingFirst: true,
  expiryHours: 0,         // auto-remove entries after N hours, 0 = never
  separator: '  •  ',     // used by the .txt output and the ticker page
  includeDescription: false,
  newestFirst: false,     // false = manual order
  showClock: true,        // clock on the ticker page
  clockFormat: '24h',     // 24h | 12h
  clockTimezone: '',      // IANA zone, e.g. "Europe/Paris"; '' = the ticker computer's local time
  clockLabel: '',         // optional text before the time, e.g. "PARIS"
  clockSeconds: false,
};

// Ticker page appearance & layout (edited in the Ticker designer).
const DEFAULT_LOOK = {
  mode: 'crawl',          // crawl (continuous scroll) | flip (one headline at a time)
  speed: 110,             // crawl speed, px per second
  flipSeconds: 6,         // flip: time each headline stays up
  transition: 'slide',    // flip: slide | push | fade | none
  position: 'bottom',     // bottom | top
  margin: 0,              // gap between the bar and the screen edges (px)
  radius: 0,              // corner rounding (px)
  fontFamily: '"Segoe UI", Arial, sans-serif',
  fontSize: 34,
  fontWeight: 600,
  height: 0,              // bar height in px, 0 = automatic from font size (and number of lines)
  multiline: false,       // one-at-a-time mode: let long headlines wrap
  maxLines: 2,            // multiline: most lines a headline may use
  grow: false,            // multiline + automatic height: bar grows per story instead of always fitting maxLines
  breakingEvery: 2,       // one at a time: breaking headlines come back after every N other headlines (0 = in turn)
  bg: '#0b0d12',
  bgOpacity: 100,         // 0 = fully transparent bar
  fg: '#ffffff',
  accent: '#e5383b',      // separators, breaking tags
  showLabel: true,
  labelText: 'News',
  labelBg: '#e5383b',
  labelFg: '#ffffff',
  logoUrl: '',            // optional image at the left of the bar
  clockBg: '#1d2028',
  clockFg: '#ffffff',
  badgeColor: '',         // source badges: '' = each feed's colour
  breakingPulse: true,
  shadow: true,
};

function defaultOutput(id, name) {
  return {
    id,
    name,
    settings: { ...DEFAULT_OUTPUT_SETTINGS, title: name === 'Main' ? 'LouiseTicker' : `LouiseTicker – ${name}` },
    look: { ...DEFAULT_LOOK },
    rules: { include: [], includeFeeds: [], block: [] },
    takeMode: true,         // edits go to the preview (entries) until TAKE copies them to program
    program: [],
    programAt: null,
    entries: [],
    dismissed: [],
  };
}

// Ticker categories. "match" words are looked for in each story's RSS <category> tags and URL path.
// Order matters: the first category that matches wins.
const DEFAULT_CATEGORIES = [
  { id: 'weather', name: 'Weather', color: '#29a3d6', match: ['weather', 'météo', 'meteo', 'climate', 'storm'] },
  { id: 'sport', name: 'Sport', color: '#1e8f4e', match: ['sport', 'sports', 'football', 'soccer', 'rugby', 'tennis', 'cricket', 'golf', 'formula 1', 'f1', 'cycling', 'olympics', 'nba', 'nfl'] },
  { id: 'business', name: 'Business', color: '#f2b134', match: ['business', 'economy', 'économie', 'economie', 'markets', 'finance', 'money'] },
  { id: 'politics', name: 'Politics', color: '#b86bd6', match: ['politics', 'politique', 'election', 'elections', 'élections', 'parliament'] },
  { id: 'world', name: 'World', color: '#e4572e', match: ['world', 'international', 'international news', 'europe', 'africa', 'asia', 'americas', 'middle east'] },
  { id: 'tech', name: 'Tech', color: '#3ec7b0', match: ['technology', 'tech', 'science', 'pixels', 'sciences'] },
  { id: 'culture', name: 'Culture', color: '#ef6f9a', match: ['culture', 'entertainment', 'arts', 'music', 'film', 'cinema', 'cinéma', 'books', 'tv'] },
  { id: 'health', name: 'Health', color: '#6bbf59', match: ['health', 'santé', 'sante', 'medicine'] },
];

function defaultState() {
  return {
    version: 1,
    settings: { refreshMinutes: 10, maxItemsPerFeed: 150, autoCategorize: true, openMeteoKey: '' }, // autoCategorize: guess categories from RSS tags & links; openMeteoKey: commercial Open-Meteo key (optional)
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, match: [...c.match] })),
    feeds: [],
    items: {},
    outputs: [defaultOutput('main', 'Main')],
    users: null,     // filled with the default admin + journalist accounts on first start
    sessions: {},    // session token hash → { userId, expires }
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.state = defaultState();
    try {
      if (fs.existsSync(file)) {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.state = { ...defaultState(), ...loaded };
        this.state.settings = { ...defaultState().settings, ...(loaded.settings || {}) };
        for (const f of this.state.feeds) if (f.category === undefined) f.category = '';
        for (const o of this.state.outputs) {
          const old = o.settings || {};
          o.settings = { ...DEFAULT_OUTPUT_SETTINGS, ...old };
          // migrate the old on/off "sourcePrefix" setting
          if (!old.sourceStyle) o.settings.sourceStyle = old.sourcePrefix ? 'prefix' : 'none';
          delete o.settings.sourcePrefix;
          o.look = { ...DEFAULT_LOOK, ...(o.look || {}) };
          o.rules = { include: [], includeFeeds: [], block: [], ...(o.rules || {}) };
          o.entries = o.entries || [];
          // TAKE mode arrived later: start with program = current list so nothing on air changes
          if (!Array.isArray(o.program)) { o.program = JSON.parse(JSON.stringify(o.entries)); o.programAt = Date.now(); }
          if (o.takeMode === undefined) o.takeMode = true;
          o.dismissed = o.dismissed || [];
        }
        if (!this.state.outputs.length) this.state.outputs.push(defaultOutput('main', 'Main'));
      }
    } catch (e) {
      console.error('Could not read data file, starting fresh:', e.message);
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    }
    // accounts arrived later: create admin/password and journalist/password once
    if (!Array.isArray(this.state.users) || !this.state.users.length) {
      this.state.users = defaultUsers();
      this.seededUsers = true;
    }
    this.state.sessions = this.state.sessions || {};
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, defaultOutput, DEFAULT_OUTPUT_SETTINGS, DEFAULT_LOOK };
