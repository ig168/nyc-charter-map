'use strict';
// Local stand-ins used only by the e2e harness:
//  /certs  – a JWKS like https://www.googleapis.com/oauth2/v3/certs
//  /mint   – issues an RS256 Google-style ID token for the given nonce (what Google would return)
//  /geo    – a NYC Planning GeoSearch-shaped response
const http = require('node:http');
const crypto = require('node:crypto');
const port = Number(process.argv[2] || 4011);
const aud = process.argv[3] || 'e2e-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/certs') return json({ keys: [jwk] });
  if (u.pathname === '/mint') {
    const n = Math.floor(Date.now() / 1000);
    const who = (u.searchParams.get('u') || '1').replace(/[^a-z0-9]/gi, '').slice(0, 20) || '1';
    const claims = { iss: 'https://accounts.google.com', aud, sub: `e2e-${who}`, email: `parent.${who}@example.com`, email_verified: true,
      name: `Test Parent ${who}`, iat: n, exp: n + 3600, nonce: u.searchParams.get('nonce') || '' };
    const head = b64({ alg: 'RS256', kid: 'e2e', typ: 'JWT' });
    const body = b64(claims);
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return json({ credential: `${head}.${body}.${sig}` });
  }
  if (u.pathname === '/geo') {
    const q = (u.searchParams.get('text') || '').toLowerCase();
    if (q.includes('nowhere')) return json({ features: [] });
    // a few fixed places in different community school districts (search upgrade SX-08)
    const PLACES = [
      [/frederick douglass|125th|adam clayton/, [-73.9465, 40.8116], '2090 ADAM CLAYTON POWELL JR BOULEVARD, Manhattan, New York, NY, USA'], // CSD 5
      [/bedford ave|williamsburg/, [-73.9573, 40.7144], '200 BEDFORD AVENUE, Brooklyn, New York, NY, USA'], // CSD 14
      [/tottenville|hylan/, [-74.2405, 40.5115], '7000 HYLAN BOULEVARD, Staten Island, New York, NY, USA'], // CSD 31, few schools nearby
    ];
    for (const [re, c, label] of PLACES) if (re.test(q)) return json({ features: [{ geometry: { coordinates: c }, properties: { label } }] });
    return json({ features: [{ geometry: { coordinates: [-73.9857, 40.7484] }, properties: { label: '350 5 AVENUE, Manhattan, New York, NY, USA' } }] });
  }
  json({ error: 'not found' }, 404);
}).listen(port, '127.0.0.1', () => console.log(`stubs on ${port}`));
