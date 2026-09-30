'use strict';
// Parser smoke tests: node test/smoke.js
const assert = require('assert');
const { parseFeed, discoverFeeds, escapeXml } = require('../lib/rss');

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Test &amp; News</title><link>https://example.com/</link>
<item><title><![CDATA[Storm hits <b>coast</b> &amp; towns]]></title><link>https://example.com/a</link>
  <guid isPermaLink="false">a-1</guid><pubDate>Sat, 26 Sep 2026 10:00:00 GMT</pubDate>
  <description>&lt;p&gt;Heavy rain &amp;amp; wind&lt;/p&gt;</description><dc:creator>Jane</dc:creator>
  <media:thumbnail url="https://example.com/a.jpg" width="240"/></item>
<item><title>L&#8217;été à Paris</title><link>/b</link><pubDate>garbage</pubDate></item>
<item><title>L&#8217;été à Paris</title><link>/b</link></item>
</channel></rss>`;

const r = parseFeed(rss, 'https://example.com/feed');
assert.strictEqual(r.title, 'Test & News');
assert.strictEqual(r.items.length, 2, 'duplicate items are dropped');
assert.strictEqual(r.items[0].title, 'Storm hits coast & towns');
assert.strictEqual(r.items[0].description, 'Heavy rain & wind');
assert.strictEqual(r.items[0].author, 'Jane');
assert.strictEqual(r.items[0].image, 'https://example.com/a.jpg');
assert.strictEqual(r.items[0].date, '2026-09-26T10:00:00.000Z');
assert.strictEqual(r.items[1].title, 'L’été à Paris');
assert.strictEqual(r.items[1].link, 'https://example.com/b');
assert.strictEqual(r.items[1].date, null);

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Atom Feed</title>
<link href="https://atom.example/"/>
<entry><title>First</title><link rel="alternate" href="https://atom.example/1"/><id>urn:1</id>
<updated>2026-09-25T08:00:00Z</updated><summary type="html">&lt;b&gt;Hi&lt;/b&gt; there</summary><author><name>Bob</name></author></entry>
</feed>`;
const a = parseFeed(atom, 'https://atom.example/feed');
assert.strictEqual(a.title, 'Atom Feed');
assert.strictEqual(a.items[0].link, 'https://atom.example/1');
assert.strictEqual(a.items[0].description, 'Hi there');
assert.strictEqual(a.items[0].author, 'Bob');

const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Main" href="/rss.xml"></head></html>`;
assert.deepStrictEqual(discoverFeeds(html, 'https://site.example/news/'), [{ url: 'https://site.example/rss.xml', title: 'Main' }]);

assert.throws(() => parseFeed('<html>nope</html>', 'x'));
assert.strictEqual(escapeXml('a<b>&"\u0001'), 'a&lt;b&gt;&amp;&quot;');

console.log('All parser tests passed');
