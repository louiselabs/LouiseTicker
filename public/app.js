'use strict';
/* LouiseTicker control panel */

// ------------------------------------------------------------ prefs (per-browser conveniences)
const prefs = (() => {
  const KEY = 'louiseticker.prefs';
  let p = {};
  try { p = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  const d = { panes: [{ tab: 'all' }], focused: 0, closedTabs: [], lastSeen: {}, output: 'main', compact: false, showImages: true, askCategory: true };
  p = { ...d, ...p };
  p.save = () => { try { const { save, ...rest } = p; localStorage.setItem(KEY, JSON.stringify(rest)); } catch {} };
  return p;
})();

// ------------------------------------------------------------ state
const st = { feeds: [], outputs: [], settings: {}, server: {}, items: {} };
const paneEls = []; // DOM cache per pane
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const feedById = (id) => st.feeds.find((f) => f.id === id);
const categoryById = (id) => (id && (st.categories || []).find((c) => c.id === id)) || null;
const catChip = (c, attrs = '') => `<span class="tag cat" style="background:${esc(c.color)}" ${attrs}>${esc(c.name.toUpperCase())}</span>`;
const categoryOptions = (selected, none = 'No category') =>
  `<option value="">${none}</option>` + (st.categories || []).map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const currentOutput = () => st.outputs.find((o) => o.id === prefs.output) || st.outputs[0];

function timeAgo(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function timeLeft(t) {
  const m = Math.round((t - Date.now()) / 60000);
  if (m <= 0) return 'expiring';
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''} left`;
}

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
}

async function api(method, path, body, raw = false) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

// ------------------------------------------------------------ loading & live sync
async function loadState() {
  const s = await api('GET', '/api/state');
  Object.assign(st, s);
  for (const f of st.feeds) if (prefs.lastSeen[f.id] == null) prefs.lastSeen[f.id] = Date.now();
  if (!st.outputs.some((o) => o.id === prefs.output)) prefs.output = st.outputs[0].id;
}
async function loadItems(feedId) {
  if (feedId) st.items[feedId] = await api('GET', `/api/feeds/${feedId}/items`);
  else st.items = await api('GET', '/api/items');
}

let syncTimer = null;
const pendingFeeds = new Set();
let fullItems = false;
function scheduleSync(kind, data) {
  if (kind === 'feed' && data && data.fetching === false) pendingFeeds.add(data.id);
  if (kind === 'state') fullItems = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(safe(async () => {
    await loadState();
    if (fullItems) { fullItems = false; pendingFeeds.clear(); await loadItems(); }
    else for (const id of [...pendingFeeds]) { pendingFeeds.delete(id); await loadItems(id); }
    renderAll();
  }), 150);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#liveDot').classList.add('on');
  es.onerror = () => $('#liveDot').classList.remove('on');
  for (const ev of ['state', 'feed', 'output']) es.addEventListener(ev, (e) => scheduleSync(ev, JSON.parse(e.data || '{}')));
}

// ------------------------------------------------------------ rendering: panes & tabs
function renderAll() {
  renderPanes();
  renderOutput();
  prefs.save();
}

function tabList() {
  return ['all', ...st.feeds.filter((f) => !prefs.closedTabs.includes(f.id)).map((f) => f.id)];
}

function newCount(feedId) {
  const seen = prefs.lastSeen[feedId] || 0;
  return (st.items[feedId] || []).filter((i) => i.firstSeen > seen).length;
}

function renderPanes() {
  const host = $('#panes');
  // validate pane tabs
  for (const p of prefs.panes) if (p.tab !== 'all' && !feedById(p.tab)) p.tab = 'all';
  if (prefs.focused >= prefs.panes.length) prefs.focused = 0;
  if (paneEls.length !== prefs.panes.length) {
    host.innerHTML = '';
    paneEls.length = 0;
    prefs.panes.forEach((p, i) => {
      const root = document.createElement('div');
      root.className = 'pane';
      root.innerHTML = `<div class="tabbar"></div><div class="toolbar"></div><div class="feed-status"></div><div class="stories"></div>`;
      host.append(root);
      paneEls.push({ root, tabbar: $('.tabbar', root), toolbar: $('.toolbar', root), status: $('.feed-status', root), list: $('.stories', root), toolKey: null });
      wirePane(i);
    });
  }
  prefs.panes.forEach((_, i) => renderPane(i));
}

function renderPane(i) {
  const p = prefs.panes[i];
  const el = paneEls[i];
  el.root.classList.toggle('focused', prefs.panes.length > 1 && i === prefs.focused);
  el.root.classList.toggle('compact', !!prefs.compact);

  // tab bar
  el.tabbar.innerHTML = `<div class="tabs">${tabList().map((id) => {
    const active = id === p.tab;
    if (id === 'all') return `<div class="tab ${active ? 'active' : ''}" data-tab="all" draggable="true"><span class="name">★ All stories</span></div>`;
    const f = feedById(id);
    const n = active ? 0 : newCount(id);
    return `<div class="tab ${active ? 'active' : ''}" data-tab="${id}" draggable="true" title="${esc(f.title)}\n${esc(f.url)}">
      <span class="dot" style="background:${esc(f.color)}"></span>
      <span class="name">${esc(f.shortName || f.title)}</span>
      ${f.fetching ? '<span class="spin">⟳</span>' : ''}${f.lastError ? '<span class="err" title="' + esc(f.lastError) + '">⚠</span>' : ''}
      ${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}
      <span class="x" data-close="${id}" title="Close tab">✕</span></div>`;
  }).join('')}</div>
  <div class="tabbar-actions">
    <button class="icon-btn" data-act="add" title="Add feed">＋</button>
    ${prefs.closedTabs.length ? `<button class="icon-btn" data-act="hidden" title="Reopen closed tabs">▾</button>` : ''}
    <button class="icon-btn" data-act="split" title="Split: open another pane">◫</button>
    ${prefs.panes.length > 1 ? `<button class="icon-btn" data-act="closepane" title="Close this pane">✕</button>` : ''}
  </div>`;
  const activeTab = $('.tab.active', el.tabbar);
  if (activeTab && el._lastTab !== p.tab) { activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); el._lastTab = p.tab; }

  // toolbar (rebuilt only when switching tab so the search box keeps focus)
  if (el.toolKey !== p.tab) {
    el.toolKey = p.tab;
    const isAll = p.tab === 'all';
    el.toolbar.innerHTML = `
      <input class="search" type="search" placeholder="Search ${isAll ? 'all stories' : 'this feed'}…  ( / )" value="${esc(p.q || '')}">
      <select data-f="since" title="Time window">
        ${[[0, 'Any time'], [1, 'Last hour'], [3, 'Last 3h'], [6, 'Last 6h'], [24, 'Last 24h']].map(([v, l]) => `<option value="${v}" ${+p.since === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="chip ${p.unsel ? 'on' : ''}" data-f="unsel" title="Hide stories already in the output">Unpicked only</span>
      ${isAll ? `<span class="chip ${p.dedupe !== false ? 'on' : ''}" data-f="dedupe" title="Hide near-identical headlines from different feeds">Hide duplicates</span>` : ''}
      <span class="chip ${prefs.compact ? 'on' : ''}" data-f="compact" title="Compact list">Compact</span>
      ${isAll ? '' : `<button class="icon-btn" data-act="refresh" title="Refresh this feed">⟳</button><button class="icon-btn" data-act="feedsettings" title="Feed settings">⚙</button>`}
      <button class="icon-btn" data-act="pickall" title="Add all visible (filtered) stories to the output">⇉</button>`;
  } else {
    $$('.chip[data-f="compact"]', el.toolbar).forEach((c) => c.classList.toggle('on', !!prefs.compact));
  }

  // status line
  if (p.tab === 'all') {
    const n = st.feeds.length;
    el.status.innerHTML = n ? `${n} feed${n === 1 ? '' : 's'} · click a story to add it to <b>${esc(currentOutput().name)}</b>, drag it to place it` : '';
  } else {
    const f = feedById(p.tab);
    const every = f.refreshMinutes || st.settings.refreshMinutes;
    el.status.innerHTML = `${f.enabled ? '' : '<b>Paused</b> · '}Updated ${f.lastFetched ? timeAgo(f.lastFetched) : 'never'} · every ${every} min${f.lastError ? ` · <span class="errtxt">⚠ ${esc(f.lastError)}</span>` : ''}${f.siteLink ? ` · <a href="${esc(f.siteLink)}" target="_blank" rel="noopener">site ↗</a>` : ''}`;
  }

  renderList(i);
}

function normTitle(t) { return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 70); }

function keywordRe(list) {
  const ks = (list || []).map((k) => k.trim()).filter(Boolean);
  if (!ks.length) return null;
  const parts = ks.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[\\p{L}\\p{N}]*'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(${parts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

function paneStories(p) {
  let list;
  if (p.tab === 'all') {
    list = [];
    for (const f of st.feeds) for (const it of st.items[f.id] || []) list.push({ ...it, feedId: f.id });
    list.sort((a, b) => (Date.parse(b.date || '') || b.firstSeen) - (Date.parse(a.date || '') || a.firstSeen));
    if (p.dedupe !== false) {
      const seen = new Set();
      list = list.filter((it) => { const k = normTitle(it.title); if (seen.has(k)) return false; seen.add(k); return true; });
    }
  } else {
    list = (st.items[p.tab] || []).map((it) => ({ ...it, feedId: p.tab }));
  }
  const terms = (p.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) list = list.filter((it) => { const t = `${it.title} ${it.description} ${(it.categories || []).join(' ')}`.toLowerCase(); return terms.every((w) => t.includes(w)); });
  if (+p.since) { const lim = Date.now() - p.since * 3600000; list = list.filter((it) => (Date.parse(it.date || '') || it.firstSeen) >= lim); }
  if (p.unsel) { const sel = selectedMap(); list = list.filter((it) => !sel.has(it.id)); }
  return list;
}

function selectedMap() {
  const m = new Map();
  for (const e of currentOutput().entries) if (e.itemId) m.set(e.itemId, e);
  return m;
}

function renderList(i) {
  const p = prefs.panes[i];
  const el = paneEls[i];
  if (!st.feeds.length) {
    el.list.innerHTML = `<div class="empty">No feeds yet.<br>Subscribe to RSS feeds and they'll appear here as tabs.<br><button class="btn primary" data-act="add">＋ Add your first feed</button></div>`;
    return;
  }
  // "NEW" markers: remember what was last seen when this tab was opened
  const seenKey = p.tab;
  if (el._seenFor !== seenKey) { el._seenFor = seenKey; el._seenBase = p.tab === 'all' ? (prefs.lastSeen.all || Date.now()) : (prefs.lastSeen[p.tab] || 0); }
  prefs.lastSeen[p.tab] = Date.now();

  const all = paneStories(p);
  const limit = p.limit || 150;
  const list = all.slice(0, limit);
  const sel = selectedMap();
  const o = currentOutput();
  const incRe = keywordRe(o.rules.include);
  const blkRe = keywordRe(o.rules.block);
  const showImg = prefs.showImages && !prefs.compact;

  if (!list.length) {
    el.list.innerHTML = `<div class="empty">${(st.items[p.tab] || []).length || p.tab === 'all' ? 'No stories match these filters.' : 'No stories loaded yet.'}</div>`;
    return;
  }
  const hl = (s) => { let x = esc(s); if (incRe) x = x.replace(incRe, '<mark>$1</mark>'); return x; };
  el.list.innerHTML = list.map((it) => {
    const f = feedById(it.feedId) || {};
    const picked = sel.has(it.id);
    const blocked = blkRe && (blkRe.lastIndex = 0, blkRe.test(`${it.title} ${it.description}`));
    if (blkRe) blkRe.lastIndex = 0;
    const isNew = it.firstSeen > el._seenBase;
    return `<article class="story ${picked ? 'selected' : ''} ${blocked ? 'blocked' : ''}" draggable="true" data-feed="${it.feedId}" data-item="${it.id}">
      <div class="stripe" style="background:${esc(f.color || '#555')}"></div>
      <div class="pick">✓</div>
      <div class="body">
        <div class="meta">${p.tab === 'all' ? `<span class="src" style="color:${esc(f.color)}">${esc(f.shortName || f.title)}</span>·` : ''}
          <time title="${esc(it.date || '')}">${timeAgo(it.date || it.firstSeen)}</time>
          ${isNew ? '<span class="new">NEW</span>' : ''}${picked ? `<span class="inout">● in ${esc(o.name)}${sel.get(it.id).breaking ? ' · BREAKING' : ''}</span>` : ''}
          ${it.author ? `<span>· ${esc(it.author)}</span>` : ''}
          ${(() => { const c = categoryById(suggestCategory(it, f)); return c ? catChip(c, `title="Ticker category${(it.categories || []).length ? ` · RSS tags: ${esc(it.categories.join(', '))}` : ''}"`) : ''; })()}</div>
        <h3>${hl(it.title)}</h3>
        ${it.description ? `<p>${hl(it.description)}</p>` : ''}
      </div>
      <div class="side">
        ${showImg && it.image ? `<img class="thumb" loading="lazy" src="${esc(it.image)}" alt="" onerror="this.remove()">` : ''}
        <div class="acts">
          <button class="icon-btn" data-act="breaking" title="Add as BREAKING (top of ticker)">⚡</button>
          ${it.link ? `<a class="icon-btn" href="${esc(it.link)}" target="_blank" rel="noopener" title="Open article" data-act="open">↗</a>` : ''}
        </div>
      </div>
    </article>`;
  }).join('') + (all.length > limit ? `<button class="btn more" data-act="more">Show more (${all.length - limit} hidden)</button>` : '');
}

function wirePane(i) {
  const el = paneEls[i];
  const pane = () => prefs.panes[i];
  el.root.addEventListener('mousedown', () => { if (prefs.focused !== i) { prefs.focused = i; prefs.panes.forEach((_, j) => paneEls[j].root.classList.toggle('focused', prefs.panes.length > 1 && j === i)); } });

  el.tabbar.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      const id = close.dataset.close;
      prefs.closedTabs.push(id);
      for (const p of prefs.panes) if (p.tab === id) p.tab = 'all';
      return renderAll();
    }
    const act = e.target.closest('[data-act]');
    if (act) return paneAction(i, act.dataset.act);
    const tab = e.target.closest('.tab');
    if (tab) { pane().tab = tab.dataset.tab; pane().limit = 0; renderPane(i); prefs.save(); }
  });
  el.tabbar.addEventListener('auxclick', (e) => { const t = e.target.closest('.tab'); if (e.button === 1 && t && t.dataset.tab !== 'all') { prefs.closedTabs.push(t.dataset.tab); renderAll(); } });

  // tab drag & drop (reorder, or drop onto a pane's story list to show it there)
  el.tabbar.addEventListener('dragstart', (e) => { const t = e.target.closest('.tab'); if (t) e.dataTransfer.setData('text/x-tab', t.dataset.tab); });
  el.tabbar.addEventListener('dragover', (e) => { const t = e.target.closest('.tab'); if (t && e.dataTransfer.types.includes('text/x-tab')) { e.preventDefault(); $$('.tab.dragover').forEach((x) => x.classList.remove('dragover')); t.classList.add('dragover'); } });
  el.tabbar.addEventListener('dragleave', (e) => { const t = e.target.closest('.tab'); if (t) t.classList.remove('dragover'); });
  el.tabbar.addEventListener('drop', safe(async (e) => {
    const t = e.target.closest('.tab');
    const src = e.dataTransfer.getData('text/x-tab');
    $$('.tab.dragover').forEach((x) => x.classList.remove('dragover'));
    if (!t || !src || src === 'all' || src === t.dataset.tab) return;
    e.preventDefault();
    const ids = st.feeds.map((f) => f.id).filter((x) => x !== src);
    const at = t.dataset.tab === 'all' ? 0 : ids.indexOf(t.dataset.tab);
    ids.splice(at, 0, src);
    st.feeds.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renderPanes();
    await api('PUT', '/api/feeds/order', { ids });
  }));
  el.list.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-tab')) e.preventDefault(); });
  el.list.addEventListener('drop', (e) => { const src = e.dataTransfer.getData('text/x-tab'); if (src) { e.preventDefault(); pane().tab = src; renderPane(i); prefs.save(); } });

  // toolbar
  el.toolbar.addEventListener('input', (e) => {
    if (e.target.classList.contains('search')) { pane().q = e.target.value; pane().limit = 0; renderList(i); prefs.save(); }
  });
  el.toolbar.addEventListener('change', (e) => { if (e.target.dataset.f === 'since') { pane().since = +e.target.value; renderList(i); prefs.save(); } });
  el.toolbar.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      const f = chip.dataset.f;
      if (f === 'compact') { prefs.compact = !prefs.compact; prefs.panes.forEach((_, j) => renderPane(j)); prefs.save(); return; }
      if (f === 'dedupe') pane().dedupe = pane().dedupe === false;
      if (f === 'unsel') pane().unsel = !pane().unsel;
      chip.classList.toggle('on');
      renderList(i);
      prefs.save();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) paneAction(i, act.dataset.act);
  });

  // stories
  el.list.addEventListener('click', safe(async (e) => {
    const act = e.target.closest('[data-act]');
    if (act && act.dataset.act === 'open') return;
    if (act && act.dataset.act === 'add') return openAddFeed();
    if (act && act.dataset.act === 'more') { pane().limit = (pane().limit || 150) + 150; return renderList(i); }
    const card = e.target.closest('.story');
    if (!card) return;
    const { feed, item } = card.dataset;
    const o = currentOutput();
    const existing = o.entries.find((x) => x.itemId === item);
    if (act && act.dataset.act === 'breaking') {
      if (existing) await api('PATCH', `/api/outputs/${o.id}/entries/${existing.id}`, { breaking: !existing.breaking });
      else {
        const cat = await askCategory(e, { feedId: feed, itemId: item, breaking: true });
        if (cat === undefined) return;
        await api('POST', `/api/outputs/${o.id}/entries`, { feedId: feed, itemId: item, breaking: true, top: true, ...cat });
      }
    } else if (existing) {
      await api('DELETE', `/api/outputs/${o.id}/entries/${existing.id}`);
    } else {
      const cat = await askCategory(e, { feedId: feed, itemId: item });
      if (cat === undefined) return;
      await api('POST', `/api/outputs/${o.id}/entries`, { feedId: feed, itemId: item, ...cat });
    }
    await loadState();
    renderAll();
  }));
  el.list.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.story');
    if (card) { e.dataTransfer.setData('text/x-story', JSON.stringify({ feedId: card.dataset.feed, itemId: card.dataset.item })); e.dataTransfer.effectAllowed = 'copy'; }
  });
}

const paneAction = safe(async (i, act) => {
  const p = prefs.panes[i];
  if (act === 'add') return openAddFeed();
  if (act === 'split') { prefs.panes.splice(i + 1, 0, { tab: 'all' }); if (prefs.panes.length > 4) { prefs.panes.pop(); toast('Up to 4 panes'); } return renderAll(); }
  if (act === 'closepane') { prefs.panes.splice(i, 1); prefs.focused = 0; return renderAll(); }
  if (act === 'hidden') return openHiddenTabs();
  if (act === 'refresh') { const f = feedById(p.tab); f.fetching = true; renderPane(i); await api('POST', `/api/feeds/${p.tab}/refresh`); await loadItems(p.tab); await loadState(); return renderAll(); }
  if (act === 'feedsettings') return openFeedSettings(p.tab);
  if (act === 'pickall') {
    const sel = selectedMap();
    const items = paneStories(p).slice(0, p.limit || 150).filter((it) => !sel.has(it.id)).map((it) => ({ feedId: it.feedId, itemId: it.id }));
    if (!items.length) return toast('Nothing new to add');
    if (items.length > 10 && !confirm(`Add ${items.length} stories to "${currentOutput().name}"?`)) return;
    const btn = paneEls[i].toolbar.querySelector('[data-act="pickall"]').getBoundingClientRect();
    const cat = await askCategory({ clientX: btn.left, clientY: btn.bottom }, { count: items.length });
    if (cat === undefined) return;
    await api('POST', `/api/outputs/${currentOutput().id}/entries`, { items: items.map((x) => ({ ...x, ...cat })) });
    await loadState();
    renderAll();
    toast(`Added ${items.length} stories`);
  }
});

// ------------------------------------------------------------ output panel
function renderOutput() {
  const o = currentOutput();
  $('#outputSelect').innerHTML = st.outputs.map((x) => `<option value="${x.id}" ${x.id === o.id ? 'selected' : ''}>${esc(x.name)} (${x.entries.length})</option>`).join('');
  const cs = $('#customCategory');
  if (document.activeElement !== cs) cs.innerHTML = categoryOptions(cs.value, 'Category…');
  const base = location.origin;
  const links = [['RSS', `/out/${o.id}.rss`], ['JSON', `/out/${o.id}.json`], ['TXT', `/out/${o.id}.txt`], ['Ticker ▶', `/ticker?out=${o.id}`]];
  $('#endpoints').innerHTML = links.map(([l, u]) => `<span class="endpoint"><a href="${u}" target="_blank" rel="noopener" title="${base}${u}">${l}</a><button data-copy="${base}${u}" title="Copy URL">⧉</button></span>`).join('')
    + (st.server.lanUrls && st.server.lanUrls.length ? `<span class="hint" title="Use this address from other machines">LAN: ${esc(st.server.lanUrls[0])}/out/${o.id}.rss</span>` : '');

  const now = Date.now();
  const live = o.entries.filter((e) => !e.hold && (!e.expiresAt || e.expiresAt > now));
  const brk = live.filter((e) => e.breaking).length;
  const capped = o.settings.maxItems > 0 && live.length > o.settings.maxItems;
  $('#opStats').innerHTML = `<span><b>${Math.min(live.length, o.settings.maxItems || Infinity)}</b> on air${brk ? ` · <span style="color:var(--accent-2)">${brk} breaking</span>` : ''}${capped ? ` · ${live.length - o.settings.maxItems} over limit` : ''}</span>
    <span>${o.rules.include.length ? `auto: ${esc(o.rules.include.slice(0, 3).join(', '))}${o.rules.include.length > 3 ? '…' : ''}` : ''}${o.settings.newestFirst ? ' · sorted newest' : ''}</span>`;

  const ol = $('#entries');
  if (!o.entries.length) {
    ol.innerHTML = `<li class="empty">Nothing selected yet.<br>Click stories in the feeds (or drag them here) to build the ticker.</li>`;
  } else {
    // show in on-air order when sorting options are active
    let list = o.entries;
    if (o.settings.newestFirst) list = [...list].sort((a, b) => (Date.parse(b.date || '') || b.addedAt) - (Date.parse(a.date || '') || a.addedAt));
    if (o.settings.breakingFirst) list = [...list.filter((e) => e.breaking), ...list.filter((e) => !e.breaking)];
    ol.innerHTML = list.map((e) => {
      const f = feedById(e.feedId);
      const src = f ? f.shortName || f.title : e.source || 'Custom';
      const edited = e.originalTitle && e.title !== e.originalTitle;
      return `<li class="entry ${e.breaking ? 'breaking' : ''} ${e.hold ? 'hold' : ''}" draggable="true" data-id="${e.id}">
        <div class="grip" title="Drag to reorder">⋮⋮</div>
        <div class="txt">
          <div class="hl" title="Double-click to edit">${esc(e.title)}</div>
          <div class="emeta">
            ${e.breaking ? '<span class="tag brk">BREAKING</span>' : ''}${e.hold ? '<span class="tag">HELD</span>' : ''}${e.auto ? '<span class="tag auto" title="Added by a keyword rule">AUTO</span>' : ''}${e.custom ? '<span class="tag">CUSTOM</span>' : ''}${edited ? '<span class="tag edit" title="Original: ' + esc(e.originalTitle) + '">EDITED</span>' : ''}
            ${categoryById(e.category) ? catChip(categoryById(e.category), 'data-act="category" title="Change category" role="button"') : '<span class="tag cat-none" data-act="category" title="Set a category" role="button">+ CATEGORY</span>'}
            <span style="color:${esc(f ? f.color : 'var(--muted)')}">${esc(src)}</span>
            <span>· added ${timeAgo(e.addedAt)}</span>
            ${e.expiresAt ? `<span>· ⏱ ${timeLeft(e.expiresAt)}</span>` : ''}
          </div>
        </div>
        <div class="eacts">
          <button class="icon-btn ${e.breaking ? 'on' : ''}" data-act="breaking" title="Toggle breaking">⚡</button>
          <button class="icon-btn" data-act="hold" title="${e.hold ? 'Put back on air' : 'Hold (keep but take off air)'}">${e.hold ? '▶' : '⏸'}</button>
          <button class="icon-btn" data-act="edit" title="Edit headline">✎</button>
          ${edited ? '<button class="icon-btn" data-act="reset" title="Restore original headline">↺</button>' : ''}
          <button class="icon-btn" data-act="expiry" title="Set expiry">⏱</button>
          ${e.link ? `<a class="icon-btn" href="${esc(e.link)}" target="_blank" rel="noopener" title="Open article">↗</a>` : ''}
          <button class="icon-btn" data-act="remove" title="Remove">✕</button>
        </div>
      </li>`;
    }).join('');
  }
  const src = `/ticker?out=${encodeURIComponent(o.id)}&embed=1`;
  const frame = $('#previewFrame');
  if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src; }
}

function wireOutput() {
  $('#outputSelect').addEventListener('change', (e) => { prefs.output = e.target.value; renderAll(); });
  $('#btnNewOutput').addEventListener('click', safe(async () => {
    const name = prompt('Name for the new output feed (e.g. "Sport", "Breaking only"):');
    if (!name || !name.trim()) return;
    const o = await api('POST', '/api/outputs', { name });
    await loadState();
    prefs.output = o.id;
    renderAll();
    toast(`Created output "${o.name}"`);
  }));
  $('#btnOutputSettings').addEventListener('click', () => openOutputSettings());
  $('#btnDesigner').addEventListener('click', () => openDesigner());
  $('#endpoints').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('URL copied'), () => prompt('Copy this URL:', b.dataset.copy));
  });
  $('#customForm').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const title = $('#customText').value.trim();
    if (!title) return;
    const breaking = $('#customBreaking').checked;
    await api('POST', `/api/outputs/${currentOutput().id}/entries`, { title, breaking, top: breaking, category: $('#customCategory').value });
    $('#customText').value = '';
    $('#customBreaking').checked = false;
    await loadState();
    renderAll();
  }));
  $('#btnClear').addEventListener('click', safe(async () => {
    const o = currentOutput();
    if (!o.entries.length || !confirm(`Remove all ${o.entries.length} items from "${o.name}"?`)) return;
    await api('POST', `/api/outputs/${o.id}/clear`);
    await loadState();
    renderAll();
  }));
  $('#btnCopyTo').addEventListener('click', () => openCopyTo());

  const ol = $('#entries');
  ol.addEventListener('click', safe(async (e) => {
    const act = e.target.closest('[data-act]');
    const li = e.target.closest('.entry');
    if (!act || !li) return;
    const o = currentOutput();
    const entry = o.entries.find((x) => x.id === li.dataset.id);
    const url = `/api/outputs/${o.id}/entries/${entry.id}`;
    switch (act.dataset.act) {
      case 'breaking': await api('PATCH', url, { breaking: !entry.breaking }); break;
      case 'hold': await api('PATCH', url, { hold: !entry.hold }); break;
      case 'reset': await api('PATCH', url, { resetTitle: true }); break;
      case 'remove': await api('DELETE', url); break;
      case 'expiry': return openExpiry(o, entry);
      case 'category': return openCategoryPicker(o, entry);
      case 'edit': return editHeadline(li, o, entry);
    }
    await loadState();
    renderAll();
  }));
  ol.addEventListener('dblclick', (e) => {
    const hl = e.target.closest('.hl');
    const li = e.target.closest('.entry');
    if (hl && li) { const o = currentOutput(); editHeadline(li, o, o.entries.find((x) => x.id === li.dataset.id)); }
  });

  // drag reorder + drop stories from the feeds
  let dragId = null;
  ol.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.entry');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.setData('text/x-entry', dragId);
    e.dataTransfer.effectAllowed = 'move';
  });
  ol.addEventListener('dragend', () => { dragId = null; $$('.entry.dragging, .entry.dropbefore').forEach((x) => x.classList.remove('dragging', 'dropbefore')); ol.classList.remove('dropzone'); });
  ol.addEventListener('dragover', (e) => {
    const types = e.dataTransfer.types;
    if (!types.includes('text/x-entry') && !types.includes('text/x-story')) return;
    e.preventDefault();
    ol.classList.add('dropzone');
    $$('.entry.dropbefore').forEach((x) => x.classList.remove('dropbefore'));
    const li = e.target.closest('.entry');
    if (li && li.dataset.id !== dragId) li.classList.add('dropbefore');
  });
  ol.addEventListener('dragleave', (e) => { if (!ol.contains(e.relatedTarget)) { ol.classList.remove('dropzone'); $$('.entry.dropbefore').forEach((x) => x.classList.remove('dropbefore')); } });
  ol.addEventListener('drop', safe(async (e) => {
    e.preventDefault();
    ol.classList.remove('dropzone');
    const o = currentOutput();
    const before = e.target.closest('.entry');
    const beforeId = before ? before.dataset.id : null;
    $$('.entry.dropbefore').forEach((x) => x.classList.remove('dropbefore'));
    let moving = e.dataTransfer.getData('text/x-entry');
    const story = e.dataTransfer.getData('text/x-story');
    if (story) {
      const s = JSON.parse(story);
      const existing = o.entries.find((x) => x.itemId === s.itemId);
      if (existing) moving = existing.id;
      else {
        const cat = await askCategory(e, s);
        if (cat === undefined) { renderAll(); return; }
        const [added] = await api('POST', `/api/outputs/${o.id}/entries`, { ...s, ...cat });
        if (!added) return;
        moving = added.id;
        await loadState();
      }
    }
    if (!moving || moving === beforeId) { renderAll(); return; }
    const ids = currentOutput().entries.map((x) => x.id).filter((x) => x !== moving);
    const at = beforeId ? ids.indexOf(beforeId) : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, moving);
    await api('PUT', `/api/outputs/${o.id}/order`, { ids });
    if (o.settings.newestFirst) toast('Note: this output is sorted newest-first, so manual order is ignored on air');
    await loadState();
    renderAll();
  }));
}

function editHeadline(li, o, entry) {
  const hl = $('.hl', li);
  if (hl.isContentEditable) return;
  hl.contentEditable = 'true';
  li.draggable = false;
  hl.focus();
  document.getSelection().selectAllChildren(hl);
  let done = false;
  const finish = safe(async (save) => {
    if (done) return;
    done = true;
    hl.contentEditable = 'false';
    li.draggable = true;
    const val = hl.textContent.replace(/\s+/g, ' ').trim();
    if (save && val && val !== entry.title) await api('PATCH', `/api/outputs/${o.id}/entries/${entry.id}`, { title: val });
    await loadState();
    renderAll();
  });
  hl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  hl.addEventListener('blur', () => finish(true), { once: true });
}

// ------------------------------------------------------------ category picker (when adding)
// The category a story would get on its own: its feed's category, plus guessing if switched on.
function suggestCategory(it, f) {
  if (st.settings.autoCategorize === false) return f && categoryById(f.category) ? f.category : null;
  return categorize(it, f, st.categories);
}

/**
 * Ask which category to file a story under, in a small pop-up next to the click.
 * Resolves with the fields to send: {category} (id or "" for none), {} to leave it to the
 * automatic category (picker switched off, or "keep suggestions" when adding many), or
 * undefined when cancelled. Keys: 1–9 pick, 0 = none, Enter = highlighted, Esc = cancel.
 */
function askCategory(ev, { feedId, itemId, count = 1, breaking = false } = {}) {
  if (!prefs.askCategory || !(st.categories || []).length) return Promise.resolve({});
  const f = feedById(feedId);
  const it = f && (st.items[feedId] || []).find((x) => x.id === itemId);
  const suggested = it ? suggestCategory(it, f) : null;
  const cats = st.categories;
  document.querySelector('.catpop')?.dispatchEvent(new Event('cancel'));

  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'catpop';
    pop.innerHTML = `<div class="catpop-head">${breaking ? '<span class="tag brk">BREAKING</span> ' : ''}${count > 1 ? `Add ${count} stories as…` : `Add to <b>${esc(currentOutput().name)}</b> as…`}</div>
      <div class="catpop-list">${cats.map((c, i) => `<button type="button" data-cat="${esc(c.id)}" class="${c.id === suggested ? 'sel' : ''}" style="--c:${esc(c.color)}">
          ${i < 9 ? `<kbd>${i + 1}</kbd>` : '<kbd></kbd>'}<i></i>${esc(c.name)}${c.id === suggested ? '<small>suggested</small>' : ''}</button>`).join('')}
        <button type="button" data-cat="" class="${!suggested && count === 1 ? 'sel' : ''}" style="--c:#5f6778"><kbd>0</kbd><i></i>No category</button>
        ${count > 1 ? '<button type="button" data-keep class="sel" style="--c:#3b6fd6"><kbd>↵</kbd><i></i>Each story’s own suggestion</button>' : ''}
      </div>
      <div class="catpop-foot">1–9 pick · 0 none · Enter ${count > 1 ? 'suggestions' : 'highlighted'} · Esc cancel</div>`;
    document.body.append(pop);
    // place next to the pointer, kept on screen
    const r = pop.getBoundingClientRect();
    const x = Math.min(Math.max(8, (ev.clientX ?? innerWidth / 2) + 8), innerWidth - r.width - 8);
    const y = Math.min(Math.max(8, (ev.clientY ?? innerHeight / 2) - 20), innerHeight - r.height - 8);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';

    const done = (val) => {
      pop.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onOutside, true);
      resolve(val);
    };
    const choose = (btn) => done(btn.hasAttribute('data-keep') ? {} : { category: btn.dataset.cat });
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(undefined); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(pop.querySelector('button.sel') || pop.querySelector('[data-cat=""]')); }
      else if (e.key === '0') choose(pop.querySelector('[data-cat=""]'));
      else if (/^[1-9]$/.test(e.key) && cats[+e.key - 1]) choose(pop.querySelectorAll('[data-cat]')[+e.key - 1]);
    };
    const onOutside = (e) => { if (!pop.contains(e.target)) done(undefined); };
    pop.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) choose(b); });
    pop.addEventListener('cancel', () => done(undefined));
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('mousedown', onOutside, true));
  });
}

// ------------------------------------------------------------ modals
function modal(html, mount, { wide = false } = {}) {
  const dlg = $('#modal');
  dlg.classList.toggle('wide', wide);
  $('#modalBody').innerHTML = html;
  if (!dlg.open) dlg.showModal();
  $$('[data-close-modal]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  if (mount) mount(dlg);
  const first = $('input:not([type=checkbox]):not([type=color]), textarea', dlg);
  if (first) first.focus();
}
const closeModal = () => $('#modal').close();
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
const head = (t) => `<div class="dlg-head"><h2>${t}</h2><button class="icon-btn" data-close-modal title="Close">✕</button></div>`;

const PRESETS = [
  ['BBC News – Top stories', 'https://feeds.bbci.co.uk/news/rss.xml', 'BBC'],
  ['BBC News – World', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC World'],
  ['BBC Sport', 'https://feeds.bbci.co.uk/sport/rss.xml', 'BBC Sport'],
  ['The Guardian – World', 'https://www.theguardian.com/world/rss', 'Guardian'],
  ['NPR News', 'https://feeds.npr.org/1001/rss.xml', 'NPR'],
  ['Al Jazeera English', 'https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
  ['Sky News', 'https://feeds.skynews.com/feeds/rss/home.xml', 'Sky'],
  ['The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'NYT'],
  ['France 24 (English)', 'https://www.france24.com/en/rss', 'France 24'],
  ['Le Monde – À la une', 'https://www.lemonde.fr/rss/une.xml', 'Le Monde'],
  ['franceinfo', 'https://www.francetvinfo.fr/titres.rss', 'franceinfo'],
  ['Hacker News', 'https://hnrss.org/frontpage', 'HN'],
];

function openAddFeed() {
  const have = new Set(st.feeds.map((f) => f.url));
  modal(`${head('Add a feed')}
    <form id="addForm"><div class="dlg-body">
      <label class="field"><span>Feed or website address</span>
        <input name="url" placeholder="https://example.com/rss.xml  — or just a news website, we'll find its feed" required></label>
      <div class="row2">
        <label class="field"><span>Name (optional)</span><input name="title" placeholder="Uses the feed's own title"></label>
        <label class="field"><span>Ticker label (optional)</span><input name="shortName" placeholder="e.g. BBC" maxlength="30"><small>Shown on tabs and as the source prefix.</small></label>
      </div>
      <div class="err-msg" id="addErr"></div>
      <div class="section-title">Quick add</div>
      <div class="presets">${PRESETS.map(([t, u, s]) => `<button type="button" class="preset ${have.has(u) ? 'added' : ''}" data-url="${esc(u)}" data-short="${esc(s)}" ${have.has(u) ? 'disabled' : ''}>${esc(t)}<small>${esc(u)}</small></button>`).join('')}</div>
      <div class="section-title">Import / export</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <label class="btn small">Import OPML… <input type="file" id="opmlFile" accept=".opml,.xml,text/xml" hidden></label>
        <a class="btn small" href="/api/opml" download>Export OPML</a>
        <span class="hint">Move subscriptions from/to other RSS readers.</span>
      </div>
    </div>
    <div class="dlg-foot"><span></span><div class="right"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn primary" id="addBtn">Subscribe</button></div></div></form>`,
  (dlg) => {
    const form = $('#addForm', dlg);
    const subscribe = safe(async (body) => {
      $('#addErr').textContent = '';
      $('#addBtn').disabled = true;
      $('#addBtn').textContent = 'Loading…';
      try {
        const f = await api('POST', '/api/feeds', body);
        await loadState(); await loadItems(f.id);
        prefs.lastSeen[f.id] = Date.now();
        prefs.closedTabs = prefs.closedTabs.filter((x) => x !== f.id);
        prefs.panes[prefs.focused].tab = f.id;
        closeModal();
        renderAll();
        toast(`Subscribed to ${f.title}`);
      } catch (e) {
        $('#addErr').textContent = e.message;
      } finally {
        const b = $('#addBtn'); if (b) { b.disabled = false; b.textContent = 'Subscribe'; }
      }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); subscribe(Object.fromEntries(new FormData(form))); });
    $$('.preset', dlg).forEach((b) => b.addEventListener('click', () => { if (!b.disabled) subscribe({ url: b.dataset.url, shortName: b.dataset.short }); }));
    $('#opmlFile', dlg).addEventListener('change', safe(async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const r = await api('POST', '/api/opml', await file.text(), true);
      closeModal();
      toast(`Imported ${r.added} of ${r.found} feeds — loading…`);
      await loadState(); renderAll();
    }));
  });
}

function openHiddenTabs() {
  const hidden = prefs.closedTabs.map(feedById).filter(Boolean);
  modal(`${head('Closed tabs')}<div class="dlg-body"><div class="feedlist">${hidden.map((f) => `
    <div class="feedrow"><span class="dot" style="background:${esc(f.color)}"></span><div>${esc(f.title)}<small>${esc(f.url)}</small></div>
    <button class="btn small" data-open="${f.id}">Reopen</button></div>`).join('') || '<div class="hint">No closed tabs.</div>'}</div></div>
    <div class="dlg-foot"><button class="btn" data-reopen-all>Reopen all</button><div class="right"><button class="btn" data-close-modal>Done</button></div></div>`,
  (dlg) => {
    dlg.querySelector('.dlg-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (!b) return;
      prefs.closedTabs = prefs.closedTabs.filter((x) => x !== b.dataset.open);
      prefs.panes[prefs.focused].tab = b.dataset.open;
      closeModal(); renderAll();
    });
    $('[data-reopen-all]', dlg).addEventListener('click', () => { prefs.closedTabs = []; closeModal(); renderAll(); });
  });
}

function openFeedSettings(id) {
  const f = feedById(id);
  if (!f) return;
  modal(`${head('Feed settings')}
    <form id="feedForm"><div class="dlg-body">
      <label class="field"><span>Name</span><input name="title" value="${esc(f.title)}"></label>
      <div class="row3">
        <label class="field"><span>Ticker label</span><input name="shortName" value="${esc(f.shortName || '')}" placeholder="${esc(f.title.slice(0, 20))}" maxlength="30"></label>
        <label class="field"><span>Refresh every (min)</span><input name="refreshMinutes" type="number" min="0" value="${f.refreshMinutes || ''}" placeholder="default (${st.settings.refreshMinutes})"></label>
        <label class="field"><span>Colour</span><input name="color" type="color" value="${esc(f.color)}" style="width:100%;height:36px;background:none;border:0"></label>
      </div>
      <label class="field"><span>Feed URL</span><input name="url" value="${esc(f.url)}"></label>
      <label class="field"><span>Ticker category for this feed's stories</span><select name="category">${categoryOptions(f.category, 'Automatic (from each story’s RSS tags and link)')}</select>
        <small>Pick one for single-topic feeds, e.g. “Sport” for a sport feed. <a href="#" id="editCats">Edit categories…</a></small></label>
      <label class="check"><input type="checkbox" name="enabled" ${f.enabled ? 'checked' : ''}> Auto-refresh this feed</label>
      <div class="hint">${f.itemCount} stories stored · last update ${f.lastFetched ? timeAgo(f.lastFetched) : 'never'}${f.lastError ? ` · <span style="color:var(--warn)">⚠ ${esc(f.lastError)}</span>` : ''}</div>
    </div>
    <div class="dlg-foot"><button type="button" class="btn danger" id="delFeed">Unsubscribe</button>
      <div class="right"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn primary">Save</button></div></div></form>`,
  (dlg) => {
    const form = $('#feedForm', dlg);
    $('#editCats', dlg).addEventListener('click', (e) => { e.preventDefault(); openCategories(); });
    form.addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      await api('PATCH', `/api/feeds/${id}`, { ...d, enabled: form.enabled.checked, refreshMinutes: d.refreshMinutes || 0 });
      closeModal(); await loadState(); renderAll();
    }));
    $('#delFeed', dlg).addEventListener('click', safe(async () => {
      if (!confirm(`Unsubscribe from "${f.title}"? Stories already in outputs are kept.`)) return;
      await api('DELETE', `/api/feeds/${id}`);
      closeModal(); await loadState(); delete st.items[id]; renderAll();
    }));
  });
}

function openSettings() {
  const s = st.settings;
  const rows = () => st.feeds.map((f) => `
    <div class="feedrow"><span class="dot" style="background:${esc(f.color)}"></span>
      <div>${esc(f.title)}${f.enabled ? '' : ' <span class="tag">PAUSED</span>'}<small>${f.lastError ? `<span class="errtxt">⚠ ${esc(f.lastError)}</span> · ` : ''}${f.itemCount} stories · updated ${f.lastFetched ? timeAgo(f.lastFetched) : 'never'} · ${esc(f.url)}</small></div>
      <div style="display:flex;gap:4px"><button class="btn small" data-show="${f.id}">Show</button><button class="btn small" data-edit="${f.id}">Edit</button></div></div>`).join('') || '<div class="hint">No feeds yet.</div>';
  modal(`${head('Feeds &amp; settings')}
    <form id="setForm"><div class="dlg-body">
      <div class="section-title">General</div>
      <div class="row2">
        <label class="field"><span>Default refresh interval (minutes)</span><input name="refreshMinutes" type="number" min="1" value="${s.refreshMinutes}"></label>
        <label class="field"><span>Stories kept per feed</span><input name="maxItemsPerFeed" type="number" min="10" max="1000" value="${s.maxItemsPerFeed}"></label>
      </div>
      <label class="check"><input type="checkbox" name="showImages" ${prefs.showImages ? 'checked' : ''}> Show thumbnails in story lists</label>
      <label class="check"><input type="checkbox" name="compact" ${prefs.compact ? 'checked' : ''}> Compact story lists</label>
      <div class="section-title">Subscriptions (${st.feeds.length})</div>
      <div class="feedlist" id="feedRows">${rows()}</div>
      <div style="display:flex;gap:8px;margin-top:10px"><button type="button" class="btn small" id="setAdd">＋ Add feed</button><a class="btn small" href="/api/opml" download>Export OPML</a></div>
      <div class="section-title">Ticker categories (${(st.categories || []).length})</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${(st.categories || []).map((c) => catChip(c)).join('')}
        <button type="button" class="btn small" id="setCats">Edit categories…</button></div>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="askCategory" ${prefs.askCategory ? 'checked' : ''}> Ask for a category each time I add a story <span class="hint">— pop-up with number keys 1–9</span></label>
      <label class="check"><input type="checkbox" name="autoCategorize" ${s.autoCategorize !== false ? 'checked' : ''}> Guess categories from RSS tags and links <span class="hint">— when off, only feed categories and your choices are used</span></label>
      <div class="section-title">Keyboard</div>
      <div class="hint"><span class="kbd">/</span> search · <span class="kbd">R</span> refresh all · <span class="kbd">A</span> add feed · <span class="kbd">1</span>–<span class="kbd">9</span> switch tab · <span class="kbd">[</span> <span class="kbd">]</span> previous / next tab · <span class="kbd">S</span> split pane</div>
      <div class="section-title">For the ticker system</div>
      <div class="hint">Each output has its own RSS, JSON and plain-text address (see the links above the output list), plus a full-screen <b>Ticker</b> page usable as a browser source in OBS / vMix / CasparCG. ${st.server.lan ? `Reachable on your network at ${st.server.lanUrls.map(esc).join(', ')}.` : 'Only reachable from this computer — start with <b>start-lan.bat</b> to share it on your network.'}</div>
    </div>
    <div class="dlg-foot"><span></span><div class="right"><button type="button" class="btn" data-close-modal>Close</button><button class="btn primary">Save</button></div></div></form>`,
  (dlg) => {
    const form = $('#setForm', dlg);
    form.addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      prefs.showImages = form.showImages.checked;
      prefs.compact = form.compact.checked;
      prefs.askCategory = form.askCategory.checked;
      await api('PATCH', '/api/settings', { refreshMinutes: form.refreshMinutes.value, maxItemsPerFeed: form.maxItemsPerFeed.value, autoCategorize: form.autoCategorize.checked });
      closeModal(); await loadState(); renderAll(); toast('Settings saved');
    }));
    $('#setAdd', dlg).addEventListener('click', openAddFeed);
    $('#setCats', dlg).addEventListener('click', () => openCategories());
    $('#feedRows', dlg).addEventListener('click', (e) => {
      const show = e.target.closest('[data-show]');
      const edit = e.target.closest('[data-edit]');
      if (show) { prefs.closedTabs = prefs.closedTabs.filter((x) => x !== show.dataset.show); prefs.panes[prefs.focused].tab = show.dataset.show; closeModal(); renderAll(); }
      if (edit) openFeedSettings(edit.dataset.edit);
    });
  });
}

let tzCache = null;
function timeZoneOptions(selected) {
  if (!tzCache) {
    const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : ['UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
    if (!zones.includes('UTC')) zones.unshift('UTC');
    const now = new Date();
    tzCache = zones.map((z) => {
      let off = '';
      try { off = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName').value; } catch {}
      return [z, `${z.replace(/_/g, ' ')}${off ? ` (${off})` : ''}`];
    });
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<option value="">Ticker computer's local time${local ? ` (here: ${esc(local)})` : ''}</option>`
    + tzCache.map(([z, l]) => `<option value="${esc(z)}" ${z === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

function openOutputSettings() {
  const o = currentOutput();
  const s = o.settings;
  const r = o.rules;
  const cb = (name, label, hint = '') => `<label class="check"><input type="checkbox" name="${name}" ${s[name] ? 'checked' : ''}> ${label}${hint ? ` <span class="hint">— ${hint}</span>` : ''}</label>`;
  modal(`${head(`Output: ${esc(o.name)}`)}
    <form id="outForm"><div class="dlg-body">
      <div class="section-title">Feed</div>
      <div class="row2">
        <label class="field"><span>Output name</span><input name="name" value="${esc(o.name)}"></label>
        <label class="field"><span>RSS channel title</span><input name="title" value="${esc(s.title)}"></label>
      </div>
      <label class="field"><span>RSS description</span><input name="description" value="${esc(s.description)}"></label>
      <div class="section-title">Headline formatting</div>
      <div class="row3">
        <label class="field"><span>Max items on air</span><input name="maxItems" type="number" min="0" value="${s.maxItems}"><small>0 = no limit</small></label>
        <label class="field"><span>Max headline length</span><input name="maxLength" type="number" min="0" value="${s.maxLength}"><small>characters, 0 = off</small></label>
        <label class="field"><span>Auto-expire after (h)</span><input name="expiryHours" type="number" min="0" step="0.25" value="${s.expiryHours}"><small>for newly added items</small></label>
      </div>
      <div class="row2">
        <label class="field"><span>Breaking label</span><input name="breakingLabel" value="${esc(s.breakingLabel)}"><small>Prefixed to breaking headlines</small></label>
        <label class="field"><span>Separator (text output &amp; ticker page)</span><input name="separator" value="${esc(s.separator)}"></label>
      </div>
      ${cb('uppercase', 'ALL CAPS headlines')}
      ${cb('breakingFirst', 'Breaking items always go first')}
      ${cb('newestFirst', 'Sort by publication time (newest first) instead of manual order')}
      ${cb('includeDescription', 'Include story summaries in the RSS/JSON output')}
      <p class="hint">Ticker appearance, layout, display mode, source &amp; category labels and the clock are in the 🎨 Ticker designer.</p>
      <div class="section-title">Automatic rules</div>
      <label class="field"><span>Auto-add keywords</span><textarea name="include" placeholder="one per line or comma separated — e.g. earthquake, election, Paris">${esc(r.include.join('\n'))}</textarea>
        <small>New stories (last 12h) whose headline or summary contain one of these are added automatically. Use * as wildcard (elect* ). Matches are highlighted in the story lists.</small></label>
      <div class="field"><span>Only auto-add from these feeds</span>
        <div class="feedcheck">${st.feeds.map((f) => `<label class="check"><input type="checkbox" name="includeFeeds" value="${f.id}" ${r.includeFeeds.includes(f.id) ? 'checked' : ''}> <span style="color:${esc(f.color)}">●</span> ${esc(f.shortName || f.title)}</label>`).join('') || '<span class="hint">No feeds yet</span>'}</div>
        <small>None ticked = all feeds.</small></div>
      <label class="field"><span>Block keywords</span><textarea name="block" placeholder="stories containing these are never auto-added and are dimmed in lists">${esc(r.block.join('\n'))}</textarea></label>
    </div>
    <div class="dlg-foot"><button type="button" class="btn danger" id="delOut" ${st.outputs.length <= 1 ? 'disabled title="At least one output is needed"' : ''}>Delete output</button>
      <div class="right"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn primary">Save</button></div></div></form>`,
  (dlg) => {
    const form = $('#outForm', dlg);
    form.addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const settings = {};
      for (const k of Object.keys(st.defaults)) {
        if (!form.elements[k]) continue; // edited elsewhere (e.g. clock → designer)
        if (typeof st.defaults[k] === 'boolean') settings[k] = form.elements[k].checked;
        else if (fd.has(k)) settings[k] = fd.get(k);
      }
      await api('PATCH', `/api/outputs/${o.id}`, {
        name: fd.get('name'), settings,
        rules: { include: fd.get('include'), block: fd.get('block'), includeFeeds: fd.getAll('includeFeeds') },
      });
      closeModal(); await loadState(); renderAll(); toast('Output saved');
    }));
    $('#delOut', dlg).addEventListener('click', safe(async () => {
      if (!confirm(`Delete output "${o.name}" and its ${o.entries.length} items? Its URLs will stop working.`)) return;
      await api('DELETE', `/api/outputs/${o.id}`);
      closeModal(); await loadState(); prefs.output = st.outputs[0].id; renderAll();
    }));
  });
}

// ------------------------------------------------------------ ticker designer
const FONTS = [
  'Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Tahoma', 'Trebuchet MS', 'Verdana',
  // Google fonts (loaded by the ticker page; need an internet connection)
  'Roboto Condensed', 'Barlow Condensed', 'Oswald', 'Roboto', 'Inter', 'Montserrat', 'Open Sans', 'Source Sans 3',
];

const THEMES = [
  ['Classic red', '#e5383b', {}],
  ['Midnight', '#ffb703', { bg: '#0d1b2a', fg: '#ffffff', accent: '#ffb703', labelBg: '#1b4965', labelFg: '#ffffff', clockBg: '#13293d', clockFg: '#ffffff' }],
  ['Daylight', '#d00000', { bg: '#f4f4f4', fg: '#111111', accent: '#d00000', labelBg: '#d00000', labelFg: '#ffffff', clockBg: '#dedede', clockFg: '#111111' }],
  ['Sport', '#1e8f4e', { bg: '#0f1a14', fg: '#ffffff', accent: '#1e8f4e', labelBg: '#1e8f4e', labelFg: '#ffffff', clockBg: '#163322', clockFg: '#ffffff' }],
  ['Royal', '#7b2cbf', { bg: '#10002b', fg: '#ffffff', accent: '#c77dff', labelBg: '#7b2cbf', labelFg: '#ffffff', clockBg: '#240046', clockFg: '#ffffff' }],
  ['Floating', '#3b6fd6', { margin: 40, radius: 12, bgOpacity: 88, shadow: true }],
  ['Full width', '#8d95a5', { margin: 0, radius: 0, bgOpacity: 100 }],
];

function openDesigner() {
  const o = currentOutput();
  const L = { ...st.lookDefaults, ...o.look };
  const s = o.settings;
  const base = (st.server.lanUrls && st.server.lanUrls[0]) || location.origin;
  const sourceUrl = `${base}/ticker?out=${o.id}`;

  const rng = (name, label, min, max, step, unit = '', autoAt = null, autoText = 'auto') => `
    <label class="field"><span>${label}</span><div class="range">
      <input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${L[name]}" data-unit="${unit}" ${autoAt != null ? `data-auto="${autoAt}" data-autotext="${autoText}"` : ''}>
      <output></output></div></label>`;
  const color = (name, label) => `<label class="color"><input type="color" name="${name}" value="${esc(L[name] || '#000000')}"> ${label}</label>`;
  const chk = (name, label, on) => `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  const seg = (name, opts, val) => `<div class="seg">${opts.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}" ${val === v ? 'checked' : ''}>${l}</label>`).join('')}</div>`;

  modal(`${head(`Ticker designer · ${esc(o.name)}`)}
    <form id="designForm" autocomplete="off"><div class="dlg-body" style="padding:16px 18px"><div class="designer">
      <div>
        <div class="stage-wrap" id="stageWrap"><iframe id="stageFrame" title="Ticker preview" src="/ticker?out=${encodeURIComponent(o.id)}&stage=1"></iframe></div>
        <div class="stage-note"><span>Live preview at 1920×1080. Sample headlines appear when nothing is on air. Nothing changes on air until you save.</span></div>
        <div class="themes">${THEMES.map(([n, c], i) => `<button type="button" class="theme" data-theme="${i}"><i style="background:${c}"></i><span>${n}</span></button>`).join('')}</div>
        <div class="field" style="margin-top:16px"><span>Browser-source URL (OBS / vMix / CasparCG: set the source to 1920×1080)</span>
          <div style="display:flex;gap:6px"><input readonly value="${esc(sourceUrl)}" id="srcUrl" style="flex:1"><button type="button" class="btn small" id="copySrc">Copy</button><a class="btn small" href="${esc(sourceUrl)}" target="_blank" rel="noopener">Open ↗</a></div></div>
      </div>
      <div class="dpanel">
        <details open><summary>Display</summary><div class="inner">
          <div class="field">${seg('mode', [['crawl', '⟵ Continuous crawl'], ['flip', '▤ One at a time']], L.mode)}</div>
          ${rng('speed', 'Scroll speed', 20, 400, 5, ' px/s')}
          <div data-when="mode=flip">
            ${rng('flipSeconds', 'Time per headline', 2, 30, 0.5, ' s')}
            ${rng('breakingEvery', 'Repeat breaking news after every', 0, 10, 1, ' stories', 0, 'in turn')}
            <p class="hint" style="margin:-6px 0 12px">New breaking news always cuts in immediately. While it’s up, the label switches to the breaking label.</p>
            <label class="field"><span>Transition</span><select name="transition">${[['slide', 'Slide up'], ['push', 'Push from the right'], ['fade', 'Fade'], ['none', 'Cut (no animation)']].map(([v, l]) => `<option value="${v}" ${L.transition === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <small>Single-line headlines too long for the bar scroll through before the next one.</small></label>
            ${chk('multiline', 'Allow headlines on several lines', L.multiline)}
            <div data-when="multiline">
              ${rng('maxLines', 'Maximum lines', 2, 4, 1, ' lines')}
              <div class="field" data-when="height=0"><span>Bar height</span>${seg('grow', [['0', 'Fits the maximum lines'], ['1', 'Grows with each headline']], L.grow ? '1' : '0')}
                <small>With a fixed bar height (Layout), text that doesn’t fit shrinks slightly, then ends with “…”.</small></div>
            </div>
          </div>
          <p class="hint" data-when="mode=crawl" style="margin:4px 0 8px">Multi-line headlines and the category label block are available in “One at a time” mode.</p>
        </div></details>

        <details open><summary>Labels</summary><div class="inner">
          <label class="field"><span>Category</span><select name="categoryStyle">${[['badge', 'Coloured badge before the headline'], ['text', 'Coloured word before the headline'], ['label', 'In the label block (one at a time) — e.g. “SPORT”'], ['none', 'Don’t show']]
            .map(([v, l]) => `<option value="${v}" ${s.categoryStyle === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <small>${(st.categories || []).length} categories · <a href="#" id="dEditCats">Edit categories…</a></small></label>
          <label class="field"><span>Source</span><select name="sourceStyle">${[['badge', 'Coloured badge before the headline'], ['prefix', 'Text before: “BBC: …”'], ['suffix', 'Text after: “… (BBC)”'], ['none', 'Don’t show']]
            .map(([v, l]) => `<option value="${v}" ${s.sourceStyle === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <small>Uses each feed’s ticker label and colour. In the RSS/TXT outputs badges become text (“Sport | BBC: …”).</small></label>
        </div></details>

        <details open><summary>Layout</summary><div class="inner">
          <div class="field"><span>Position on screen</span>${seg('position', [['bottom', 'Bottom'], ['top', 'Top']], L.position)}</div>
          ${rng('height', 'Bar height', 0, 240, 2, ' px', 0)}
          ${rng('margin', 'Distance from screen edges', 0, 200, 2, ' px')}
          ${rng('radius', 'Rounded corners', 0, 60, 1, ' px')}
          ${chk('showLabel', 'Show label block', L.showLabel)}
          <label class="field" data-when="showLabel"><span>Label text</span><input name="labelText" value="${esc(L.labelText)}" maxlength="30"><small>Switches to the breaking label while breaking news is on air.</small></label>
          <label class="field"><span>Logo image URL (optional)</span><input name="logoUrl" value="${esc(L.logoUrl)}" placeholder="https://…/logo.png"></label>
          ${chk('shadow', 'Drop shadow', L.shadow)}
        </div></details>

        <details open><summary>Text</summary><div class="inner">
          <label class="field"><span>Font</span><input name="fontFamily" list="fontList" value="${esc(L.fontFamily)}">
            <datalist id="fontList">${FONTS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
            <small>Pick from the list or type any font installed on the ticker computer.</small></label>
          ${rng('fontSize', 'Text size', 12, 96, 1, ' px')}
          <label class="field"><span>Weight</span><select name="fontWeight">${[[400, 'Regular'], [600, 'Semi-bold'], [700, 'Bold'], [800, 'Extra-bold']].map(([v, l]) => `<option value="${v}" ${+L.fontWeight === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div></details>

        <details open><summary>Colours</summary><div class="inner">
          <div class="colors">
            ${color('bg', 'Bar background')}${color('fg', 'Headline text')}
            ${color('labelBg', 'Label background')}${color('labelFg', 'Label text')}
            ${color('clockBg', 'Clock background')}${color('clockFg', 'Clock text')}
            ${color('accent', 'Separators &amp; breaking')}
            <label class="color" data-when="!badgeFeed"><input type="color" name="badgeColor" value="${esc(L.badgeColor || '#555555')}"> Source badges</label>
          </div>
          ${chk('badgeFeed', 'Source badges use each feed’s own colour', !L.badgeColor)}
          ${rng('bgOpacity', 'Bar opacity', 0, 100, 1, ' %')}
          ${chk('breakingPulse', 'Pulse the label during breaking news', L.breakingPulse)}
        </div></details>

        <details><summary>Clock</summary><div class="inner">
          ${chk('showClock', 'Show a clock', s.showClock)}
          <div data-when="showClock">
            <div class="field"><span>Format</span>${seg('clockFormat', [['24h', '24-hour · 17:05'], ['12h', '12-hour · 5:05 PM']], s.clockFormat)}</div>
            <label class="field"><span>Time zone</span><select name="clockTimezone">${timeZoneOptions(s.clockTimezone)}</select></label>
            <label class="field"><span>Clock label (optional)</span><input name="clockLabel" value="${esc(s.clockLabel)}" maxlength="20" placeholder="e.g. PARIS"></label>
            ${chk('clockSeconds', 'Show seconds', s.clockSeconds)}
          </div>
        </div></details>
      </div>
    </div></div>
    <div class="dlg-foot"><button type="button" class="btn" id="resetLook">Reset to default</button>
      <div class="right"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn primary">Save &amp; go live</button></div></div></form>`,
  (dlg) => {
    const form = $('#designForm', dlg);
    const frame = $('#stageFrame', dlg);
    const wrap = $('#stageWrap', dlg);
    const F = form.elements;

    const fit = () => { frame.style.transform = `scale(${wrap.clientWidth / 1920})`; };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    dlg.addEventListener('close', () => ro.disconnect(), { once: true });

    const gather = () => {
      const look = {};
      for (const [k, def] of Object.entries(st.lookDefaults)) {
        const el = F[k];
        if (!el) continue;
        if (el instanceof RadioNodeList && typeof def === 'boolean') look[k] = el.value === '1'; // on/off shown as two buttons
        else look[k] = typeof def === 'boolean' ? el.checked : typeof def === 'number' ? +el.value : el.value;
      }
      if (F.badgeFeed.checked) look.badgeColor = '';
      const clock = { show: F.showClock.checked, format: F.clockFormat.value, timezone: F.clockTimezone.value, label: F.clockLabel.value.trim(), seconds: F.clockSeconds.checked };
      const settings = { categoryStyle: F.categoryStyle.value, sourceStyle: F.sourceStyle.value };
      return { look, clock, settings };
    };

    const refresh = () => {
      // range read-outs
      for (const r of $$('input[type=range]', form)) {
        r.nextElementSibling.textContent = r.dataset.auto != null && +r.value === +r.dataset.auto ? r.dataset.autotext : `${r.value}${r.dataset.unit || ''}`;
      }
      // show only the options that apply
      for (const el of $$('[data-when]', form)) {
        const cond = el.dataset.when;
        let on;
        if (cond.includes('=')) { const [k, v] = cond.split('='); on = F[k].value === v; }
        else if (cond.startsWith('!')) on = !F[cond.slice(1)].checked;
        else on = F[cond].checked;
        el.classList.toggle('off', !on);
      }
      const { look, clock, settings } = gather();
      frame.contentWindow && frame.contentWindow.postMessage({ type: 'louiseticker-preview', look, clock, settings }, location.origin);
    };
    frame.addEventListener('load', () => { fit(); refresh(); });
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();

    const setValues = (vals) => {
      for (const [k, v] of Object.entries(vals)) {
        const el = F[k];
        if (!el) continue;
        if (el instanceof RadioNodeList) { const sv = v === true ? '1' : v === false ? '0' : String(v); for (const r of el) r.checked = r.value === sv; }
        else if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
      }
      if ('badgeColor' in vals) { F.badgeFeed.checked = !vals.badgeColor; if (vals.badgeColor) F.badgeColor.value = vals.badgeColor; }
      refresh();
    };
    $$('[data-theme]', dlg).forEach((b) => b.addEventListener('click', () => setValues({ ...(THEMES[+b.dataset.theme][0] === 'Classic red' ? pickColors(st.lookDefaults) : {}), ...THEMES[+b.dataset.theme][2] })));
    $('#resetLook', dlg).addEventListener('click', () => setValues(st.lookDefaults));
    $('#dEditCats', dlg).addEventListener('click', (e) => {
      e.preventDefault();
      if (confirm('Open the category editor? Unsaved designer changes will be lost.')) openCategories();
    });
    $('#copySrc', dlg).addEventListener('click', () => navigator.clipboard.writeText(sourceUrl).then(() => toast('URL copied'), () => $('#srcUrl', dlg).select()));

    form.addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      const { look, clock, settings } = gather();
      await api('PATCH', `/api/outputs/${o.id}`, {
        look,
        settings: { ...settings, showClock: clock.show, clockFormat: clock.format, clockTimezone: clock.timezone, clockLabel: clock.label, clockSeconds: clock.seconds },
      });
      closeModal(); await loadState(); renderAll(); toast('Ticker updated on air');
    }));
  }, { wide: true });
}

const pickColors = (l) => Object.fromEntries(Object.entries(l).filter(([k]) => /^(bg|fg|accent|labelBg|labelFg|clockBg|clockFg)$/.test(k)));

// ------------------------------------------------------------ categories
function openCategories() {
  let cats = (st.categories || []).map((c) => ({ ...c, match: [...(c.match || [])] }));
  const allItems = () => st.feeds.flatMap((f) => (st.items[f.id] || []).map((it) => [it, f]));

  modal(`${head('Ticker categories')}
    <form id="catForm" autocomplete="off"><div class="dlg-body">
      <p class="hint" style="margin-top:0">Stories get a category automatically when one of its <b>match words</b> appears in the story’s RSS category tags or in its web address (e.g. <code>/sport/</code>). The first matching category in this list wins, so use ↑ ↓ to set priority. A feed can also force one category for all its stories (feed settings ⚙), and you can change any story’s category in the output list.</p>
      <div id="catRows" class="catrows"></div>
      <button type="button" class="btn small" id="catAdd" style="margin-top:8px">＋ Add category</button>
      <label class="check" style="margin-top:14px"><input type="checkbox" id="catReapply" checked> Also re-apply to stories already in the outputs <span class="hint">(categories you picked by hand are kept)</span></label>
    </div>
    <div class="dlg-foot"><span></span><div class="right"><button type="button" class="btn" data-close-modal>Cancel</button><button class="btn primary">Save categories</button></div></div></form>`,
  (dlg) => {
    const rowsEl = $('#catRows', dlg);
    const sync = () => {
      $$('.catrow', rowsEl).forEach((row, i) => {
        cats[i].name = $('[name=name]', row).value;
        cats[i].color = $('[name=color]', row).value;
        cats[i].match = $('[name=match]', row).value.split(',').map((x) => x.trim()).filter(Boolean);
      });
    };
    // how many stored stories each category would catch right now
    const counts = () => {
      const n = new Map();
      for (const [it, f] of allItems()) {
        const id = categorize(it, f, cats.map((c, i) => ({ ...c, id: c.id || `new${i}` })));
        if (id) n.set(id, (n.get(id) || 0) + 1);
      }
      $$('.catrow', rowsEl).forEach((row, i) => { $('.catcount', row).textContent = `${n.get(cats[i].id || `new${i}`) || 0} stories`; });
    };
    const render = () => {
      rowsEl.innerHTML = cats.map((c, i) => `
        <div class="catrow">
          <input type="color" name="color" value="${esc(c.color || '#8d95a5')}" title="Colour">
          <div class="catmain">
            <input name="name" value="${esc(c.name)}" placeholder="Name, e.g. Sport" maxlength="30">
            <input name="match" value="${esc((c.match || []).join(', '))}" placeholder="match words, comma separated: football, rugby, tennis">
          </div>
          <span class="catcount"></span>
          <div class="catbtns">
            <button type="button" class="icon-btn" data-move="${i}:-1" title="Higher priority" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-move="${i}:1" title="Lower priority" ${i === cats.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-del="${i}" title="Delete">✕</button>
          </div>
        </div>`).join('') || '<div class="hint">No categories.</div>';
      counts();
    };
    render();
    let t = null;
    rowsEl.addEventListener('input', () => { sync(); clearTimeout(t); t = setTimeout(counts, 250); });
    rowsEl.addEventListener('click', (e) => {
      const mv = e.target.closest('[data-move]');
      const del = e.target.closest('[data-del]');
      if (!mv && !del) return;
      sync();
      if (mv) { const [i, d] = mv.dataset.move.split(':').map(Number); [cats[i], cats[i + d]] = [cats[i + d], cats[i]]; }
      if (del) cats.splice(+del.dataset.del, 1);
      render();
    });
    $('#catAdd', dlg).addEventListener('click', () => {
      sync();
      cats.push({ name: '', color: ['#e4572e', '#29a3d6', '#f2b134', '#6bbf59', '#b86bd6', '#ef6f9a', '#3ec7b0'][cats.length % 7], match: [] });
      render();
      $$('.catrow [name=name]', rowsEl).pop().focus();
    });
    $('#catForm', dlg).addEventListener('submit', safe(async (e) => {
      e.preventDefault();
      sync();
      await api('PUT', '/api/categories', { categories: cats });
      if ($('#catReapply', dlg).checked) for (const o of st.outputs) await api('POST', `/api/outputs/${o.id}/recategorize`);
      closeModal(); await loadState(); renderAll(); toast('Categories saved');
    }));
  });
}

function openCategoryPicker(o, entry) {
  const cur = entry.category;
  modal(`${head('Category')}
    <div class="dlg-body"><div class="hint" style="margin-bottom:12px">${esc(entry.title)}</div>
      <div class="catpick">${(st.categories || []).map((c) => `<button type="button" class="catbtn ${c.id === cur ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}">${esc(c.name)}</button>`).join('')}
        <button type="button" class="catbtn ${!cur ? 'on' : ''}" data-cat="" style="--c:#5f6778">No category</button></div>
      <p class="hint" style="margin-top:14px"><a href="#" id="pickEdit">Edit categories…</a></p>
    </div>`,
  (dlg) => {
    $$('[data-cat]', dlg).forEach((b) => b.addEventListener('click', safe(async () => {
      await api('PATCH', `/api/outputs/${o.id}/entries/${entry.id}`, { category: b.dataset.cat || null });
      closeModal(); await loadState(); renderAll();
    })));
    $('#pickEdit', dlg).addEventListener('click', (e) => { e.preventDefault(); openCategories(); });
  });
}

function openExpiry(o, entry) {
  const opts = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']];
  modal(`${head('Take off air automatically')}
    <div class="dlg-body"><div class="hint" style="margin-bottom:12px">${esc(entry.title)}</div>
      <div class="presets">${opts.map(([m, l]) => `<button class="preset" data-min="${m}">in ${l}</button>`).join('')}<button class="preset" data-min="0">Never expire</button></div>
      ${entry.expiresAt ? `<p class="hint">Currently: ${timeLeft(entry.expiresAt)} (${new Date(entry.expiresAt).toLocaleTimeString()})</p>` : ''}
    </div>`,
  (dlg) => {
    $$('[data-min]', dlg).forEach((b) => b.addEventListener('click', safe(async () => {
      const m = +b.dataset.min;
      await api('PATCH', `/api/outputs/${o.id}/entries/${entry.id}`, { expiresAt: m ? Date.now() + m * 60000 : null });
      closeModal(); await loadState(); renderAll();
    })));
  });
}

function openCopyTo() {
  const o = currentOutput();
  const others = st.outputs.filter((x) => x.id !== o.id);
  if (!others.length) return toast('Create another output first (＋ next to the output selector)');
  modal(`${head(`Copy items from “${esc(o.name)}”`)}
    <div class="dlg-body"><p class="hint">Copies all ${o.entries.length} items (skipping ones already there) into:</p>
    <div class="presets">${others.map((x) => `<button class="preset" data-to="${x.id}">${esc(x.name)}<small>${x.entries.length} items</small></button>`).join('')}</div></div>`,
  (dlg) => {
    $$('[data-to]', dlg).forEach((b) => b.addEventListener('click', safe(async () => {
      await api('POST', `/api/outputs/${o.id}/copy-to/${b.dataset.to}`, {});
      closeModal(); await loadState(); renderAll(); toast('Copied');
    })));
  });
}

// ------------------------------------------------------------ top bar & keyboard
function wireTop() {
  $('#btnAddFeed').addEventListener('click', openAddFeed);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSplit').addEventListener('click', () => paneAction(prefs.focused, 'split'));
  $('#btnRefreshAll').addEventListener('click', safe(async () => {
    const b = $('#btnRefreshAll');
    b.disabled = true; b.textContent = '⟳ Refreshing…';
    try { await api('POST', '/api/refresh'); await loadState(); await loadItems(); renderAll(); toast('All feeds refreshed'); }
    finally { b.disabled = false; b.textContent = '⟳ Refresh all'; }
  }));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable="true"]') || $('#modal').open) return;
    const i = prefs.focused;
    const p = prefs.panes[i];
    const tabs = tabList();
    if (e.key === '/') { e.preventDefault(); $('.search', paneEls[i].toolbar)?.focus(); }
    else if (e.key === 'r' || e.key === 'R') $('#btnRefreshAll').click();
    else if (e.key === 'a' || e.key === 'A') openAddFeed();
    else if (e.key === 's' || e.key === 'S') paneAction(i, 'split');
    else if (/^[1-9]$/.test(e.key) && tabs[+e.key - 1]) { p.tab = tabs[+e.key - 1]; renderPane(i); prefs.save(); }
    else if (e.key === ']' || e.key === '[') { const k = tabs.indexOf(p.tab); p.tab = tabs[(k + (e.key === ']' ? 1 : -1) + tabs.length) % tabs.length]; renderPane(i); prefs.save(); }
  });
}

// ------------------------------------------------------------ boot
(async function boot() {
  wireTop();
  wireOutput();
  try {
    await loadState();
    await loadItems();
  } catch (e) {
    toast('Cannot reach the LouiseTicker server — is it running?', true);
    return;
  }
  if (prefs.lastSeen.all == null) prefs.lastSeen.all = Date.now();
  renderAll();
  connectEvents();
  // keep relative times fresh
  setInterval(() => { if (!document.querySelector('[contenteditable="true"]') && !$('#modal').open) renderAll(); }, 60000);
})();
