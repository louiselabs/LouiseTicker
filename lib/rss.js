'use strict';
// Minimal, dependency-free RSS 2.0 / RSS 1.0 (RDF) / Atom parser + feed discovery.

const crypto = require('crypto');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', pound: '£', euro: '€',
  yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', times: '×',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä',
  aring: 'å', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô',
  ouml: 'ö', oslash: 'ø', otilde: 'õ', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç',
  ntilde: 'ñ', szlig: 'ß', aelig: 'æ', oelig: 'œ', shy: '',
};

function decodeEntities(s) {
  if (!s) return '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const v = ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Raw inner content of the first matching tag (namespaced names allowed, e.g. "dc:creator").
function rawTag(xml, name) {
  const re = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(name)}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function attrsOf(tag) {
  const out = {};
  tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, a, b) => { out[k.toLowerCase()] = decodeEntities(a ?? b); });
  return out;
}

function allTags(xml, name) {
  const re = new RegExp(`<${escapeRe(name)}(\\s[^>]*?)?/?>`, 'gi');
  return [...xml.matchAll(re)].map((m) => attrsOf(m[1] || ''));
}

// Text value: unwrap CDATA or decode entities (yielding possibly-HTML text).
function textValue(raw) {
  if (raw == null) return '';
  if (raw.includes('<![CDATA[')) {
    return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  }
  return decodeEntities(raw);
}

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function firstImgSrc(html) {
  const m = html && html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.trim());
  return isNaN(d) ? null : d.toISOString();
}

function hashId(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 14); }

function absolutize(u, base) {
  if (!u) return u;
  try { return new URL(u, base).href; } catch { return u; }
}

function parseItem(block, isAtom, baseUrl) {
  const title = stripHtml(textValue(rawTag(block, 'title')));
  let link = null;
  if (isAtom) {
    const links = allTags(block, 'link');
    const alt = links.find((l) => !l.rel || l.rel === 'alternate') || links[0];
    link = alt ? alt.href : null;
  } else {
    link = stripHtml(textValue(rawTag(block, 'link'))) || null;
    if (!link) {
      const l = allTags(block, 'link').find((a) => a.href);
      link = l ? l.href : null;
    }
  }
  const guid = stripHtml(textValue(rawTag(block, 'guid') ?? rawTag(block, 'id'))) || null;
  if (!link && guid && /^https?:\/\//.test(guid)) link = guid;
  link = absolutize(link, baseUrl);

  const descHtml = textValue(
    rawTag(block, 'description') ?? rawTag(block, 'summary') ?? rawTag(block, 'content:encoded') ?? rawTag(block, 'content') ?? ''
  );
  const contentHtml = textValue(rawTag(block, 'content:encoded') ?? rawTag(block, 'content') ?? '');

  const date = parseDate(
    textValue(rawTag(block, 'pubDate') ?? rawTag(block, 'published') ?? rawTag(block, 'updated') ?? rawTag(block, 'dc:date') ?? '')
  );

  let author = stripHtml(textValue(rawTag(block, 'dc:creator') ?? ''));
  if (!author) {
    const a = rawTag(block, 'author');
    if (a) author = stripHtml(textValue(rawTag(a, 'name') ?? a));
  }

  let image = null;
  const mediaThumb = allTags(block, 'media:thumbnail').find((t) => t.url);
  const mediaContent = allTags(block, 'media:content').find((t) => t.url && (!t.medium || t.medium === 'image') && (!t.type || t.type.startsWith('image')));
  const enclosure = allTags(block, 'enclosure').find((t) => t.url && (t.type || '').startsWith('image'));
  image = (mediaThumb && mediaThumb.url) || (mediaContent && mediaContent.url) || (enclosure && enclosure.url) || firstImgSrc(descHtml) || firstImgSrc(contentHtml);
  image = absolutize(image, baseUrl);

  const categories = [...block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((m) => stripHtml(textValue(m[1]))).filter(Boolean);
  for (const c of allTags(block, 'category')) if (c.term) categories.push(c.term);

  let description = stripHtml(descHtml);
  if (description.length > 600) description = description.slice(0, 597) + '…';

  return {
    id: hashId(guid || link || title),
    title: title || '(untitled)',
    link,
    description,
    date,
    author: author || null,
    image,
    categories: [...new Set(categories)].slice(0, 6),
  };
}

function looksLikeFeed(text) {
  const head = text.slice(0, 2000);
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(head) || /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(text.slice(0, 20000));
}

function parseFeed(text, baseUrl) {
  if (!looksLikeFeed(text)) throw new Error('Not an RSS/Atom feed');
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = isAtom
    ? [...text.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...text.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const firstIdx = text.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const header = firstIdx > 0 ? text.slice(0, firstIdx) : text;
  const title = stripHtml(textValue(rawTag(header, 'title'))) || baseUrl;
  let siteLink = null;
  if (isAtom) {
    const l = allTags(header, 'link').find((a) => !a.rel || a.rel === 'alternate');
    siteLink = l ? l.href : null;
  } else {
    siteLink = stripHtml(textValue(rawTag(header, 'link'))) || null;
  }
  const seen = new Set();
  const items = [];
  for (const b of blocks) {
    const it = parseItem(b, isAtom, baseUrl);
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  return { title, siteLink: absolutize(siteLink, baseUrl), items };
}

// Find <link rel="alternate" type="application/rss+xml"> in an HTML page.
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if ((a.rel || '').toLowerCase().includes('alternate') && /(rss|atom)\+xml|application\/xml/i.test(a.type || '') && a.href) {
      out.push({ url: absolutize(a.href, baseUrl), title: a.title || null });
    }
  }
  return out;
}

function detectCharset(contentType, bytes) {
  let m = (contentType || '').match(/charset=([^;]+)/i);
  if (m) return m[1].trim().replace(/"/g, '');
  const head = Buffer.from(bytes.slice(0, 300)).toString('latin1');
  m = head.match(/encoding=["']([^"']+)["']/i);
  return m ? m[1] : 'utf-8';
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'LouiseTicker/1.0 (+RSS aggregator)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let charset = detectCharset(res.headers.get('content-type'), buf);
  let text;
  try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
  return { text: text.replace(/^﻿/, ''), finalUrl: res.url || url };
}

// Fetch a URL; if it's an HTML page, try to auto-discover its feed.
async function fetchFeed(url) {
  let { text, finalUrl } = await fetchText(url);
  if (!looksLikeFeed(text)) {
    const found = discoverFeeds(text, finalUrl);
    if (!found.length) throw new Error('No RSS/Atom feed found at this address');
    const r = await fetchText(found[0].url);
    text = r.text;
    finalUrl = r.finalUrl;
  }
  return { url: finalUrl, ...parseFeed(text, finalUrl) };
}

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
    // strip characters illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

module.exports = { fetchFeed, parseFeed, discoverFeeds, stripHtml, escapeXml, hashId };
