#!/usr/bin/env node
// Decodes the delta-encoded NYC school district boundaries (data/sources/csd-deltas.json, from NYC Open Data
// "School Districts" 8ugf-3d8u, simplified ~25 m) into public/data/csd.json, then checks every campus in the
// seed lands in its listed district. Usage: node scripts/build-csd.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sources/csd-deltas.json'), 'utf8'));
const decode = (flat) => {
  const ring = [];
  let a = 0, b = 0;
  for (let i = 0; i < flat.length; i += 2) {
    a += flat[i];
    b += flat[i + 1];
    ring.push([Math.round(b) / 1e4, Math.round(a) / 1e4]); // [lng, lat]
  }
  if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0].slice());
  return ring;
};
const districts = raw.map(([d, polys]) => ({ d, polys: polys.map((poly) => poly.map(decode)) }));
// Coordinates are stored as integers in units of 1e-4 degrees (about 10 m): same precision, ~12% smaller file
const scaled = districts.map((x) => ({ d: x.d, polys: x.polys.map((poly) => poly.map((ring) => ring.map(([lng, lat]) => [Math.round(lng * 1e4), Math.round(lat * 1e4)]))) }));
const out = { source: 'NYC Open Data, School Districts (8ugf-3d8u), simplified to about 25 m', scale: 1e4, districts: scaled };
fs.writeFileSync(path.join(ROOT, 'public/data/csd.json'), JSON.stringify(out));

// --- validate against the seed's district for each campus
const inRing = (lng, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const at = (lat, lng) => {
  for (const x of districts) for (const poly of x.polys) if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h))) return x.d;
  return null;
};
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/schools.json'), 'utf8')).schools;
let ok = 0, miss = [], none = [];
for (const s of seed) {
  const d = at(s.lat, s.lng);
  if (d === s.district) ok++;
  else if (d === null) none.push(`${s.name} (${s.district})`);
  else miss.push(`${s.name}: seed ${s.district}, map ${d}`);
}
console.log(`public/data/csd.json ${(fs.statSync(path.join(ROOT, 'public/data/csd.json')).size / 1024).toFixed(0)} KB, ${districts.length} districts`);
console.log(`${ok}/${seed.length} campuses land in their listed district; ${miss.length} differ, ${none.length} outside every polygon`);
for (const m of [...miss, ...none].slice(0, 12)) console.log('  ', m);
if (ok / seed.length < 0.97) process.exit(1);
