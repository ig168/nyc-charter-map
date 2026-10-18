'use strict';
// Smart search (search upgrade matrix rows SX-01..SX-05, SX-14, SXS-02)
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/js/core.js');
const S = require('../public/js/search.js');
const seed = require('../data/seed/schools.json').schools.map((s) => ({
  id: s.id, name: s.name, network: s.network, neighborhood: s.neighborhood, borough: s.borough, address: s.address,
  zip: s.zip, district: s.district, grades: s.grades_served, entryGrades: s.entry_grades, lat: s.lat, lng: s.lng,
}));
const se = S.createSearch(seed);
const results = (q) => {
  const r = se.rank(q);
  return seed.filter((s) => r.hits.has(s.id)).sort(se.compare(r));
};
const tiers = (q) => {
  const r = se.rank(q);
  return results(q).map((s) => r.hits.get(s.id).tier);
};

test('SX-01 nicknames and abbreviations find the right schools', () => {
  const cases = { kip: 'KIPP NYC', SA: 'Success Academy Charter Schools', AF: 'Achievement First', 'Harlem Success': 'Success Academy Charter Schools', uncommon: 'Uncommon Schools' };
  for (const [q, net] of Object.entries(cases)) {
    const r = results(q);
    assert.ok(r.length > 0, q);
    assert.equal(r[0].network, net, q);
  }
  assert.ok(results('Harlem Success').every((s) => s.network === 'Success Academy Charter Schools'));
  assert.match(results('Harlem Success')[0].name, /Success Academy Harlem/);
  assert.ok(results('Bklyn').every((s) => s.borough === 'Brooklyn' || /brooklyn/i.test(s.name)));
  assert.equal(results('Bklyn')[0].borough, 'Brooklyn');
  assert.equal(results('bed stuy').length, results('bedford stuyvesant').length);
  const ps = se.suggest('PS 123');
  assert.equal(ps.note, 'psNumber');
  assert.equal(results('ps 123').length, 0);
});

test('SX-02 typos are tolerated, accents ignored, nonsense returns nothing', () => {
  assert.ok(results('succes academy').slice(0, 3).some((s) => /Success Academy/.test(s.name)));
  assert.ok(results('kipp infinty').slice(0, 3).some((s) => /KIPP Infinity/.test(s.name)));
  assert.ok(results('achievment first').slice(0, 3).some((s) => /Achievement First/.test(s.name)));
  assert.deepEqual(results('académy brönx').map((s) => s.id), results('academy bronx').map((s) => s.id));
  assert.deepEqual(results('ESCUÉLA Harlem').map((s) => s.id), results('escuela harlem').map((s) => s.id));
  assert.equal(results('xyzzy').length, 0);
});

test('SX-03 ranking tiers: name before network before neighborhood before typo-only', () => {
  for (const q of ['kipp', 'harlem', 'bronx prep', 'mott haven']) {
    const t = tiers(q);
    assert.deepEqual(t, t.slice().sort((a, b) => a - b), `${q} tiers not ascending`);
  }
  assert.equal(results('bronx prep')[0].name, 'Bronx Prep Charter School');
  const h = tiers('harlem');
  assert.equal(h[0], S.TIER.NAME);
  assert.ok(h.includes(S.TIER.PLACE), 'neighborhood-only matches are included after name matches');
  // typo tolerance only for words that match nothing literally, so it can never outrank a real match
  assert.ok(!tiers('kipp').includes(S.TIER.FUZZY));
  assert.ok(tiers('kipp infinty').every((t) => t === S.TIER.FUZZY));
  // exact full name ranks first
  assert.equal(results('KIPP AMP Middle School')[0].name, 'KIPP AMP Middle School');
});

test('SX-04 highlight marks literal matches, keeps accents, and marks nothing for typo matches', () => {
  assert.deepEqual(se.highlight('KIPP AMP Elementary School', 'kipp amp').filter((x) => x.mark).map((x) => x.text), ['KIPP AMP']);
  assert.deepEqual(se.highlight('Académie Charter', 'academie').filter((x) => x.mark).map((x) => x.text), ['Académie']);
  assert.deepEqual(se.highlight('Success Academy Harlem 1', 'SA').filter((x) => x.mark).map((x) => x.text), ['Success Academy']);
  assert.equal(se.highlight('KIPP Infinity Middle School', 'infinty').filter((x) => x.mark).length, 0);
  assert.equal(se.highlight('KIPP Infinity Middle School', 'infinty').map((x) => x.text).join(''), 'KIPP Infinity Middle School');
});

test('SX-05 relaxations count what each removal would show; did-you-mean finds near misses', () => {
  const f = core.emptyFilters();
  f.q = 'kipp';
  f.boroughs.add('Staten Island');
  f.levels.add('high');
  const ctx = { rank: se.rank(f.q) };
  assert.equal(core.filterSchools(seed, f, ctx).length, 0);
  const rel = core.relaxations(seed, f, ctx);
  assert.ok(rel.length >= 1);
  for (const r of rel) {
    const g = { ...f, boroughs: new Set(f.boroughs), levels: new Set(f.levels) };
    if (r.key === 'q') g.q = '';
    if (r.key === 'boroughs') g.boroughs.delete(r.value);
    if (r.key === 'levels') g.levels.delete(r.value);
    assert.equal(core.filterSchools(seed, g, { rank: se.rank(g.q) }).length, r.count, `${r.key} count`);
  }
  const dym = se.didYouMean('harlm villag akademees');
  assert.ok(dym && /Harlem Village/.test(dym.label), JSON.stringify(dym));
  assert.equal(se.didYouMean('zz'), null);
});

test('SX-06 zip codes and addresses are recognized and never filter as text', () => {
  const z = se.suggest('10027');
  assert.equal(z.location[0].type, 'zip');
  assert.equal(z.location[0].query, '10027');
  assert.equal(se.suggest('90210').note, 'notNycZip');
  const a = se.suggest('350 5th Ave');
  assert.equal(a.location[0].type, 'address');
  for (const q of ['10027', '350 5th Ave', '1 Centre Street, Manhattan']) {
    const f = core.emptyFilters();
    f.q = q;
    assert.equal(core.filterSchools(seed, f, { rank: se.rank(q) }).length, seed.length, `${q} must not filter until chosen`);
  }
  assert.ok(!se.parse('kipp amp').address);
  assert.ok(!se.parse('Success Academy Harlem 1').address);
});

test('SX-07 distance radius filter and district-first distance sort', () => {
  const origin = { lat: 40.8116, lng: -73.9465 }; // Harlem, 10027
  const f = core.emptyFilters();
  f.radius = 1;
  const near1 = core.filterSchools(seed, f, { origin });
  f.radius = 5;
  const near5 = core.filterSchools(seed, f, { origin });
  assert.ok(near1.length > 0 && near5.length > near1.length);
  for (const s of near1) assert.ok(core.distanceKm(origin, s) * 0.621371 <= 1);
  const sorted = core.sortSchools(near5, 'distance', { origin, district: 5 });
  const firstOut = sorted.findIndex((s) => s.district !== 5);
  assert.ok(firstOut > 0 && sorted.slice(firstOut).every((s) => s.district !== 5), 'district 5 first');
});

test('SX-09 typeahead stays short and grouped', () => {
  for (const [q, limit] of [['kipp', 8], ['harlem', 6], ['a', 6], ['success', 8]]) {
    const g = se.suggest(q, { limit });
    const n = g.location.length + g.schools.length + g.networks.length + g.places.length;
    assert.ok(n <= limit, `${q}: ${n} rows > ${limit}`);
  }
  const h = se.suggest('harlem', { limit: 8 });
  assert.ok(h.places.some((p) => p.name === 'Harlem'));
  assert.ok(h.schools.length > 0);
  assert.ok(se.suggest('kipp').networks.some((n) => n.name === 'KIPP NYC' && n.count === 19));
});

test('SX-14 phrases become structure: grade, level, place', () => {
  const p = se.parse('kindergarten in Bushwick');
  assert.equal(p.entry, '0K');
  assert.ok(p.places.some((x) => /bushwick/i.test(x.label)));
  const r = results('kindergarten in bushwick');
  assert.ok(r.length > 0 && r.every((s) => s.entryGrades.includes('0K')));
  assert.ok(se.parse('middle school bronx').levels.has('middle'));
  assert.equal(se.parse('6th grade harlem').entry, '06');
  assert.equal(se.parse('sexto grado').entry, '06');
  assert.ok(results('middle school bronx').every((s) => core.levelsOf(s.grades).includes('middle')));
  assert.equal(se.parse('high school near 11216').zip, '11216');
});

test('SXS-02 hostile input is inert and fast', () => {
  for (const q of ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '(.*)+$'.repeat(30), 'a'.repeat(5000)]) {
    const t0 = performance.now();
    const r = se.rank(q);
    se.suggest(q);
    se.highlight('KIPP AMP', q);
    se.didYouMean(q);
    assert.ok(performance.now() - t0 < 50, `slow on ${q.slice(0, 20)}`);
    assert.ok(r.parsed.text.length <= S.MAX_QUERY);
  }
});
