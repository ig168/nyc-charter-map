'use strict';

const crypto = require('node:crypto');
const { buildConfig } = require('../src/config');
const { createApp } = require('../src/app');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function signToken(claims, { key = privateKey, kid = 'test-key' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function googleClaims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1000001',
    email: 'parent@example.com',
    email_verified: true,
    name: 'Maria Lopez',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

async function startApp(env = {}, deps = {}) {
  const config = buildConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(48),
    GOOGLE_CLIENT_ID: CLIENT_ID,
    DEV_LOGIN: 'true',
    OFFLINE: 'true',
    DB_PATH: ':memory:',
    AUTH_RATE_LIMIT: '100000',
    ...env,
  });
  const server = createApp(config, { googleKeys: async () => [JWK], ...deps });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store: server.store, config, close: () => new Promise((r) => server.close(r)) };
}

/** A tiny cookie-keeping client that behaves like one browser. */
function client(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { body, headers = {}, sameOrigin = method !== 'GET' } = {}) {
    const h = { ...headers };
    if (jar.size) h.Cookie = cookieHeader();
    if (sameOrigin) {
      h.Origin = base;
      h['X-Requested-With'] = 'fetch';
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c) || v === '') jar.delete(k);
      else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json, text, setCookie: res.headers.getSetCookie() };
  }
  return {
    jar,
    get: (p, o) => req('GET', p, o),
    post: (p, body, o) => req('POST', p, { body: body ?? {}, ...o }),
    put: (p, body, o) => req('PUT', p, { body: body ?? {}, ...o }),
    patch: (p, body, o) => req('PATCH', p, { body: body ?? {}, ...o }),
    del: (p, body, o) => req('DELETE', p, { body: body ?? {}, ...o }),
    async devLogin(as = 'local', trigger = 'header') {
      return req('POST', '/auth/dev', { body: { as, trigger } });
    },
    async googleLogin(claimsOver = {}, { trigger = 'save' } = {}) {
      const cfg = await req('GET', '/auth/config');
      const token = signToken(googleClaims({ nonce: cfg.json.nonce, ...claimsOver }));
      const res = await req('POST', '/auth/google', { body: { credential: token, trigger } });
      return { res, token, nonce: cfg.json.nonce };
    },
  };
}

module.exports = { startApp, client, signToken, googleClaims, CLIENT_ID, JWK };
