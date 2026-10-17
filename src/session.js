'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'ncs_sid';
const NONCE_COOKIE = 'ncs_nonce';
const NONCE_TTL_MS = 10 * 60_000;

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Server-side sessions. The cookie carries only a random id plus an HMAC signature; the user
 * record never leaves the server. Sessions expire after an idle period and an absolute maximum.
 */
class SessionStore {
  constructor({ secret, idleMs, absoluteMs }) {
    this.secret = secret;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.sessions = new Map();
    this.usedNonces = new Map(); // nonce -> expiry; each sign-in nonce works exactly once
    this.timer = setInterval(() => this.prune(), 5 * 60_000).unref();
  }

  create(userId) {
    const id = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    this.sessions.set(id, { id, userId, createdAt: t, lastSeen: t });
    return { id, cookieValue: `${id}.${hmac(this.secret, id)}` };
  }

  get(cookieValue) {
    if (!cookieValue || typeof cookieValue !== 'string') return null;
    const [id, sig] = cookieValue.split('.');
    if (!id || !sig || !safeEqual(sig, hmac(this.secret, id))) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = Date.now();
    if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = t;
    return s;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  prune() {
    const t = Date.now();
    for (const [id, s] of this.sessions) if (t - s.lastSeen > this.idleMs || t - s.createdAt > this.absoluteMs) this.sessions.delete(id);
    for (const [n, exp] of this.usedNonces) if (t > exp) this.usedNonces.delete(n);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** A short-lived signed nonce bound to the browser via cookie; Google echoes it in the ID token. */
  issueNonce() {
    const nonce = crypto.randomBytes(18).toString('base64url');
    const ts = Date.now().toString(36);
    return { nonce, cookieValue: `${nonce}.${ts}.${hmac(this.secret, `${nonce}.${ts}`)}` };
  }

  readNonce(cookieValue) {
    if (!cookieValue) return null;
    const [nonce, ts, sig] = String(cookieValue).split('.');
    if (!nonce || !ts || !sig) return null;
    if (!safeEqual(sig, hmac(this.secret, `${nonce}.${ts}`))) return null;
    if (Date.now() - parseInt(ts, 36) > NONCE_TTL_MS) return null;
    if (this.usedNonces.has(nonce)) return null; // replayed
    return nonce;
  }

  consumeNonce(nonce) {
    this.usedNonces.set(nonce, Date.now() + NONCE_TTL_MS);
  }
}

module.exports = { SessionStore, COOKIE_NAME, NONCE_COOKIE, NONCE_TTL_MS };
