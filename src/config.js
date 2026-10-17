'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Minimal .env loader (KEY=VALUE per line, # comments, optional quotes). Real env vars win. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

function buildConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let sessionSecret = env.SESSION_SECRET || '';
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production (see .env.example).');
    sessionSecret = crypto.randomBytes(48).toString('base64url');
    if (env.NODE_ENV !== 'test') console.warn('[config] SESSION_SECRET not set — using a random one (sessions reset on restart).');
  } else if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }
  const root = path.join(__dirname, '..');
  const dataDir = env.DATA_DIR || path.join(root, 'data');

  return {
    production,
    port: Number(env.PORT ?? 3000),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: bool(env.TRUST_PROXY),
    cookieSecure: production || bool(env.COOKIE_SECURE),
    googleClientId: env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_ID.startsWith('your-') ? env.GOOGLE_CLIENT_ID : '',
    sessionSecret,
    sessionIdleMs: Number(env.SESSION_IDLE_HOURS || 12) * 3600_000,
    sessionAbsoluteMs: Number(env.SESSION_MAX_DAYS || 7) * 24 * 3600_000,
    allowedEmails: list(env.ALLOWED_EMAILS),
    allowedDomains: list(env.ALLOWED_DOMAINS),
    devLogin: bool(env.DEV_LOGIN) && !production,
    dbPath: env.DB_PATH || path.join(dataDir, 'app.db'),
    seedPath: env.SEED_PATH || path.join(root, 'data', 'seed', 'schools.json'),
    offline: bool(env.OFFLINE),
    authRateLimit: Math.max(1, Number(env.AUTH_RATE_LIMIT || 20)),
    geocoderUrl: env.GEOCODER_URL || 'https://geosearch.planninglabs.nyc/v2/search',
    // Test-only: verify Google tokens against a local key server. Ignored in production.
    googleJwksUrl: !production && env.GOOGLE_JWKS_URL ? env.GOOGLE_JWKS_URL : null,
  };
}

module.exports = { loadDotEnv, buildConfig };
