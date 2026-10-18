'use strict';

// SRCH-01..07 filter/sort logic, TRK-03 deadlines, CSV-01, MAP-01 clustering, I18N-01 completeness, DATA-01

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../public/js/core.js');
const { cluster } = require('../public/js/cluster.js');
const { dict } = require('../public/js/i18n.js');
const { validateSeed } = require('../src/seed');
const { fold } = require('../src/ics');

const SEED_FILE = path.join(__dirname, '..', 'data', 'seed', 'schools.json');
const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
// Shape the seed like the API's summary rows
const schools = seed.schools.map((s) => ({
  id: s.id, name: s.name, network: s.network, borough: s.borough, district: s.district, zip: s.zip,
  neighborhood: s.neighborhood, address: s.address, lat: s.lat, lng: s.lng, grades: s.grades_served,
  entryGrades: s.entry_grades, deadline: s.admissions.application_deadline, lotteryDate: s.admissions.lottery_date,
}));
const F = (over = {}) => ({ ...core.emptyFilters(), ...over });
const run = (f, ctx) => core.filterSchools(schools, f, ctx);

test('SRCH-01 text search: full name, partial word, network, wrong case, special characters', () => {
  assert.deepEqual(run(F({ q: 'KIPP AMP Elementary School' })).map((s) => s.id), ['k-kipp-amp-elementary-school']);
  assert.ok(run(F({ q: 'prepara' })).length >= 5, 'partial word');
  const uncommon = run(F({ q: 'uncommon schools' }));
  assert.ok(uncommon.length >= 10 && uncommon.every((s) => s.network === 'Uncommon Schools' || /uncommon/i.test(s.name)), 'network');
  assert.deepEqual(run(F({ q: 'kIpP aMp eLeMeNtArY' })).map((s) => s.id), ['k-kipp-amp-elementary-school'], 'case-insensitive');
  assert.ok(run(F({ q: 'harlem' })).length > 10, 'neighborhood');
  assert.ok(run(F({ q: "children's aid" })).some((s) => s.id === 'x-children-s-aid-college-prep-charter-school-grades-6-8'), 'apostrophe');
  assert.ok(run(F({ q: 'childrens aid' })).some((s) => s.id === 'x-children-s-aid-college-prep-charter-school-grades-6-8'), 'apostrophe optional');
  for (const q of ['<script>alert(1)</script>', '"; DROP TABLE', '(((', '.*', '\\', '%', '😀']) assert.doesNotThrow(() => run(F({ q })), q);
  assert.equal(run(F({ q: '<script>alert(1)</script>' })).length, 0);
});

test('SRCH-02 borough multi-select', () => {
  const one = run(F({ boroughs: new Set(['Queens']) }));
  assert.ok(one.length > 0 && one.every((s) => s.borough === 'Queens'));
  const two = run(F({ boroughs: new Set(['Queens', 'Staten Island']) }));
  assert.equal(two.length, one.length + schools.filter((s) => s.borough === 'Staten Island').length);
});

test('SRCH-03 zip validation and filtering', () => {
  assert.equal(core.zipProblem('10027'), null);
  assert.equal(core.zipProblem('11206'), null);
  assert.equal(core.zipProblem('90210'), 'not-nyc');
  assert.equal(core.zipProblem('abcde'), 'invalid-format');
  assert.equal(core.zipProblem('1002'), 'invalid-format');
  const z = run(F({ zip: '10027' }));
  assert.ok(z.length > 0 && z.every((s) => s.zip === '10027'));
  for (const s of seed.schools) assert.ok(core.isNycZip(s.zip), `${s.id} zip ${s.zip}`);
});

test('SRCH-04 district multi-select with only districts present in the data', () => {
  const r = run(F({ districts: new Set([5, 9]) }));
  assert.ok(r.length > 0 && r.every((s) => s.district === 5 || s.district === 9));
  const present = new Set(schools.map((s) => s.district));
  assert.ok([...present].every((d) => d >= 1 && d <= 32));
});

test('SRCH-05 grade level and entry grade match the seed', () => {
  const mid = run(F({ levels: new Set(['middle']) }));
  assert.ok(mid.length > 0 && mid.every((s) => s.grades.some((g) => ['06', '07', '08'].includes(g))));
  const k = run(F({ entry: '0K' }));
  assert.ok(k.length > 0 && k.every((s) => s.entryGrades.includes('0K')));
  assert.equal(k.length, seed.schools.filter((s) => s.entry_grades.includes('0K')).length);
  assert.ok(run(F({ levels: new Set(['prek']) })).every((s) => s.grades.includes('PK')));
});

test('SRCH-06 filters combine with AND', () => {
  const f = F({ boroughs: new Set(['Bronx']), levels: new Set(['high']), q: 'new visions' });
  const r = run(f);
  assert.ok(r.length > 0);
  assert.ok(r.every((s) => s.borough === 'Bronx' && core.levelsOf(s.grades).includes('high') && /new visions/i.test(`${s.name} ${s.network}`)));
  assert.ok(r.length < run(F({ boroughs: new Set(['Bronx']) })).length);
});

test('SRCH-07 sort by name, distance and next deadline (no deadline last)', () => {
  const byName = core.sortSchools(schools, 'name');
  for (let i = 1; i < byName.length; i++) assert.ok(byName[i - 1].name.localeCompare(byName[i].name, 'en', { sensitivity: 'base' }) <= 0);
  const origin = { lat: 40.8116, lng: -73.9465 }; // Harlem
  const byDist = core.sortSchools(schools, 'distance', { origin });
  for (let i = 1; i < byDist.length; i++) assert.ok(core.distanceKm(origin, byDist[i - 1]) <= core.distanceKm(origin, byDist[i]));
  const mixed = [
    { id: '1', name: 'C', deadline: '2027-04-15' },
    { id: '2', name: 'A', deadline: null },
    { id: '3', name: 'B', deadline: '2027-04-01' },
    { id: '4', name: 'D', deadline: '2026-01-01' }, // already passed
  ];
  assert.deepEqual(core.sortSchools(mixed, 'deadline', { today: '2026-10-17' }).map((s) => s.id), ['3', '1', '2', '4']);
});

test('TRK-03 upcoming deadlines soonest first; past ones separated', () => {
  const list = core.deadlineList(
    [
      { id: 'a', name: 'A', deadline: '2027-04-15', lotteryDate: '2027-04-20' },
      { id: 'b', name: 'B', deadline: '2027-04-01' },
      { id: 'c', name: 'C', deadline: '2026-04-01' },
    ],
    '2026-10-17',
  );
  assert.deepEqual(list.upcoming.map((d) => `${d.school.id}:${d.kind}`), ['b:deadline', 'a:deadline', 'a:lottery']);
  assert.deepEqual(list.past.map((d) => d.school.id), ['c']);
  assert.equal(core.daysUntil('2026-10-20', '2026-10-17'), 3);
});

test('CSV-01 CSV export neutralizes formulas and quotes fields', () => {
  const csv = core.toCsv(['Name', 'Note'], [['=HYPERLINK("http://evil")', 'a,b'], ['+1', '-2'], ['@x', 'line\nbreak'], ['Plain', 'He said "hi"']]);
  const lines = csv.split('\r\n');
  assert.equal(lines[1], `"'=HYPERLINK(""http://evil"")","a,b"`);
  assert.equal(lines[2], "'+1,'-2");
  assert.ok(csv.includes(`'@x,"line\nbreak"`));
  assert.ok(csv.includes('Plain,"He said ""hi"""'));
});

test('MAP-01 clustering keeps every school and separates at higher zoom', () => {
  const project = (z) => (s) => {
    const scale = 256 * 2 ** z;
    const x = ((s.lng + 180) / 360) * scale;
    const siny = Math.sin((s.lat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * scale;
    return { x, y };
  };
  const city = cluster(schools, project(10), 56);
  assert.equal(city.reduce((n, g) => n + g.items.length, 0), schools.length, 'no school lost');
  assert.ok(city.length < schools.length / 4, 'clusters at city zoom');
  const street = cluster(schools, project(16), 56);
  assert.ok(street.length > city.length * 3, 'separates when zoomed in');
});

test('I18N-01 every UI string exists in English and Spanish', () => {
  const en = Object.keys(dict.en).sort();
  const es = Object.keys(dict.es).sort();
  assert.deepEqual(es, en);
  // Every t('key') in the React front end (web/src)
  const src = path.join(__dirname, '..', 'web', 'src');
  const js = fs.readdirSync(src).filter((f) => /\.tsx?$/.test(f)).map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
  const used = new Set([...js.matchAll(/\bt\(\s*'([A-Za-z_]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 150, `found ${used.size} UI strings`);
  for (const k of used) assert.ok(k in dict.en && k in dict.es, `missing string ${k}`);
  const untranslated = en.filter((k) => dict.en[k] === dict.es[k] && !/^(boro_(manhattan|brooklyn|queens|staten)|districtShort|noteCount|nMiles)$/.test(k));
  assert.deepEqual(untranslated, [], 'strings identical in both languages');
});

test('DATA-01 seed has required fields and NYC coordinates; validator fails on broken records', () => {
  const r = validateSeed(seed);
  assert.deepEqual(r.errors, []);
  assert.ok(r.stats.count >= 40);
  for (const b of ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island']) assert.ok(r.stats.byBorough[b] > 0, b);
  assert.ok(r.stats.admissionsDatesPct >= 80 && r.stats.contactPct >= 80);
  for (const s of seed.schools) assert.ok(s.source && /^\d{4}-\d{2}-\d{2}$/.test(s.last_verified));

  const broken = (mut) => {
    const copy = JSON.parse(JSON.stringify(seed));
    mut(copy.schools[0]);
    return validateSeed(copy);
  };
  assert.ok(broken((s) => delete s.name).errors.some((e) => /missing name/.test(e)));
  assert.ok(broken((s) => (s.lat = 42.65)).errors.some((e) => /outside New York City/.test(e)), 'Albany coordinates');
  assert.ok(broken((s) => (s.grades_served = [])).errors.some((e) => /grades_served/.test(e)));
  assert.ok(broken((s) => (s.zip = '07030')).errors.some((e) => /not a NYC zip/.test(e)));
  assert.ok(broken((s) => (s.address = '')).errors.some((e) => /missing address/.test(e)));

  // The CLI exits non-zero (fails the build) on a broken file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const bad = JSON.parse(JSON.stringify(seed));
  bad.schools[3].lng = -71.06; // Boston
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(bad));
  const cli = (f) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'validate-seed.js'), f], { encoding: 'utf8' });
  assert.equal(cli(SEED_FILE).status, 0);
  const res = cli(path.join(dir, 'bad.json'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /outside New York City/);
});

test('iCalendar line folding is UTF-8 safe', () => {
  const long = `SUMMARY:${'é'.repeat(80)}`;
  for (const l of fold(long).split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
  assert.equal(fold(long).replace(/\r\n /g, ''), long);
});
