'use strict';
// As-run log: who did what, and what went to air when. One JSON object per line in data/asrun.jsonl.

const fs = require('fs');
const path = require('path');

class AsRun {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** rec: { user, role, action, summary, output?, title?, details? } */
  add(rec) {
    const line = JSON.stringify({ t: Date.now(), ...rec }) + '\n';
    fs.appendFile(this.file, line, (err) => { if (err) console.error('as-run log:', err.message); });
  }

  /** Newest first. Filters: from/to (ms), user, action (prefix), output, q (text), limit. */
  query({ from, to, user, action, output, q, limit = 500 } = {}) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    const lines = text.split('\n');
    const needle = q ? q.toLowerCase() : null;
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch { continue; }
      if (from && r.t < from) break; // file is in time order
      if (to && r.t > to) continue;
      if (user && r.user !== user) continue;
      if (action && !String(r.action).startsWith(action)) continue;
      if (output && r.output !== output) continue;
      if (needle && !`${r.summary} ${r.title || ''} ${r.details || ''}`.toLowerCase().includes(needle)) continue;
      out.push(r);
    }
    return out;
  }

  toCsv(rows) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['time', 'user', 'role', 'action', 'output', 'summary', 'title', 'details'];
    return [head.join(','), ...rows.map((r) => [new Date(r.t).toISOString(), r.user, r.role, r.action, r.output, r.summary, r.title, r.details].map(cell).join(','))].join('\r\n');
  }
}

module.exports = { AsRun };
