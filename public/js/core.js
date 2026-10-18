/* Pure logic shared by the browser app and the Node test suite: search, filters, sorting,
   distances, deadlines and CSV. No DOM access here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.NCS = root.NCS || {}).core = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GRADES = ['PK', '0K', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  const LEVELS = {
    prek: ['PK'],
    elementary: ['0K', '01', '02', '03', '04', '05'],
    middle: ['06', '07', '08'],
    high: ['09', '10', '11', '12'],
  };
  const LEVEL_IDS = Object.keys(LEVELS);
  const BOROUGHS = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
  const NYC_ZIP_RANGES = [
    [10001, 10282], [10301, 10314], [10451, 10475], [11004, 11005],
    [11101, 11109], [11201, 11256], [11351, 11436], [11691, 11697],
  ];
  const SORTS = ['name', 'distance', 'deadline', 'relevance'];

  function isNycZip(zip) {
    if (typeof zip !== 'string' || !/^\d{5}$/.test(zip)) return false;
    const n = Number(zip);
    return NYC_ZIP_RANGES.some(([a, b]) => n >= a && n <= b);
  }

  /** 'invalid-format' | 'not-nyc' | null */
  function zipProblem(zip) {
    if (!/^\d{5}$/.test(zip)) return 'invalid-format';
    if (!isNycZip(zip)) return 'not-nyc';
    return null;
  }

  function levelsOf(grades) {
    return LEVEL_IDS.filter((l) => grades.some((g) => LEVELS[l].includes(g)));
  }

  function gradeName(g, lang) {
    if (g === 'PK') return lang === 'es' ? 'Prekínder' : 'Pre-K';
    if (g === '0K') return 'K';
    return String(Number(g));
  }

  function gradeLabel(grades, lang) {
    if (!grades || !grades.length) return '';
    const sorted = grades.slice().sort((a, b) => GRADES.indexOf(a) - GRADES.indexOf(b));
    // Describe gaps honestly, e.g. "K–2, 5–9"
    const runs = [];
    for (const g of sorted) {
      const i = GRADES.indexOf(g);
      const last = runs[runs.length - 1];
      if (last && GRADES.indexOf(last[1]) === i - 1) last[1] = g;
      else runs.push([g, g]);
    }
    return runs.map(([a, b]) => (a === b ? gradeName(a, lang) : `${gradeName(a, lang)}–${gradeName(b, lang)}`)).join(', ');
  }

  /** Lowercase, strip accents and punctuation so "Saint Ann's", "st anns" and "ST. ANN" compare sanely. */
  function normalize(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function searchIndex(s) {
    return ` ${normalize([s.name, s.network, s.neighborhood, s.address, s.borough, s.zip].filter(Boolean).join(' '))} `;
  }

  function queryTerms(q) {
    return normalize(q).split(' ').filter(Boolean).slice(0, 12);
  }

  function emptyFilters() {
    return { q: '', boroughs: new Set(), levels: new Set(), entry: '', districts: new Set(), zip: '', savedOnly: false, inView: false,
      networks: new Set(), places: new Set(), radius: 0 };
  }

  /**
   * True when the school passes every active filter (filters combine with AND).
   * `skip` names one filter to ignore (used to show per-option counts).
   */
  function matches(s, f, ctx = {}, skip = null) {
    if (skip !== 'boroughs' && f.boroughs.size && !f.boroughs.has(s.borough)) return false;
    if (skip !== 'levels' && f.levels.size && !levelsOf(s.grades).some((l) => f.levels.has(l))) return false;
    if (skip !== 'entry' && f.entry && !(s.entryGrades || []).includes(f.entry)) return false;
    if (skip !== 'districts' && f.districts.size && !f.districts.has(s.district)) return false;
    if (skip !== 'zip' && f.zip && s.zip !== f.zip) return false;
    if (skip !== 'savedOnly' && f.savedOnly && !(ctx.saved && ctx.saved.has(s.id))) return false;
    if (skip !== 'inView' && f.inView && ctx.inBounds && !ctx.inBounds(s)) return false;
    if (skip !== 'networks' && f.networks && f.networks.size && !f.networks.has(s.network)) return false;
    if (skip !== 'places' && f.places && f.places.size && !placeMatch(s, f.places)) return false;
    if (skip !== 'radius' && f.radius && ctx.origin && distanceKm(ctx.origin, s) * 0.621371 > f.radius) return false;
    if (skip !== 'q' && f.q) {
      if (ctx.rank) {
        // smart search (search.js): ranked, alias- and typo-aware; location-like text never filters
        const p = ctx.rank.parsed;
        if (!(p.address || (p.zip && !p.groups.some((g) => !g.zip) && !p.entry && !p.levels.size)) && !ctx.rank.hits.has(s.id)) return false;
        if (p.psNumber) return false;
      } else {
        const idx = s._idx || (s._idx = searchIndex(s));
        for (const term of queryTerms(f.q)) if (!idx.includes(term)) return false;
      }
    }
    return true;
  }

  /** Neighborhood filter: "Bushwick" matches "Bushwick (East)" and "Bushwick (West)". */
  function placeMatch(s, places) {
    const hood = normalize(s.neighborhood);
    for (const p of places) {
      const k = normalize(p);
      if (hood === k || ` ${hood} `.includes(` ${k} `)) return true;
    }
    return false;
  }

  function filterSchools(list, f, ctx) {
    return list.filter((s) => matches(s, f, ctx));
  }

  /**
   * Zero-result recovery: for each active filter, how many schools would show without it.
   * Returns [{key, value, count}] (value set for multi-value filters), most results first.
   */
  function relaxations(list, f, ctx) {
    const out = [];
    const tryWithout = (key, value, mutate) => {
      const g = { ...f, boroughs: new Set(f.boroughs), levels: new Set(f.levels), districts: new Set(f.districts),
        networks: new Set(f.networks || []), places: new Set(f.places || []) };
      mutate(g);
      const count = list.filter((s) => matches(s, g, ctx)).length;
      if (count) out.push({ key, value, count });
    };
    if (f.q) tryWithout('q', undefined, (g) => (g.q = ''));
    for (const b of f.boroughs) tryWithout('boroughs', b, (g) => g.boroughs.delete(b));
    for (const l of f.levels) tryWithout('levels', l, (g) => g.levels.delete(l));
    if (f.entry) tryWithout('entry', undefined, (g) => (g.entry = ''));
    for (const d of f.districts) tryWithout('districts', String(d), (g) => g.districts.delete(d));
    for (const n of f.networks || []) tryWithout('networks', n, (g) => g.networks.delete(n));
    for (const p of f.places || []) tryWithout('places', p, (g) => g.places.delete(p));
    if (f.zip) tryWithout('zip', undefined, (g) => (g.zip = ''));
    if (f.savedOnly) tryWithout('savedOnly', undefined, (g) => (g.savedOnly = false));
    if (f.inView) tryWithout('inView', undefined, (g) => (g.inView = false));
    if (f.radius && ctx.origin) tryWithout('radius', undefined, (g) => (g.radius = 0));
    return out.sort((a, b) => b.count - a.count);
  }

  function distanceKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatMiles(km, lang) {
    const mi = km * 0.621371;
    const n = mi < 10 ? mi.toFixed(1) : String(Math.round(mi));
    return `${lang === 'es' ? n.replace('.', ',') : n} mi`;
  }

  /** Next upcoming date for sorting: the application deadline if it hasn't passed, else none. */
  function nextDeadline(s, today) {
    return s.deadline && s.deadline >= today ? s.deadline : null;
  }

  function sortSchools(list, sort, { origin = null, today = new Date().toISOString().slice(0, 10), rank = null, compare = null, district = null } = {}) {
    const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
    const out = list.slice();
    if (sort === 'relevance' && rank && compare) {
      const cmp = compare(rank);
      return out.sort((a, b) => (rank.hits.has(a.id) && rank.hits.has(b.id) ? cmp(a, b) : byName(a, b)));
    }
    if (sort === 'distance' && origin) {
      const d = new Map(out.map((s) => [s.id, distanceKm(origin, s)]));
      // the family's own community school district first (charter lotteries favor district residents)
      const home = (s) => (district && s.district === district ? 0 : 1);
      return out.sort((a, b) => home(a) - home(b) || d.get(a.id) - d.get(b.id) || byName(a, b));
    }
    if (sort === 'deadline') {
      return out.sort((a, b) => {
        const da = nextDeadline(a, today);
        const db = nextDeadline(b, today);
        if (da && db) return da.localeCompare(db) || byName(a, b);
        if (da) return -1; // schools without an upcoming deadline go last
        if (db) return 1;
        return byName(a, b);
      });
    }
    return out.sort(byName);
  }

  /** Deadlines and lotteries for saved schools: upcoming first (soonest first), then past ones. */
  function deadlineList(schools, today = new Date().toISOString().slice(0, 10)) {
    const items = [];
    for (const s of schools) {
      if (s.deadline) items.push({ school: s, date: s.deadline, kind: 'deadline', past: s.deadline < today });
      if (s.lotteryDate) items.push({ school: s, date: s.lotteryDate, kind: 'lottery', past: s.lotteryDate < today });
    }
    const up = items.filter((i) => !i.past).sort((a, b) => a.date.localeCompare(b.date) || a.school.name.localeCompare(b.school.name));
    const past = items.filter((i) => i.past).sort((a, b) => b.date.localeCompare(a.date));
    return { upcoming: up, past };
  }

  function daysUntil(date, today = new Date().toISOString().slice(0, 10)) {
    return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  }

  /** CSV with spreadsheet formula injection neutralized (values starting with = + - @ tab CR). */
  function toCsv(header, rows) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  }

  return {
    GRADES, LEVELS, LEVEL_IDS, BOROUGHS, SORTS,
    isNycZip, zipProblem, levelsOf, gradeName, gradeLabel, normalize, searchIndex, queryTerms,
    emptyFilters, matches, filterSchools, relaxations, placeMatch, distanceKm, formatMiles, sortSchools, deadlineList, daysUntil, toCsv,
  };
});
