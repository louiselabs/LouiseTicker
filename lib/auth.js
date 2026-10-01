'use strict';
// Accounts and sessions: scrypt password hashes, random session tokens (only their SHA-256 is stored).

const crypto = require('crypto');

const ROLES = ['admin', 'journalist'];
const SESSION_HOURS = 12;          // sliding: extended on every request
const COOKIE = 'lt_session';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(user, password) {
  if (!user || !user.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeUser({ username, name, role, password, defaultPassword = false }) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    username: String(username).trim().toLowerCase(),
    name: String(name || username).trim(),
    role: ROLES.includes(role) ? role : 'journalist',
    ...hashPassword(password),
    defaultPassword,
    disabled: false,
    createdAt: Date.now(),
    lastLogin: null,
  };
}

// First start (or data from before accounts existed): the two default accounts.
function defaultUsers() {
  return [
    makeUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'password', defaultPassword: true }),
    makeUser({ username: 'journalist', name: 'Journalist', role: 'journalist', password: 'password', defaultPassword: true }),
  ];
}

const validUsername = (u) => /^[a-z0-9._-]{2,32}$/.test(String(u || '').trim().toLowerCase());
const validPassword = (p) => typeof p === 'string' && p.length >= 6;

/** Sessions live in the data file (state.sessions: tokenHash → { userId, expires }) so they survive restarts. */
class Sessions {
  constructor(getState, save) { this.S = getState; this.save = save; }

  create(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.S().sessions[sha(token)] = { userId: user.id, expires: Date.now() + SESSION_HOURS * 3600e3, created: Date.now() };
    this.save();
    return token;
  }

  // The logged-in user for a request, or null. Extends the session while it is being used.
  userFor(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const key = sha(token);
    const s = this.S().sessions[key];
    if (!s || s.expires < Date.now()) { if (s) { delete this.S().sessions[key]; this.save(); } return null; }
    const user = this.S().users.find((u) => u.id === s.userId && !u.disabled);
    if (!user) return null;
    if (s.expires - Date.now() < (SESSION_HOURS - 1) * 3600e3) { s.expires = Date.now() + SESSION_HOURS * 3600e3; this.save(); }
    return user;
  }

  destroy(req) {
    const token = readCookie(req, COOKIE);
    if (token) { delete this.S().sessions[sha(token)]; this.save(); }
  }

  destroyForUser(userId, exceptReq) {
    const keep = exceptReq && readCookie(exceptReq, COOKIE) ? sha(readCookie(exceptReq, COOKIE)) : null;
    for (const [k, s] of Object.entries(this.S().sessions)) if (s.userId === userId && k !== keep) delete this.S().sessions[k];
    this.save();
  }

  prune() {
    const now = Date.now();
    let n = 0;
    for (const [k, s] of Object.entries(this.S().sessions)) if (s.expires < now) { delete this.S().sessions[k]; n++; }
    if (n) this.save();
  }
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const sessionCookie = (token) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

// Slow down password guessing: at most 10 failed logins per address per 10 minutes.
const failures = new Map(); // ip → [timestamps]
function tooManyFailures(ip) {
  const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < 10 * 60e3);
  failures.set(ip, recent);
  return recent.length >= 10;
}
const noteFailure = (ip) => failures.set(ip, [...(failures.get(ip) || []), Date.now()]);

// What the browser may see about a user.
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, defaultPassword: !!u.defaultPassword, disabled: !!u.disabled, createdAt: u.createdAt, lastLogin: u.lastLogin });

module.exports = {
  ROLES, Sessions, makeUser, defaultUsers, hashPassword, checkPassword, validUsername, validPassword,
  sessionCookie, clearCookie, tooManyFailures, noteFailure, publicUser,
};
