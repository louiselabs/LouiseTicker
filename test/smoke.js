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

// Categories: feed default first, then the first category whose match words appear in RSS tags or the URL
const { categorize } = require('../public/categorize');
const cats = [
  { id: 'weather', match: ['weather', 'météo'] },
  { id: 'sport', match: ['sport', 'football', 'formula 1'] },
  { id: 'world', match: ['world'] },
];
assert.strictEqual(categorize({ link: 'https://www.bbc.co.uk/sport/football/articles/x' }, null, cats), 'sport');
assert.strictEqual(categorize({ categories: ['Formula 1 - Grand Prix'] }, null, cats), 'sport');
assert.strictEqual(categorize({ categories: ['Météo'] }, null, cats), 'weather');
assert.strictEqual(categorize({ link: 'https://www.bbc.co.uk/news/world-europe-123' }, null, cats), 'world');
assert.strictEqual(categorize({ link: 'https://example.com/news/uk-1' }, null, cats), null);
assert.strictEqual(categorize({ link: 'https://example.com/sport/1' }, { category: 'weather' }, cats), 'weather');
assert.strictEqual(categorize({ categories: ['Sportswear'] }, null, cats), null, 'whole words only');

// Scheduling: one-off start/end, daily windows (incl. past midnight), weekdays, time zones
const schedule = require('../public/schedule');
const at = (iso) => Date.parse(iso); // UTC instants
const UTC = 'UTC';
assert.strictEqual(schedule.isOnAir({}, at('2026-10-01T12:00Z'), UTC), true);
assert.strictEqual(schedule.isOnAir({ hold: true }, at('2026-10-01T12:00Z'), UTC), false);
assert.strictEqual(schedule.isOnAir({ startsAt: at('2026-10-01T13:00Z') }, at('2026-10-01T12:00Z'), UTC), false);
assert.strictEqual(schedule.isOnAir({ expiresAt: at('2026-10-01T11:00Z') }, at('2026-10-01T12:00Z'), UTC), false);
const win = { repeat: { from: '07:00', to: '09:00', days: [1, 2, 3, 4, 5] } }; // weekday mornings
assert.strictEqual(schedule.isOnAir(win, at('2026-10-01T08:30Z'), UTC), true, 'Thursday 08:30 inside');
assert.strictEqual(schedule.isOnAir(win, at('2026-10-01T09:00Z'), UTC), false, 'end is exclusive');
assert.strictEqual(schedule.isOnAir(win, at('2026-10-03T08:30Z'), UTC), false, 'Saturday excluded');
const night = { repeat: { from: '22:00', to: '02:00', days: [5] } }; // Friday night
assert.strictEqual(schedule.isOnAir(night, at('2026-10-02T23:00Z'), UTC), true, 'Friday 23:00');
assert.strictEqual(schedule.isOnAir(night, at('2026-10-03T01:30Z'), UTC), true, 'Saturday 01:30 belongs to Friday night');
assert.strictEqual(schedule.isOnAir(night, at('2026-10-03T23:00Z'), UTC), false, 'Saturday 23:00 not');
// same instant, different clock: 08:30 UTC is 10:30 in Paris (summer time) and 04:30 in New York
assert.strictEqual(schedule.isOnAir(win, at('2026-10-01T08:30Z'), 'Europe/Paris'), false);
assert.strictEqual(schedule.isOnAir({ repeat: { from: '04:00', to: '05:00' } }, at('2026-10-01T08:30Z'), 'America/New_York'), true);
assert.strictEqual(schedule.cleanRepeat({ from: '7:05', to: 'x' }), null);
assert.deepStrictEqual(schedule.cleanRepeat({ from: '7:05', to: '9:00', days: [1, 9, 1] }), { from: '07:05', to: '09:00', days: [1] });
assert.strictEqual(schedule.describe(win), '07:00–09:00 Mon–Fri');

// Weather text from an Open-Meteo response
const weather = require('../lib/weather');
assert.deepStrictEqual(weather.describeCode(61, 'fr'), { text: 'pluie faible', emoji: '🌦️' });
const om = [
  { current: { temperature_2m: 18.4, weather_code: 0, wind_speed_10m: 12.2 }, daily: { temperature_2m_min: [11.6, 9], temperature_2m_max: [21.2, 19], weather_code: [0, 63] } },
  { current: { temperature_2m: 24.9, weather_code: 2, wind_speed_10m: 30 }, daily: { temperature_2m_min: [17, 16], temperature_2m_max: [26, 25], weather_code: [2, 3] } },
];
const places = [{ name: 'Paris', lat: 48.85, lon: 2.35 }, { name: 'Marseille', lat: 43.3, lon: 5.37 }];
const cfg = weather.cleanWeatherConfig({ locations: places, fields: { now: true, today: true }, lang: 'fr' });
assert.deepStrictEqual(weather.formatWeather(cfg, om), ['Météo : Paris 18° ☀️ (12°/21°) · Marseille 25° ⛅ (17°/26°)']);
assert.deepStrictEqual(
  weather.formatWeather({ ...cfg, layout: 'perCity', lang: 'en', emoji: false, fields: { now: true, tomorrow: true, wind: true } }, om),
  ['Paris: 18° clear sky, tomorrow 9°–19° rain, wind 12 km/h', 'Marseille: 25° partly cloudy, tomorrow 16°–25° overcast, wind 30 km/h'],
);
assert.strictEqual(weather.cleanWeatherConfig({ locations: [{ name: '', lat: 1, lon: 1 }] }).locations.length, 0);

console.log('All parser tests passed');
