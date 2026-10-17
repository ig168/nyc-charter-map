'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest)|image\/svg)/;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || out[k] !== undefined) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly !== false) c += '; HttpOnly';
  c += `; SameSite=${opts.sameSite || 'Lax'}`;
  if (opts.secure) c += '; Secure';
  return c;
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

function send(req, res, status, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { 'Content-Length': buf.length, ...headers };
  if (buf.length > 1024 && acceptsGzip(req) && COMPRESSIBLE.test(String(h['Content-Type'] || ''))) {
    buf = zlib.gzipSync(buf, { level: 6 });
    h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = buf.length;
    h.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, body, { cache = 'no-store', etag } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache };
  if (etag) {
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache });
      return res.end();
    }
  }
  send(req, res, status, JSON.stringify(body), headers);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** Read a JSON request body with a hard size limit. */
function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      req.resume();
      return reject(new HttpError(415, 'Expected application/json', 'unsupported_media_type'));
    }
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return; // keep draining so we can still send a 413 response
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large', 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

/** Static files, cached in memory with pre-gzipped copies and ETags. */
function createStatic(root) {
  const cache = new Map();
  const base = path.resolve(root) + path.sep;
  return function serve(req, res, urlPath, { maxAge = 3600 } = {}) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(base)) return false;
    let entry = cache.get(file);
    if (!entry) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
      const body = fs.readFileSync(file);
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      entry = {
        body,
        gz: COMPRESSIBLE.test(type) && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null,
        type,
        etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`,
      };
      if (process.env.NODE_ENV === 'production') cache.set(file, entry);
    }
    const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': `public, max-age=${maxAge}`, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let body = entry.body;
    if (entry.gz && acceptsGzip(req)) {
      body = entry.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

function sendHtmlFile(req, res, file, status = 200) {
  send(req, res, status, fs.readFileSync(file), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
}

module.exports = { HttpError, parseCookies, serializeCookie, appendCookie, send, sendJson, redirect, readJson, createStatic, sendHtmlFile };
