'use strict';

// SEC-01 … SEC-06, AUTH-01, AUTH-02 (API level)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startApp, client, signToken, googleClaims } = require('./helpers');

let app;
test.before(async () => {
  app = await startApp();
});
test.after(() => app.close());

test('AUTH-02 browsing works signed out; only saving needs an account', async () => {
  const c = client(app.base);
  assert.equal((await c.get('/')).status, 200);
  const list = await c.get('/api/schools');
  assert.equal(list.status, 200);
  assert.ok(list.json.schools.length >= 40);
  assert.equal((await c.get(`/api/schools/${list.json.schools[0].id}`)).status, 200);
  assert.deepEqual((await c.get('/api/me')).json, { user: null });
  assert.equal((await c.get('/api/saved')).status, 401);
  assert.equal((await c.put('/api/saved/k-kipp-amp-elementary-school')).status, 401);
  assert.equal((await c.get('/api/saved.ics')).status, 401);
});

test('SEC-01 valid Google token creates a session', async () => {
  const c = client(app.base);
  const { res } = await c.googleLogin();
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'parent@example.com');
  assert.ok(c.jar.has('ncs_sid'));
});

test('SEC-01 forged, expired, wrong-audience and replayed tokens are rejected with 401', async () => {
  const c = client(app.base);
  const cfg = async () => (await c.get('/auth/config')).json.nonce;

  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const forged = signToken(googleClaims({ nonce: await cfg() }), { key: other });
  assert.equal((await c.post('/auth/google', { credential: forged })).status, 401, 'forged signature');

  const [h, , sig] = signToken(googleClaims({ nonce: await cfg() })).split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify(googleClaims({ email: 'admin@example.com' }))).toString('base64url')}.${sig}`;
  assert.equal((await c.post('/auth/google', { credential: tampered })).status, 401, 'tampered payload');

  const now = Math.floor(Date.now() / 1000);
  const expired = signToken(googleClaims({ nonce: await cfg(), iat: now - 7200, exp: now - 3600 }));
  assert.equal((await c.post('/auth/google', { credential: expired })).status, 401, 'expired');

  const wrongAud = signToken(googleClaims({ nonce: await cfg(), aud: 'someone-else.apps.googleusercontent.com' }));
  assert.equal((await c.post('/auth/google', { credential: wrongAud })).status, 401, 'wrong audience');

  const badIss = signToken(googleClaims({ nonce: await cfg(), iss: 'https://evil.example' }));
  assert.equal((await c.post('/auth/google', { credential: badIss })).status, 401, 'wrong issuer');

  // Replay: the exact same token + nonce cookie used a second time
  const nonce = await cfg();
  const token = signToken(googleClaims({ nonce }));
  const nonceCookie = c.jar.get('ncs_nonce');
  assert.equal((await c.post('/auth/google', { credential: token })).status, 200, 'first use works');
  c.jar.set('ncs_nonce', nonceCookie);
  assert.equal((await c.post('/auth/google', { credential: token })).status, 401, 'replay rejected');

  // A token minted for a different browser's nonce is rejected
  const c2 = client(app.base);
  await c2.get('/auth/config');
  assert.equal((await c2.post('/auth/google', { credential: signToken(googleClaims({ nonce: 'not-this-browser' })) })).status, 401, 'nonce mismatch');

  assert.equal((await c2.post('/auth/google', { credential: 'garbage' })).status, 401);
});

test('AUTH-01 session survives a refresh, sign-out ends it, tampered cookie is rejected', async () => {
  const c = client(app.base);
  await c.googleLogin();
  assert.equal((await c.get('/api/me')).json.user.name, 'Maria Lopez');
  assert.equal((await c.get('/api/me')).json.user.name, 'Maria Lopez', 'still signed in on reload');
  const sid = c.jar.get('ncs_sid');
  const bad = client(app.base);
  bad.jar.set('ncs_sid', sid.slice(0, -2) + (sid.endsWith('A') ? 'BB' : 'AA'));
  assert.equal((await bad.get('/api/me')).json.user, null, 'tampered cookie');
  assert.equal((await c.post('/auth/logout')).status, 200);
  const replayOld = client(app.base);
  replayOld.jar.set('ncs_sid', sid);
  assert.equal((await replayOld.get('/api/me')).json.user, null, 'session destroyed server-side');
  assert.equal((await replayOld.get('/api/saved')).status, 401);
});

test('SEC-02 cookie flags, id rotation at login, idle expiry', async () => {
  const c = client(app.base);
  await c.get('/auth/config');
  const first = await c.devLogin('rot');
  const cookie = first.setCookie.find((x) => x.startsWith('ncs_sid='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const id1 = c.jar.get('ncs_sid');
  await c.devLogin('rot');
  const id2 = c.jar.get('ncs_sid');
  assert.notEqual(id1, id2, 'session id changes at login');
  const old = client(app.base);
  old.jar.set('ncs_sid', id1);
  assert.equal((await old.get('/api/me')).json.user, null, 'old id no longer valid');

  // Secure flag in production
  const prod = await startApp({ NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(48), DEV_LOGIN: 'false' });
  const pc = client(prod.base);
  const { res } = await pc.googleLogin();
  assert.match(res.setCookie.find((x) => x.startsWith('ncs_sid=')), /; Secure/);
  assert.match(String(res.headers.get('strict-transport-security')), /max-age=31536000/);
  assert.equal((await pc.post('/auth/dev')).status, 404, 'dev login disabled in production');
  await prod.close();

  // Idle timeout (≈1 second for the test)
  const short = await startApp({ SESSION_IDLE_HOURS: String(0.8 / 3600) });
  const sc = client(short.base);
  await sc.devLogin('idle');
  assert.ok((await sc.get('/api/me')).json.user);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal((await sc.get('/api/me')).json.user, null, 'expired after inactivity');
  await short.close();
});

test('SEC-03 per-user isolation: A cannot read or change B’s saved schools', async () => {
  const a = client(app.base);
  const b = client(app.base);
  await a.devLogin('alice');
  await b.devLogin('bob');
  await a.put('/api/saved/k-kipp-amp-elementary-school', { source: 'list' });
  await a.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'applied', note: 'Alice private note' });
  assert.deepEqual((await b.get('/api/saved')).json.saved, [], 'B sees nothing of A');
  assert.equal((await b.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'declined' })).status, 404, 'B cannot edit A’s row');
  await b.del('/api/saved/k-kipp-amp-elementary-school', { source: 'list' });
  const mine = (await a.get('/api/saved')).json.saved;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'applied');
  assert.equal(mine[0].note, 'Alice private note');
  // There is no way to address another user: user ids are never accepted from the client
  const r = await b.get('/api/saved?user_id=1');
  assert.deepEqual(r.json.saved, []);
  assert.equal((await client(app.base).get('/api/saved')).status, 401);
});

test('SEC-04 inputs validated, queries parameterized', async () => {
  const c = client(app.base);
  await c.devLogin('val');
  for (const bad of ['abc', 'k_kipp', 'z-kipp', 'k-', "k-kipp-amp-elementary-school'--", 'k-kipp-amp-elementary-school%3BDROP%20TABLE%20schools', '%3Cscript%3E']) {
    assert.equal((await c.get(`/api/schools/${bad}`)).status, 400, bad);
    assert.equal((await c.put(`/api/saved/${bad}`)).status, 400, bad);
  }
  assert.equal((await c.put('/api/saved/k-no-such-school')).status, 404, 'well-formed but unknown id');
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'hacked' })).status, 400, 'invalid status rejected');
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'applied' })).status, 404, 'not saved yet');
  await c.put('/api/saved/k-kipp-amp-elementary-school');
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: "applied'; DROP TABLE users;--" })).status, 400);
  const evil = `<img src=x onerror=alert(1)> '); DROP TABLE saved_schools; --`;
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: evil })).status, 200);
  assert.equal((await c.get('/api/saved')).json.saved[0].note, evil, 'stored verbatim, not executed');
  assert.ok(app.store.schoolSummaries().schools.length >= 40, 'tables intact');
  // No SQL string building anywhere in the server code
  const src = fs.readdirSync(path.join(__dirname, '..', 'src')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /(prepare|exec|st)\(\s*`[^`]*\$\{/, 'no template-literal SQL with interpolation');
  assert.equal((await c.post('/api/events', { name: 'search_performed' }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  const big = await fetch(`${app.base}/api/events`, { method: 'POST', headers: { Origin: app.base, 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
});

test('SEC-05 CSRF protection, security headers, rate limits', async () => {
  const c = client(app.base);
  await c.devLogin('csrf');
  // Cross-origin POST (a forged form from another site) is blocked
  assert.equal((await c.put('/api/saved/k-kipp-amp-elementary-school', {}, { sameOrigin: false, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.put('/api/saved/k-kipp-amp-elementary-school', {}, { sameOrigin: false })).status, 403, 'missing custom header');
  assert.equal((await c.post('/auth/logout', {}, { sameOrigin: false, headers: { Origin: 'https://evil.example', 'X-Requested-With': 'fetch' } })).status, 403);
  const page = await c.get('/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(page.headers.get('referrer-policy'));
  assert.ok(page.headers.get('permissions-policy'));
  // Burst of 50 sign-in requests -> rate limited
  const burst = await startApp({ AUTH_RATE_LIMIT: '20' });
  const statuses = [];
  for (let i = 0; i < 50; i++) statuses.push((await fetch(`${burst.base}/auth/config`)).status);
  assert.ok(statuses.includes(429), 'auth burst gets 429');
  assert.equal(statuses.filter((s) => s === 200).length, 20);
  await burst.close();
});

test('SEC-06 no secrets in repo, minimal user data, no PII in URLs or logs', async () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'vendor'].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|json|html|css|md|yaml|yml|example|toml|txt|py)$|Dockerfile$/.test(f.name)) files.push(p);
    }
  };
  walk(root);
  assert.ok(!fs.existsSync(path.join(root, '.env')) || fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.env'), '.env is git-ignored');
  const secretPatterns = [/AIza[0-9A-Za-z_-]{30,}/, /GOCSPX-[0-9A-Za-z_-]{10,}/, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, /sk_live_[0-9a-zA-Z]{10,}/, /"client_secret"\s*:/, /SESSION_SECRET=[^\s]{16,}/];
  for (const f of files) {
    if (f.includes(`${path.sep}test${path.sep}`)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const re of secretPatterns) assert.doesNotMatch(text, re, `${path.relative(root, f)} looks like it contains a secret`);
  }
  // Only name, email and photo are stored from Google
  const cols = app.store.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).sort();
  assert.deepEqual(cols, ['created_at', 'email', 'google_sub', 'id', 'name', 'photo_url', 'share_token']);
  // Logs: capture console during a full sign-in + save flow; no email may appear
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    const c = client(app.base);
    await c.googleLogin({ sub: '555', email: 'private.parent@example.com' });
    await c.put('/api/saved/k-kipp-amp-elementary-school');
    await c.post('/auth/google', { credential: 'bad' });
    await c.get('/api/schools/NOPE');
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!lines.join('\n').includes('private.parent@example.com'), 'no email in logs');
  // Share links use a random token, never an email or user id
  const c = client(app.base);
  await c.googleLogin({ sub: '556', email: 'share.parent@example.com' });
  const share = await c.post('/api/share');
  assert.match(share.json.path, /^\/s\/[A-Za-z0-9_-]{32}$/);
});
