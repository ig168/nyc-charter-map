'use strict';

/**
 * Security headers. The CSP allows only what the app needs: its own files, Google Identity
 * Services for sign-in, OpenStreetMap tiles, Esri satellite imagery and Google profile photos. Leaflet is self-hosted.
 */
function securityHeaders({ secure }) {
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' https://accounts.google.com/gsi/style",
    "img-src 'self' data: https://tile.openstreetmap.org https://server.arcgisonline.com https://lh3.googleusercontent.com",
    "connect-src 'self' https://accounts.google.com/gsi/",
    'frame-src https://accounts.google.com/gsi/',
    "font-src 'self'",
    "manifest-src 'self'",
  ];
  if (secure) csp.push('upgrade-insecure-requests');
  const headers = {
    'Content-Security-Policy': csp.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', // Google's sign-in popup
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function applySecurityHeaders(res, opts) {
  for (const [k, v] of Object.entries(securityHeaders(opts))) res.setHeader(k, v);
}

/** Fixed-window per-key rate limiter kept in memory. */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.prune(), windowMs).unref();
  }
  check(key) {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || t >= e.reset) {
      e = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    return { allowed: e.count <= this.max, retryAfter: Math.ceil((e.reset - t) / 1000) };
  }
  prune() {
    const t = Date.now();
    for (const [k, v] of this.hits) if (t >= v.reset) this.hits.delete(k);
  }
  stop() {
    clearInterval(this.timer);
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * CSRF defence for state-changing requests: Origin (or Referer) must match our host and the
 * request must carry a custom header that cross-site forms cannot send.
 */
function isSameOriginRequest(req, trustProxy) {
  if (req.headers['x-requested-with'] !== 'fetch') return false;
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  const source = req.headers.origin || req.headers.referer;
  if (!source || !host) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}

module.exports = { securityHeaders, applySecurityHeaders, RateLimiter, clientIp, isSameOriginRequest };
