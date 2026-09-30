'use strict';
// JSON-file persistence with debounced atomic writes.

const fs = require('fs');
const path = require('path');

const DEFAULT_OUTPUT_SETTINGS = {
  title: 'LouiseTicker',
  description: 'Compiled headlines for the news ticker',
  maxItems: 0,            // 0 = unlimited
  maxLength: 0,           // truncate headlines (chars), 0 = off
  uppercase: false,
  sourceStyle: 'badge',   // none | prefix ("BBC: …") | suffix ("… (BBC)") | badge (coloured tag on the ticker page)
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

function defaultOutput(id, name) {
  return {
    id,
    name,
    settings: { ...DEFAULT_OUTPUT_SETTINGS, title: name === 'Main' ? 'LouiseTicker' : `LouiseTicker – ${name}` },
    rules: { include: [], includeFeeds: [], block: [] },
    entries: [],
    dismissed: [],
  };
}

function defaultState() {
  return {
    version: 1,
    settings: { refreshMinutes: 10, maxItemsPerFeed: 150 },
    feeds: [],
    items: {},
    outputs: [defaultOutput('main', 'Main')],
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
        for (const o of this.state.outputs) {
          const old = o.settings || {};
          o.settings = { ...DEFAULT_OUTPUT_SETTINGS, ...old };
          // migrate the old on/off "sourcePrefix" setting
          if (!old.sourceStyle) o.settings.sourceStyle = old.sourcePrefix ? 'prefix' : 'none';
          delete o.settings.sourcePrefix;
          o.rules = { include: [], includeFeeds: [], block: [], ...(o.rules || {}) };
          o.entries = o.entries || [];
          o.dismissed = o.dismissed || [];
        }
        if (!this.state.outputs.length) this.state.outputs.push(defaultOutput('main', 'Main'));
      }
    } catch (e) {
      console.error('Could not read data file, starting fresh:', e.message);
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    }
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

module.exports = { Store, defaultOutput, DEFAULT_OUTPUT_SETTINGS };
