'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { HttpError, parseCookies, serializeCookie, appendCookie, send, sendJson, readJson, createStatic, sendHtmlFile } = require('./http');
const { applySecurityHeaders, RateLimiter, clientIp, isSameOriginRequest } = require('./security');
const { SessionStore, COOKIE_NAME, NONCE_COOKIE, NONCE_TTL_MS } = require('./session');
const { verifyGoogleIdToken, isAllowed, TokenError } = require('./google');
const { Store } = require('./db');
const { createGeocoder, GeocodeError } = require('./geocode');
const { CLIENT_EVENTS, SESSION_ID, SOURCES, validateEvent } = require('./events');
const { buildIcs } = require('./ics');
const { SCHOOL_ID, STATUSES } = require('./nyc');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VIEWS_DIR = path.join(ROOT, 'views');
const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const NOTE_MAX = 2000;
const TRIGGERS = ['save', 'my_schools', 'header'];

/**
 * Builds the HTTP server. `deps` lets tests inject a store, a token verifier, Google keys and a geocoder.
 */
function createApp(config, deps = {}) {
  const store = deps.store || new Store(config.dbPath);
  if (!deps.store) {
    const seed = store.loadSeed(config.seedPath);
    if (config.production || process.env.NODE_ENV !== 'test') console.log(`  Seed ${seed.version}: ${seed.count} schools loaded`);
  }
  const sessions = new SessionStore({ secret: config.sessionSecret, idleMs: config.sessionIdleMs, absoluteMs: config.sessionAbsoluteMs });
  let getKeys = deps.googleKeys;
  if (!getKeys && config.googleJwksUrl) {
    const { fetchGoogleKeys } = require('./google');
    getKeys = (o = {}) => fetchGoogleKeys({ ...o, force: true, url: config.googleJwksUrl });
  }
  const verifyToken = deps.verifyToken || ((token, opts) => verifyGoogleIdToken(token, getKeys ? { ...opts, getKeys } : opts));
  const geocode = deps.geocode || createGeocoder({ store, offline: config.offline, baseUrl: config.geocoderUrl });
  const serveStatic = createStatic(PUBLIC_DIR);

  const limits = {
    auth: new RateLimiter({ windowMs: 60_000, max: config.authRateLimit }),
    api: new RateLimiter({ windowMs: 60_000, max: 300 }),
    events: new RateLimiter({ windowMs: 60_000, max: 120 }),
    geocode: new RateLimiter({ windowMs: 60_000, max: 30 }),
  };
  const cookieOpts = { secure: config.cookieSecure, sameSite: 'Lax' };

  // ---- helpers ------------------------------------------------------------------
  function currentSession(req) {
    return sessions.get(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }
  function currentUser(req) {
    const s = currentSession(req);
    if (!s) return null;
    const u = store.getUser(s.userId);
    return u ? { ...u, sessionId: s.id } : null;
  }
  function requireUser(req) {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in', 'unauthenticated');
    return u;
  }
  function requireSameOrigin(req) {
    if (!isSameOriginRequest(req, config.trustProxy)) throw new HttpError(403, 'Cross-site request blocked', 'csrf');
  }
  function rateLimit(limiter, req, res) {
    const r = limiter.check(clientIp(req, config.trustProxy));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfter));
      throw new HttpError(429, 'Too many requests — please wait a moment and try again.', 'rate_limited');
    }
  }
  function schoolIdFrom(raw) {
    let id;
    try {
      id = decodeURIComponent(raw).toLowerCase();
    } catch {
      throw new HttpError(400, 'Invalid school id', 'bad_id');
    }
    if (!SCHOOL_ID.test(id)) throw new HttpError(400, 'Invalid school id', 'bad_id');
    return id;
  }
  function analyticsSession(req, body) {
    const sid = body && typeof body.session_id === 'string' && SESSION_ID.test(body.session_id) ? body.session_id : null;
    return sid || 'server';
  }
  function record(name, props, { req, body, userId = null } = {}) {
    if (validateEvent(name, props)) return; // never store malformed events
    try {
      store.addEvent({ userId, sessionId: analyticsSession(req, body), name, props });
    } catch (e) {
      console.error('[events] could not record event:', e.message);
    }
  }
  function startSession(req, res, userId) {
    const existing = currentSession(req);
    if (existing) sessions.destroy(existing.id); // new id at every login (prevents session fixation)
    const { cookieValue } = sessions.create(userId);
    appendCookie(res, serializeCookie(COOKIE_NAME, cookieValue, { ...cookieOpts, maxAge: config.sessionAbsoluteMs / 1000 }));
    appendCookie(res, serializeCookie(NONCE_COOKIE, '', { ...cookieOpts, maxAge: 0 }));
  }
  const publicUser = (u) => ({ name: u.name || u.email.split('@')[0], email: u.email, picture: u.photo_url || null });
  const savedPayload = (userId) => ({ saved: store.listSaved(userId) });

  // ---- request handler ----------------------------------------------------------
  async function handle(req, res) {
    applySecurityHeaders(res, { secure: config.cookieSecure });
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/healthz') return sendJson(req, res, 200, { ok: true });

    // Static assets (contain no user data)
    if (isRead && /^\/(app|css|js|vendor|img)\//.test(pathname)) {
      const long = /^\/vendor\//.test(pathname) ? 86400 * 30 : 300;
      if (serveStatic(req, res, pathname, { maxAge: long })) return;
      throw new HttpError(404, 'Not found', 'not_found');
    }
    if (isRead && (pathname === '/favicon.svg' || pathname === '/manifest.webmanifest')) {
      if (serveStatic(req, res, pathname, { maxAge: 86400 })) return;
    }

    // Pages — browsing is open to everyone (AUTH-02)
    if (isRead && pathname === '/') return sendHtmlFile(req, res, path.join(VIEWS_DIR, 'app.html'));
    if (isRead && pathname === '/login') {
      res.writeHead(302, { Location: '/#signin', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (isRead && /^\/s\/[A-Za-z0-9_-]+$/.test(pathname)) return sendHtmlFile(req, res, path.join(VIEWS_DIR, 'share.html'));

    // ---- Auth ---------------------------------------------------------------------
    if (pathname.startsWith('/auth/')) {
      rateLimit(limits.auth, req, res);

      if (isRead && pathname === '/auth/config') {
        const { nonce, cookieValue } = sessions.issueNonce();
        appendCookie(res, serializeCookie(NONCE_COOKIE, cookieValue, { ...cookieOpts, maxAge: NONCE_TTL_MS / 1000 }));
        return sendJson(req, res, 200, { googleClientId: config.googleClientId || null, devLogin: config.devLogin, nonce });
      }

      if (method === 'POST' && pathname === '/auth/google') {
        requireSameOrigin(req);
        const body = await readJson(req);
        const nonce = sessions.readNonce(parseCookies(req.headers.cookie)[NONCE_COOKIE]);
        let claims;
        try {
          claims = await verifyToken(body.credential, { clientId: config.googleClientId, nonce });
        } catch (err) {
          if (err instanceof TokenError) throw new HttpError(401, err.message, 'invalid_token');
          throw err;
        }
        sessions.consumeNonce(nonce); // a token can only be used once
        if (!isAllowed(claims, config)) throw new HttpError(403, 'This Google account is not allowed to use this app.', 'not_allowed');
        const user = store.upsertUser({ sub: `google:${claims.sub}`, email: claims.email, name: claims.name, picture: claims.picture });
        startSession(req, res, user.id);
        record('login_completed', { trigger: TRIGGERS.includes(body.trigger) ? body.trigger : 'header' }, { req, body, userId: user.id });
        return sendJson(req, res, 200, { user: publicUser(user) });
      }

      if (method === 'POST' && pathname === '/auth/dev') {
        if (!config.devLogin) throw new HttpError(404, 'Not found', 'not_found');
        requireSameOrigin(req);
        const body = await readJson(req);
        const who = typeof body.as === 'string' && /^[a-z0-9]{1,20}$/.test(body.as) ? body.as : 'local';
        const user = store.upsertUser({ sub: `dev:${who}`, email: `${who}@dev.localhost`, name: who === 'local' ? 'Local Developer' : `Dev ${who}`, picture: null });
        startSession(req, res, user.id);
        record('login_completed', { trigger: TRIGGERS.includes(body.trigger) ? body.trigger : 'header' }, { req, body, userId: user.id });
        return sendJson(req, res, 200, { user: publicUser(user) });
      }

      if (method === 'POST' && pathname === '/auth/logout') {
        requireSameOrigin(req);
        const s = currentSession(req);
        if (s) sessions.destroy(s.id);
        appendCookie(res, serializeCookie(COOKIE_NAME, '', { ...cookieOpts, maxAge: 0 }));
        return sendJson(req, res, 200, { ok: true });
      }
      throw new HttpError(404, 'Not found', 'not_found');
    }

    // ---- API ----------------------------------------------------------------------
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/events') rateLimit(limits.events, req, res);
      else if (pathname === '/api/geocode') rateLimit(limits.geocode, req, res);
      else rateLimit(limits.api, req, res);
      if (!isRead) requireSameOrigin(req);

      // Public
      if (isRead && pathname === '/api/me') {
        const u = currentUser(req);
        return sendJson(req, res, 200, { user: u ? publicUser(u) : null });
      }
      if (isRead && pathname === '/api/schools') {
        const { meta, schools } = store.schoolSummaries();
        return sendJson(req, res, 200, { meta: { ...meta, count: schools.length }, schools }, { cache: 'no-cache', etag: `"s-${meta.hash}"` });
      }
      const detail = /^\/api\/schools\/([^/]+)$/.exec(pathname);
      if (isRead && detail) {
        const s = store.schoolDetail(schoolIdFrom(detail[1]));
        if (!s) throw new HttpError(404, 'School not found', 'not_found');
        return sendJson(req, res, 200, { school: s }, { cache: 'no-cache', etag: `"d-${store.meta().hash}-${s.id}"` });
      }
      if (isRead && pathname === '/api/geocode') {
        try {
          return sendJson(req, res, 200, { result: await geocode(url.searchParams.get('q')) });
        } catch (e) {
          if (e instanceof GeocodeError) throw new HttpError(e.status, e.message, 'geocode');
          throw e;
        }
      }
      if (method === 'POST' && pathname === '/api/events') {
        const body = await readJson(req, 4096);
        if (!CLIENT_EVENTS.has(body.name)) throw new HttpError(400, 'Unknown event', 'bad_event');
        const problem = validateEvent(body.name, body.props);
        if (problem) throw new HttpError(400, problem, 'bad_event');
        if (!SESSION_ID.test(String(body.session_id || ''))) throw new HttpError(400, 'Invalid session_id', 'bad_event');
        const u = currentUser(req);
        record(body.name, body.props, { req, body, userId: u ? u.id : null });
        return send(req, res, 204, '');
      }
      const share = /^\/api\/share\/([^/]+)$/.exec(pathname);
      if (isRead && share) {
        const token = share[1];
        const owner = SHARE_TOKEN.test(token) ? store.userIdForShareToken(token) : null;
        if (!owner) throw new HttpError(404, 'This shared list does not exist or was turned off.', 'not_found');
        const { schools } = store.schoolSummaries();
        const byId = new Map(schools.map((s) => [s.id, s]));
        // Read-only and anonymous: no name, email, or private notes.
        const list = store.listSaved(owner).map((r) => ({ ...byId.get(r.schoolId), status: r.status }));
        return sendJson(req, res, 200, { schools: list, meta: store.meta() });
      }

      // Signed-in only — every query is scoped to the session's user (SEC-03)
      if (isRead && pathname === '/api/saved') return sendJson(req, res, 200, savedPayload(requireUser(req).id));

      if (isRead && pathname === '/api/saved.ics') {
        const user = requireUser(req);
        const { schools } = store.schoolSummaries();
        const byId = new Map(schools.map((s) => [s.id, s]));
        const items = store.listSaved(user.id).map((r) => {
          const d = store.schoolDetail(r.schoolId);
          return { ...byId.get(r.schoolId), applyUrl: d && d.admissions.applyUrl };
        });
        return send(req, res, 200, buildIcs(items), {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="charter-school-deadlines.ics"',
          'Cache-Control': 'no-store',
        });
      }

      const saved = /^\/api\/saved\/([^/]+)$/.exec(pathname);
      if (saved && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
        const user = requireUser(req);
        const id = schoolIdFrom(saved[1]);
        if (!store.hasSchool(id)) throw new HttpError(404, 'School not found', 'not_found');
        const body = await readJson(req);
        const source = SOURCES.includes(body.source) ? body.source : 'detail';

        if (method === 'PUT') {
          if (store.addSaved(user.id, id)) record('favorite_added', { school_id: id, source }, { req, body, userId: user.id });
          return sendJson(req, res, 200, savedPayload(user.id));
        }
        if (method === 'DELETE') {
          if (store.removeSaved(user.id, id)) record('favorite_removed', { school_id: id, source }, { req, body, userId: user.id });
          return sendJson(req, res, 200, savedPayload(user.id));
        }
        // PATCH: tracker fields
        const patch = {};
        if (body.status !== undefined) {
          if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status', 'bad_status');
          patch.status = body.status;
        }
        if (body.note !== undefined) {
          if (typeof body.note !== 'string') throw new HttpError(400, 'Note must be text', 'bad_note');
          const note = body.note.replace(/\r\n/g, '\n');
          if ([...note].length > NOTE_MAX) throw new HttpError(400, `Notes can be up to ${NOTE_MAX.toLocaleString('en-US')} characters.`, 'note_too_long');
          patch.note = note;
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to update', 'empty_patch');
        const r = store.updateSaved(user.id, id, patch);
        if (!r) throw new HttpError(404, 'Save this school first', 'not_saved');
        if (patch.status && r.before.status !== r.after.status) {
          record('application_status_changed', { school_id: id, from: r.before.status, to: r.after.status }, { req, body, userId: user.id });
        }
        return sendJson(req, res, 200, { item: r.after, ...savedPayload(user.id) });
      }

      if (pathname === '/api/share' && (method === 'POST' || method === 'DELETE')) {
        const user = requireUser(req);
        if (method === 'DELETE') {
          store.setShareToken(user.id, null);
          return sendJson(req, res, 200, { token: null });
        }
        let token = store.getShareToken(user.id);
        if (!token) {
          token = crypto.randomBytes(24).toString('base64url');
          store.setShareToken(user.id, token);
        }
        return sendJson(req, res, 200, { token, path: `/s/${token}` });
      }
      if (isRead && pathname === '/api/share') {
        const token = store.getShareToken(requireUser(req).id);
        return sendJson(req, res, 200, { token, path: token ? `/s/${token}` : null });
      }

      throw new HttpError(404, 'Not found', 'not_found');
    }

    throw new HttpError(404, 'Not found', 'not_found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status || 500;
      const expected = err instanceof HttpError;
      if (!expected) console.error('[server]', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
      if (res.headersSent) return res.end();
      const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
      if (wantsHtml && status === 404) return sendHtmlFile(req, res, path.join(VIEWS_DIR, '404.html'), 404);
      sendJson(req, res, status, { error: err.code || 'server_error', message: expected ? err.message : 'Something went wrong on our side.' });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('close', () => {
    sessions.stop();
    Object.values(limits).forEach((l) => l.stop());
    if (!deps.store) store.close();
  });
  server.store = store;
  server.sessions = sessions;
  return server;
}

module.exports = { createApp };
