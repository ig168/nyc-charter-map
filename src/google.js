'use strict';

/**
 * Verifies Google Identity Services ID tokens (JWT, RS256) using only node:crypto.
 * Follows https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */

const crypto = require('node:crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;

let jwksCache = { keys: null, expiresAt: 0 };

async function fetchGoogleKeys({ force = false, url = JWKS_URL } = {}) {
  if (!force && jwksCache.keys && Date.now() < jwksCache.expiresAt) return jwksCache.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Could not load Google signing keys (HTTP ${res.status})`);
  const body = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwksCache = { keys: body.keys || [], expiresAt: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return jwksCache.keys;
}

class TokenError extends Error {}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('Malformed token');
  }
}

/**
 * @param {string} token  the `credential` returned by Google Identity Services
 * @param {object} opts   { clientId, nonce, getKeys?, now? }
 * @returns {Promise<object>} verified token payload
 */
async function verifyGoogleIdToken(token, { clientId, nonce, getKeys = fetchGoogleKeys, now = Date.now() }) {
  if (!clientId) throw new TokenError('Google sign-in is not configured');
  if (typeof token !== 'string' || token.length > 8192) throw new TokenError('Missing token');

  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new TokenError('Unexpected token algorithm');

  let keys = await getKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys({ force: true }); // Google rotates keys; retry once with a fresh set
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new TokenError('Unknown signing key');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) throw new TokenError('Invalid token signature');

  const nowS = Math.floor(now / 1000);
  if (!ISSUERS.has(payload.iss)) throw new TokenError('Invalid issuer');
  if (payload.aud !== clientId) throw new TokenError('Token was issued for a different app');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) throw new TokenError('Token expired');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_S > nowS) throw new TokenError('Token issued in the future');
  if (payload.email_verified !== true) throw new TokenError('Google email is not verified');
  if (!nonce || payload.nonce !== nonce) throw new TokenError('Sign-in request expired — please try again');

  return payload;
}

/** Applies the optional ALLOWED_EMAILS / ALLOWED_DOMAINS allow-lists. */
function isAllowed(payload, { allowedEmails = [], allowedDomains = [] }) {
  if (!allowedEmails.length && !allowedDomains.length) return true;
  const email = String(payload.email || '').toLowerCase();
  if (allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  const hd = String(payload.hd || '').toLowerCase();
  return allowedDomains.some((d) => d === domain || d === hd);
}

module.exports = { verifyGoogleIdToken, isAllowed, fetchGoogleKeys, TokenError };
