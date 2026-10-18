#!/usr/bin/env node
'use strict';
// Builds demo/index.html: a single self-contained page of the app for hosting where no server runs
// (claude.ai artifacts). School data is embedded; saving uses the host's db/user capabilities.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
process.env.NODE_ENV = 'test';
const { Store } = require('../src/db');

const ROOT = path.join(__dirname, '..');
// The React bundle is inlined, so make sure it is current
execFileSync(process.execPath, [path.join(__dirname, 'build-web.js')], { stdio: 'ignore' });
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const store = new Store(':memory:');
store.loadSeed(path.join(ROOT, 'data/seed/schools.json'));
const { meta, schools } = store.schoolSummaries();
const details = Object.fromEntries(schools.map((s) => [s.id, store.schoolDetail(s.id)]));
const data = { meta: { ...meta, count: schools.length }, schools, details, byId: Object.fromEntries(schools.map((s) => [s.id, 1])) };

const html = read('views/app.html');
const body = html
  .slice(html.indexOf('<body'), html.lastIndexOf('</body>'))
  .replace(/^<body[^>]*>/, '')
  .replace(/<script[^>]*><\/script>\s*/g, '')
  .replace(/src="\/favicon\.svg"/g, `src="data:image/svg+xml;base64,${Buffer.from(read('public/favicon.svg')).toString('base64')}"`);
const favicon = `data:image/svg+xml;base64,${Buffer.from(read('public/favicon.svg')).toString('base64')}`;
const bodyClass = /<body class="([^"]+)"/.exec(html)[1];
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const css = read('public/vendor/leaflet/leaflet.css') + '\n' + read('public/css/styles.css') + `
/* hosted demo */
html, body { height: 100%; }
.app:not(.view-my) { height: 100%; }
.demo-note { flex: none; padding: 7px 18px; font-size: 13px; background: #e8eefb; color: #1d3f86; border-bottom: 1px solid var(--border); }
.demo-note a { color: inherit; font-weight: 650; }
`;

const page = `<title>NYC Charter School Finder</title>
<meta name="description" content="Find, compare and shortlist New York City charter schools on one interactive map.">
<style>${css}</style>
<script>document.body.className = ${JSON.stringify(bodyClass)};</script>
<p class="demo-note" role="note">Demo: all ${schools.length} NYC charter school campuses built in, cross-checked across 4 sources. Saving uses your claude.ai sign-in instead of Google.</p>
${body}
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<script>window.NCS_DATA = ${safeJson(data)};</script>
<script>window.NCS_BASEMAP = ${read('data/boroughs.geojson')};</script>
<script>window.NCS_STREETS = ${read('data/basemap/streets.json')};</script>
<script>window.NCS_CSD = ${read('public/data/csd.json')};</script>
<script>${read('public/js/streets.js')}</script>
<script>${read('public/js/i18n.js')}</script>
<script>${read('public/js/core.js')}</script>
<script>${read('public/js/cluster.js')}</script>
<script>${read('demo/shim.js')}</script>
<script>${read('public/app/app.js').split('"/favicon.svg"').join(JSON.stringify(favicon))}</script>
`;
fs.writeFileSync(path.join(ROOT, 'demo/index.html'), page);
console.log(`demo/index.html ${(page.length / 1024).toFixed(0)} KB, ${schools.length} schools`);
