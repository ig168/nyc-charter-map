#!/usr/bin/env node
'use strict';
// Turns the raw NYC Open Data extract (data/basemap/nyc-map-data.json) into the compact street map
// the demo embeds (data/basemap/streets.json): street names in map style ("W 42nd St"), polylines as-is.
// Sources: Centerline inkn-q76z (street segments), Parks Properties enfh-gkve, Borough Boundaries gthc-hcne.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEEP_UPPER = new Set(['FDR', 'JFK', 'MLK', 'RFK', 'US', 'NY', 'NYC', 'II', 'III', 'IV', 'BQE', 'LIE', 'CUNY', 'SUNY', 'LGA', 'MDE', 'BX', 'NB', 'SB', 'EB', 'WB']);
// abbreviations spelled out wherever they appear (map style), and whole-name overrides
const ABBR = { BCH: 'Beach', RVR: 'River', ISL: 'Island', TRML: 'Terminal', OPAS: 'Overpass', HTS: 'Heights', BRDG: 'Bridge', DRV: 'Dr', PY: 'Pkwy', BL: 'Blvd', RP: 'Ramp', VLG: 'Village', EN: 'Entrance', ET: 'Exit', EP: 'Exit' };
const WHOLE = { 'FRANKLIN D ROOSEVELT DR': 'FDR Dr', 'DE KALB AVE': 'DeKalb Ave', 'DEKALB AVE': 'DeKalb Ave' };
const SMALL = new Set(['OF', 'THE', 'AND', 'AT', 'ON', 'IN', 'TO', 'BY']);
const DIRS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const TYPES = {
  ST: 'St', AVE: 'Ave', AV: 'Ave', BLVD: 'Blvd', PL: 'Pl', RD: 'Rd', DR: 'Dr', PKWY: 'Pkwy', EXPY: 'Expy', HWY: 'Hwy',
  LN: 'Ln', CT: 'Ct', TER: 'Ter', TERR: 'Ter', SQ: 'Sq', PLZ: 'Plz', CIR: 'Cir', WAY: 'Way', LOOP: 'Loop', ROW: 'Row',
  TPKE: 'Tpke', BR: 'Bridge', BRG: 'Bridge', TUNL: 'Tunnel', XING: 'Crossing', CRES: 'Cres', ALY: 'Aly', WALK: 'Walk',
  PATH: 'Path', OVAL: 'Oval', SLIP: 'Slip', EXIT: 'Exit', ENT: 'Ent', APPR: 'Approach', SVC: 'Service', CONC: 'Concourse',
};
const NEXT_TYPES = new Set(Object.keys(TYPES).concat(['STREET', 'AVENUE', 'ROAD', 'PLACE', 'DRIVE']));

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

function word(w) {
  if (KEEP_UPPER.has(w)) return w;
  if (/^MC[A-Z]{2,}$/.test(w)) return `Mc${w[2]}${w.slice(3).toLowerCase()}`;
  if (/^O'[A-Z]/.test(w)) return `O'${w[2]}${w.slice(3).toLowerCase()}`;
  return w
    .toLowerCase()
    .replace(/(^|[-'.])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

function formatName(raw) {
  const key = raw.trim().replace(/\s+/g, ' ');
  if (WHOLE[key]) return WHOLE[key];
  // "MC GUINNESS" → "MCGUINNESS" so it becomes McGuinness
  const words = key.replace(/\bMC ([A-Z]{3,})/g, 'MC$1').split(' ').filter(Boolean);
  return words
    .map((w, i) => {
      const next = words[i + 1];
      if (/^\d+$/.test(w) && next && NEXT_TYPES.has(next)) return ordinal(Number(w));
      if (DIRS.has(w) && words.length > 1) return w;
      if (TYPES[w] && i > 0) return TYPES[w];
      if (ABBR[w]) return ABBR[w];
      if (w.length === 1) return w; // Ave N, Ave J
      if (i > 0 && SMALL.has(w)) return w.toLowerCase(); // Ave of the Americas
      return word(w);
    })
    .join(' ');
}

function decodeCheck(enc) {
  // returns false if a polyline decodes outside the NYC area (guards against a corrupted string)
  let i = 0, lat = 0, lng = 0, n = 0;
  while (i < enc.length) {
    for (let k = 0; k < 2; k++) {
      let b, shift = 0, result = 0;
      do {
        b = enc.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i <= enc.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d;
      else lng += d;
    }
    n++;
    if (lat < 4045000 || lat > 4100000 || lng < -7430000 || lng > -7365000) return false;
  }
  return n >= 4;
}

function build() {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/basemap/nyc-map-data.json'), 'utf8'));
  // Cemeteries from 2020 Neighborhood Tabulation Areas (9nt8-h7nd): the big private ones aren't city parks
  const cem = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/basemap/cemeteries.json'), 'utf8')).cem;
  for (const [, rings] of cem) if (!rings.every(decodeCheck)) throw new Error('cemetery outline outside NYC: ' + rings[0].slice(0, 20));
  const out = {
    source: 'NYC Open Data: Centerline (inkn-q76z), Parks Properties (enfh-gkve), Borough Boundaries (gthc-hcne), 2020 NTAs (9nt8-h7nd) for cemeteries',
    // 110,559 constructed street segments (rw_type 1,2,3,4,9; status 2) merged into named lines
    segments: 110559,
    names: src.s.names.map(formatName),
    lines: src.s.lines,
    land: src.a.land,
    parks: src.a.parks.concat(cem),
  };
  const file = path.join(ROOT, 'data/basemap/streets.json');
  fs.writeFileSync(file, JSON.stringify(out));
  return { file, bytes: fs.statSync(file).size, lines: out.lines.length, names: out.names.length };
}

module.exports = { formatName, ordinal };
if (require.main === module) console.log(build());
