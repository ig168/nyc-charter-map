'use strict';
// SX-08: the community school district boundary file puts every campus in its listed district
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'csd.json'), 'utf8'));
const k = raw.scale || 1;
const data = { districts: raw.districts.map((x) => ({ d: x.d, polys: x.polys.map((p) => p.map((r) => r.map(([a, b]) => [a / k, b / k]))) })) };
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'schools.json'), 'utf8')).schools;
const inRing = (lng, lat, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const at = (lat, lng) => {
  for (const d of data.districts) for (const p of d.polys) if (inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h))) return d.d;
  return null;
};

test('SX-08 district boundaries: 32 districts, every campus inside its listed district', () => {
  assert.equal(data.districts.length, 32);
  assert.deepEqual(data.districts.map((d) => d.d), Array.from({ length: 32 }, (_, i) => i + 1));
  const wrong = seed.filter((s) => at(s.lat, s.lng) !== s.district).map((s) => s.name);
  assert.deepEqual(wrong, []);
  assert.equal(at(40.7484, -73.9857), 2); // Midtown
  assert.equal(at(40.8116, -73.9465), 5); // Central Harlem
  assert.equal(at(40.7144, -73.9573), 14); // Williamsburg
  assert.equal(at(40.0, -73.9), null); // outside NYC
  assert.ok(fs.statSync(path.join(__dirname, '..', 'public', 'data', 'csd.json')).size < 150 * 1024);
});
