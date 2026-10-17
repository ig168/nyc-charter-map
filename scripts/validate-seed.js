#!/usr/bin/env node
'use strict';

// Usage: node scripts/validate-seed.js [path/to/schools.json]
// Exits with status 1 (failing the build) if any record is invalid.

const fs = require('node:fs');
const path = require('node:path');
const { validateSeed } = require('../src/seed');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'seed', 'schools.json');
let seed;
try {
  seed = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ Could not read seed file ${file}: ${e.message}`);
  process.exit(1);
}

const r = validateSeed(seed);
if (r.stats) {
  console.log(`Seed ${seed.version || '(no version)'}: ${r.stats.count} schools`);
  console.log('  By borough:', Object.entries(r.stats.byBorough).map(([b, n]) => `${b} ${n}`).join(', '));
  console.log(`  Admissions dates: ${r.stats.admissionsDatesPct}%   Contact details: ${r.stats.contactPct}%`);
  console.log('  Field completeness (%):');
  for (const [k, v] of Object.entries(r.stats.completeness)) console.log(`    ${k.padEnd(22)} ${String(v).padStart(5)}`);
}
for (const w of r.warnings) console.log(`  ! ${w}`);
if (!r.ok) {
  console.error(`\n✗ Seed validation failed with ${r.errors.length} error(s):`);
  for (const e of r.errors.slice(0, 50)) console.error(`  - ${e}`);
  if (r.errors.length > 50) console.error(`  …and ${r.errors.length - 50} more`);
  process.exit(1);
}
console.log('\n✓ Seed is valid');
