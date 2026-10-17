'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyGoogleIdToken, isAllowed } = require('../src/google');

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const getKeys = async () => [jwk];

function sign(payload, { kid = 'k1', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const base = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1234567890',
  email: 'ivan@example.com',
  email_verified: true,
  name: 'Ivan',
  iat: now,
  exp: now + 3600,
  nonce: 'abc',
};
const opts = { clientId: CLIENT_ID, nonce: 'abc', getKeys };

test('accepts a valid token', async () => {
  const p = await verifyGoogleIdToken(sign(base), opts);
  assert.equal(p.email, 'ivan@example.com');
});

test('rejects wrong audience', async () => {
  await assert.rejects(verifyGoogleIdToken(sign({ ...base, aud: 'other' }), opts), /different app/);
});

test('rejects expired tokens', async () => {
  await assert.rejects(verifyGoogleIdToken(sign({ ...base, exp: now - 600 }), opts), /expired/);
});

test('rejects bad issuer', async () => {
  await assert.rejects(verifyGoogleIdToken(sign({ ...base, iss: 'evil.com' }), opts), /issuer/);
});

test('rejects nonce mismatch / missing nonce', async () => {
  await assert.rejects(verifyGoogleIdToken(sign({ ...base, nonce: 'zzz' }), opts), /expired/);
  await assert.rejects(verifyGoogleIdToken(sign(base), { ...opts, nonce: null }), /expired/);
});

test('rejects unverified email', async () => {
  await assert.rejects(verifyGoogleIdToken(sign({ ...base, email_verified: false }), opts), /not verified/);
});

test('rejects tokens signed by another key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleIdToken(sign(base, { key: other }), opts), /signature/);
});

test('rejects tampered payload', async () => {
  const [h, , s] = sign(base).split('.');
  const forged = Buffer.from(JSON.stringify({ ...base, email: 'admin@example.com' })).toString('base64url');
  await assert.rejects(verifyGoogleIdToken(`${h}.${forged}.${s}`, opts), /signature/);
});

test('rejects garbage', async () => {
  await assert.rejects(verifyGoogleIdToken('not.a.jwt', opts));
  await assert.rejects(verifyGoogleIdToken(undefined, opts));
});

test('allow-list by email and domain', () => {
  assert.equal(isAllowed({ email: 'a@x.com' }, {}), true);
  assert.equal(isAllowed({ email: 'a@x.com' }, { allowedEmails: ['a@x.com'] }), true);
  assert.equal(isAllowed({ email: 'b@x.com' }, { allowedEmails: ['a@x.com'] }), false);
  assert.equal(isAllowed({ email: 'b@corp.com' }, { allowedDomains: ['corp.com'] }), true);
  assert.equal(isAllowed({ email: 'b@evilcorp.com' }, { allowedDomains: ['corp.com'] }), false);
});
