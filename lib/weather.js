'use strict';
// Live weather lines from Open-Meteo (https://open-meteo.com). No key needed for the free,
// non-commercial API; with a key, requests go to the commercial "customer" endpoints.

const FREE = { api: 'https://api.open-meteo.com', geo: 'https://geocoding-api.open-meteo.com' };
const PAID = { api: 'https://customer-api.open-meteo.com', geo: 'https://customer-geocoding-api.open-meteo.com' };

function bases(apiKey) {
  const b = apiKey ? PAID : FREE;
  return { api: process.env.OPENMETEO_BASE || b.api, geo: process.env.OPENMETEO_GEO_BASE || b.geo };
}

// WMO weather interpretation codes → [English, French, emoji]
const WMO = {
  0: ['clear sky', 'ciel dégagé', '☀️'],
  1: ['mainly clear', 'plutôt dégagé', '🌤️'],
  2: ['partly cloudy', 'partiellement nuageux', '⛅'],
  3: ['overcast', 'couvert', '☁️'],
  45: ['fog', 'brouillard', '🌫️'], 48: ['freezing fog', 'brouillard givrant', '🌫️'],
  51: ['light drizzle', 'bruine légère', '🌦️'], 53: ['drizzle', 'bruine', '🌦️'], 55: ['heavy drizzle', 'forte bruine', '🌧️'],
  56: ['freezing drizzle', 'bruine verglaçante', '🌧️'], 57: ['freezing drizzle', 'bruine verglaçante', '🌧️'],
  61: ['light rain', 'pluie faible', '🌦️'], 63: ['rain', 'pluie', '🌧️'], 65: ['heavy rain', 'forte pluie', '🌧️'],
  66: ['freezing rain', 'pluie verglaçante', '🌧️'], 67: ['freezing rain', 'pluie verglaçante', '🌧️'],
  71: ['light snow', 'neige faible', '🌨️'], 73: ['snow', 'neige', '❄️'], 75: ['heavy snow', 'forte neige', '❄️'], 77: ['snow grains', 'grains de neige', '🌨️'],
  80: ['showers', 'averses', '🌦️'], 81: ['showers', 'averses', '🌧️'], 82: ['violent showers', 'fortes averses', '⛈️'],
  85: ['snow showers', 'averses de neige', '🌨️'], 86: ['heavy snow showers', 'fortes averses de neige', '🌨️'],
  95: ['thunderstorm', 'orage', '⛈️'], 96: ['thunderstorm with hail', 'orage avec grêle', '⛈️'], 99: ['thunderstorm with hail', 'orage avec grêle', '⛈️'],
};
function describeCode(code, lang = 'en') {
  const w = WMO[code] || ['—', '—', ''];
  return { text: lang === 'fr' ? w[1] : w[0], emoji: w[2] };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'LouiseTicker/1.0' }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Open-Meteo: ${body.reason || `HTTP ${res.status}`}`);
  return body;
}

/** Look up places by name → [{ name, admin1, country, lat, lon }] */
async function geocode(q, lang = 'en', apiKey = '') {
  const u = new URL('/v1/search', bases(apiKey).geo);
  u.search = new URLSearchParams({ name: q, count: '6', language: lang, format: 'json', ...(apiKey ? { apikey: apiKey } : {}) });
  const body = await getJson(u);
  return (body.results || []).map((r) => ({ name: r.name, admin1: r.admin1 || '', country: r.country || '', lat: r.latitude, lon: r.longitude }));
}

/** Current conditions + 2-day forecast for several places in one request → array (same order as locations). */
async function fetchWeather(locations, { units = 'C', apiKey = '' } = {}) {
  if (!locations.length) return [];
  const u = new URL('/v1/forecast', bases(apiKey).api);
  u.search = new URLSearchParams({
    latitude: locations.map((l) => l.lat).join(','),
    longitude: locations.map((l) => l.lon).join(','),
    current: 'temperature_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_min,temperature_2m_max,weather_code',
    timezone: 'auto',
    forecast_days: '2',
    ...(units === 'F' ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' } : {}),
    ...(apiKey ? { apikey: apiKey } : {}),
  });
  const body = await getJson(u);
  return Array.isArray(body) ? body : [body]; // one location → object, several → array
}

/**
 * Ticker text from a weather config and Open-Meteo results.
 * layout "combined": one line, e.g. "Météo : Paris 18° ☀️ · Lyon 21° ⛅"
 * layout "perCity":  one line per place, e.g. "Paris : 18°, ensoleillé — min 12° / max 21°"
 */
function formatWeather(cfg, results) {
  const fr = cfg.lang === 'fr';
  const f = { now: true, today: false, tomorrow: false, wind: false, ...(cfg.fields || {}) }; // same defaults as cleanWeatherConfig
  const deg = (v) => (v == null || Number.isNaN(+v) ? '–' : `${Math.round(v)}°`);
  const emo = (c) => (cfg.emoji === false ? '' : describeCode(c).emoji);
  const words = (c) => describeCode(c, cfg.lang).text;
  const colon = fr ? ' : ' : ': ';
  const windUnit = cfg.units === 'F' ? 'mph' : 'km/h';

  const parts = (cfg.locations || []).map((loc, i) => {
    const r = results[i] || {};
    const cur = r.current || {};
    const d = r.daily || {};
    const bits = [];
    if (cfg.layout === 'perCity') {
      if (f.now) bits.push(`${deg(cur.temperature_2m)}${emo(cur.weather_code) ? ' ' + emo(cur.weather_code) : ''} ${words(cur.weather_code)}`.trim());
      if (f.today && d.temperature_2m_min) bits.push(`${fr ? 'min' : 'low'} ${deg(d.temperature_2m_min[0])} / ${fr ? 'max' : 'high'} ${deg(d.temperature_2m_max[0])}`);
      if (f.tomorrow && d.temperature_2m_min) bits.push(`${fr ? 'demain' : 'tomorrow'} ${deg(d.temperature_2m_min[1])}–${deg(d.temperature_2m_max[1])} ${emo(d.weather_code[1])} ${words(d.weather_code[1])}`.replace(/\s+/g, ' ').trim());
      if (f.wind && cur.wind_speed_10m != null) bits.push(`${fr ? 'vent' : 'wind'} ${Math.round(cur.wind_speed_10m)} ${windUnit}`);
      return `${loc.name}${colon}${bits.join(', ')}`;
    }
    if (f.now) bits.push(`${deg(cur.temperature_2m)} ${emo(cur.weather_code)}`.trim());
    if (f.today && d.temperature_2m_min) bits.push(`(${deg(d.temperature_2m_min[0])}/${deg(d.temperature_2m_max[0])})`);
    if (f.tomorrow && d.temperature_2m_max) bits.push(`${fr ? 'demain' : 'tmrw'} ${deg(d.temperature_2m_max[1])} ${emo(d.weather_code[1])}`.trim());
    if (f.wind && cur.wind_speed_10m != null) bits.push(`${Math.round(cur.wind_speed_10m)} ${windUnit}`);
    return `${loc.name} ${bits.join(' ')}`.trim();
  });

  if (cfg.layout === 'perCity') return parts;
  const title = (cfg.title || (fr ? 'Météo' : 'Weather')).trim();
  return parts.length ? [`${title}${colon}${parts.join(' · ')}`] : [];
}

// Validate a weather config coming from a client.
function cleanWeatherConfig(d) {
  const locations = (Array.isArray(d.locations) ? d.locations : [])
    .filter((l) => l && Number.isFinite(+l.lat) && Number.isFinite(+l.lon) && String(l.name || '').trim())
    .slice(0, 12)
    .map((l) => ({ name: String(l.name).trim().slice(0, 40), lat: +(+l.lat).toFixed(4), lon: +(+l.lon).toFixed(4) }));
  const fields = d.fields || {};
  return {
    type: 'weather',
    title: String(d.title || '').slice(0, 30),
    locations,
    layout: d.layout === 'perCity' ? 'perCity' : 'combined',
    fields: { now: fields.now !== false, today: !!fields.today, tomorrow: !!fields.tomorrow, wind: !!fields.wind },
    units: d.units === 'F' ? 'F' : 'C',
    lang: d.lang === 'en' ? 'en' : 'fr',
    emoji: d.emoji !== false,
  };
}

module.exports = { geocode, fetchWeather, formatWeather, describeCode, cleanWeatherConfig };
