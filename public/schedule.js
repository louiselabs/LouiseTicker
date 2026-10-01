/* Entry timing: one-off start/end and daily windows. Shared by the server (require) and the browser (window.schedule). */
(function (root) {
  'use strict';

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const toMin = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : 0;
  };

  // Day of week (0 = Sunday) and minutes since midnight on the wall clock of a time zone ('' = local).
  function wallClock(now, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
      const get = (t) => parts.find((p) => p.type === t).value;
      return { day: DAY_NAMES.indexOf(get('weekday')), min: (+get('hour') % 24) * 60 + +get('minute') };
    } catch {
      const d = new Date(now);
      return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
    }
  }

  // Is `now` inside a daily window? Windows may run past midnight (22:00–02:00); from == to means all day.
  function inWindow(rep, now, tz) {
    const { day, min } = wallClock(now, tz);
    const days = rep.days && rep.days.length ? rep.days : [0, 1, 2, 3, 4, 5, 6];
    const f = toMin(rep.from), t = toMin(rep.to);
    if (f === t) return days.includes(day);
    if (f < t) return days.includes(day) && min >= f && min < t;
    if (min >= f) return days.includes(day);           // evening part, started today
    if (min < t) return days.includes((day + 6) % 7);  // early-morning part, started yesterday
    return false;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtWhen = (ts, now) => (new Date(ts).toDateString() === new Date(now).toDateString() ? fmtTime(ts) : `${new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(ts)}`);

  function daysText(days) {
    if (!days || !days.length || days.length === 7) return 'every day';
    const s = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).join(',');
    if (s === '1,2,3,4,5') return 'Mon–Fri';
    if (s === '6,0') return 'weekends';
    return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(' ');
  }

  /** Where an entry stands right now: { onAir, state: on|held|waiting|outside|ended, text } */
  function status(e, now, tz) {
    if (e.hold) return { onAir: false, state: 'held', text: 'held' };
    if (e.expiresAt && now >= e.expiresAt) return { onAir: false, state: 'ended', text: 'ended' };
    if (e.startsAt && now < e.startsAt) return { onAir: false, state: 'waiting', text: `starts ${fmtWhen(e.startsAt, now)}` };
    if (e.repeat && !inWindow(e.repeat, now, tz)) return { onAir: false, state: 'outside', text: `next ${e.repeat.from}` };
    return { onAir: true, state: 'on', text: 'on air' };
  }

  const isOnAir = (e, now, tz) => status(e, now, tz).onAir;

  /** Short description of an entry's timing, e.g. "18:00–20:00 Mon–Fri · until 22 Oct 20:00", or '' if none. */
  function describe(e, now = Date.now()) {
    const parts = [];
    if (e.repeat) parts.push(e.repeat.from === e.repeat.to ? `all day ${daysText(e.repeat.days)}` : `${e.repeat.from}–${e.repeat.to} ${daysText(e.repeat.days)}`);
    if (e.startsAt && now < e.startsAt) parts.push(`from ${fmtWhen(e.startsAt, now)}`);
    if (e.expiresAt) parts.push(`until ${fmtWhen(e.expiresAt, now)}`);
    return parts.join(' · ');
  }

  // Validate a repeat rule coming from a client; returns a clean copy or null.
  function cleanRepeat(r) {
    if (!r || typeof r !== 'object') return null;
    const hhmm = (v) => (/^\d{1,2}:\d{2}$/.test(v || '') ? String(v).padStart(5, '0') : null);
    const from = hhmm(r.from), to = hhmm(r.to);
    if (!from || !to) return null;
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => d >= 0 && d <= 6))];
    return { from, to, days: days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
  }

  const api = { status, isOnAir, describe, inWindow, wallClock, cleanRepeat, DAY_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.schedule = api;
})(this);
