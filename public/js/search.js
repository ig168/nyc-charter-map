/* Smart school search, shared by the browser app and the Node tests. No DOM access.
   - folds accents, case and punctuation ("Académie" = "academie")
   - understands nicknames and abbreviations (SA, AF, KIP, Bklyn, Bed-Stuy, PS 123, Spanish level words)
   - ranks matches in tiers: exact name > name word > network > neighborhood/borough/address > typo-only
   - typo tolerance only kicks in for a word that matches nothing literally, so it can never outrank a real match
   - detects zip codes and street addresses (offered as location suggestions, never applied silently)
   - turns phrases like "kindergarten in Bushwick" into filters (rule-based, no AI) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.NCS = root.NCS || {}).search = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NAME_COLLATOR = new Intl.Collator('en', { sensitivity: 'base' }); // one collator: localeCompare with options builds one per call

  const MAX_QUERY = 100;
  const NYC_ZIP_RANGES = [[10001, 10282], [10301, 10314], [10451, 10475], [11004, 11005], [11101, 11109], [11201, 11256], [11351, 11436], [11691, 11697]];
  const nycZip = (z) => /^\d{5}$/.test(z) && NYC_ZIP_RANGES.some(([a, b]) => +z >= a && +z <= b);
  const TIER = { EXACT: 0, NAME: 1, NETWORK: 2, PLACE: 3, FUZZY: 4 };

  // ---- Normalization ---------------------------------------------------------------------------
  /** One character → its folded form ('' to drop, ' ' for a separator). */
  function foldChar(c) {
    const base = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (/^['’`]$/.test(c)) return '';
    return base.replace(/[^a-z0-9]/g, ' ');
  }
  function fold(s) {
    let out = '';
    for (const c of String(s || '')) out += foldChar(c);
    return out.replace(/\s+/g, ' ').trim();
  }
  /** Folded text plus, for every folded character, the index of the original character it came from. */
  function foldWithMap(s) {
    let out = '';
    const map = [];
    const src = String(s || '');
    let i = 0;
    for (const c of src) {
      const f = foldChar(c);
      for (const ch of f) {
        if (ch === ' ' && (out.endsWith(' ') || out === '')) continue;
        out += ch;
        map.push([i, i + c.length]);
      }
      i += c.length;
    }
    return { text: out, map };
  }
  const words = (s) => fold(s).split(' ').filter(Boolean);

  // ---- Vocabulary ------------------------------------------------------------------------------
  // Words that carry no meaning for matching ("harlem charter school" = "harlem").
  const STOP = new Set(['school', 'schools', 'charter', 'charters', 'the', 'of', 'for', 'a', 'an', 'and', 'nyc', 'ny', 'new', 'york',
    'escuela', 'escuelas', 'la', 'el', 'los', 'las', 'de', 'del', 'y', 'para', 'public', 'publica', 'publico']);
  // Nicknames → what they mean. Each entry: [folded phrase typed, [alternatives, any of which may match]]
  const ALIASES = [
    ['harlem success', ['success academy harlem']],
    ['success academies', ['success academy']],
    ['sa', ['success academy']],
    ['saca', ['success academy']],
    ['af', ['achievement first']],
    ['kip', ['kipp']],
    ['dp', ['democracy prep']],
    ['dem prep', ['democracy prep']],
    ['icahn', ['icahn']],
    ['hcz', ['harlem children s zone', 'promise academy']],
    ['bklyn', ['brooklyn']], ['bk', ['brooklyn']], ['brookyln', ['brooklyn']],
    ['bx', ['bronx']], ['the bronx', ['bronx']],
    ['si', ['staten island']], ['staten', ['staten island']],
    ['manhatten', ['manhattan']], ['mnhtn', ['manhattan']],
    ['bedstuy', ['bedford stuyvesant']], ['bed stuy', ['bedford stuyvesant']], ['bed sty', ['bedford stuyvesant']],
    ['uws', ['upper west side']], ['ues', ['upper east side']], ['les', ['lower east side']], ['lic', ['long island city']],
    ['crown hts', ['crown heights']], ['wash hts', ['washington heights']], ['wahi', ['washington heights']],
    ['ft greene', ['fort greene']], ['ft', ['fort']], ['st', ['saint', 'st']], ['mt', ['mount', 'mt']],
    ['prep', ['prep', 'preparatory']], ['preparatory', ['preparatory', 'prep']],
    ['intl', ['international']], ['int l', ['international']], ['acad', ['academy']],
    ['academia', ['academy', 'academia']], ['ninos', ['children', 'ninos']], ['nino', ['children', 'nino']],
    ['ciencias', ['science']], ['ciencia', ['science']], ['artes', ['arts']], ['matematicas', ['math']],
  ];
  // Grade-level words become a level filter, not name text.
  const LEVEL_WORDS = [
    ['pre k', 'prek'], ['prek', 'prek'], ['pre kindergarten', 'prek'], ['prekinder', 'prek'], ['preescolar', 'prek'], ['prekindergarten', 'prek'],
    ['elementary', 'elementary'], ['elem', 'elementary'], ['primaria', 'elementary'], ['primary', 'elementary'],
    ['middle', 'middle'], ['ms', 'middle'], ['intermedia', 'middle'], ['secundaria', 'middle'], ['junior high', 'middle'],
    ['high', 'high'], ['hs', 'high'], ['preparatoria', 'high'], ['bachillerato', 'high'],
  ];
  // Entry grades ("where can I apply for kindergarten?")
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
    primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4, quinto: 5, sexto: 6, septimo: 7, octavo: 8, noveno: 9, decimo: 10 };
  const pad2 = (n) => String(n).padStart(2, '0');
  const STREET = /\b(street|st|avenue|ave|av|road|rd|boulevard|blvd|place|pl|parkway|pkwy|drive|dr|lane|ln|way|court|ct|terrace|ter|broadway|concourse|plaza|square|sq|highway|hwy|turnpike|tpke|expressway|calle|avenida)\b/;

  // ---- Edit distance (Damerau, bounded) ---------------------------------------------------------
  function within(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    const n = a.length;
    const m = b.length;
    let prev2 = null;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= m; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return false;
      prev2 = prev;
      prev = cur;
    }
    return prev[m] <= max;
  }
  const typoBudget = (w) => (w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0);

  // ---- Query parsing ---------------------------------------------------------------------------
  /** Replace multi-word phrases (longest first) inside a token list. Returns [{text, kind, value}] parts. */
  function replacePhrases(tokens, table, kind) {
    const sorted = table.slice().sort((a, b) => b[0].split(' ').length - a[0].split(' ').length);
    const out = [];
    for (let i = 0; i < tokens.length; ) {
      if (tokens[i].kind) {
        out.push(tokens[i]);
        i++;
        continue;
      }
      let hit = null;
      for (const [phrase, value] of sorted) {
        const pw = phrase.split(' ');
        if (pw.every((w, k) => tokens[i + k] && !tokens[i + k].kind && tokens[i + k].text === w)) {
          hit = { text: phrase, kind, value, len: pw.length };
          break;
        }
      }
      if (hit) {
        out.push({ text: hit.text, kind: hit.kind, value: hit.value });
        i += hit.len;
      } else {
        out.push(tokens[i]);
        i++;
      }
    }
    return out;
  }

  /**
   * Understand a query. Returns:
   *  { text, empty, zip, address, psNumber, levels:Set, entry, groups:[{typed, alts:[[word]], last}], parts:[] }
   *  groups: every group must match; a group matches if any alternative's words all match.
   */
  function parse(raw, places = []) {
    const text = String(raw || '').slice(0, MAX_QUERY);
    const f = fold(text);
    const res = { text, empty: !f, zip: null, address: false, psNumber: false, levels: new Set(), entry: null, groups: [], places: [], raw: f };
    if (!f) return res;
    if (/^(p\s?s|i\s?s|m\s?s|j\s?h\s?s|j\s?h\s?s)\s?\d{1,3}\s*[a-z]?$/.test(f) || /^(ps|is|ms|jhs)\d{1,3}$/.test(f)) {
      res.psNumber = true;
      return res;
    }
    const zipM = f.match(/(?:^|\s)(\d{5})(?:\s|$)/);
    if (zipM) res.zip = zipM[1];
    // A street address: starts with a house number then a word, or names a street type after a number
    if (/^\d+[a-z]?(\s|-\d+\s)\S+/.test(f) && !/^\d{5}$/.test(f) && (STREET.test(f) || /^\d+\s+\d+(st|nd|rd|th)?\s/.test(f) || f.split(' ').length >= 3)) res.address = true;
    if (/^(?:[a-z]+\s)*\d+\s?(st|nd|rd|th)?\s+(street|st|avenue|ave|av)\b/.test(f) && /^\d/.test(f)) res.address = true;
    if (res.address) return res;

    let tokens = f.split(' ').filter(Boolean).map((t) => ({ text: t }));
    // grade expressions: "kindergarten", "k", "6th grade", "grade 6", "sexto grado"
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].text;
      const next = tokens[i + 1] && tokens[i + 1].text;
      const prev = tokens[i - 1] && tokens[i - 1].text;
      if (t === 'kindergarten' || t === 'kinder' || t === 'kinder garten' || t === 'kindergarden') {
        out.push({ text: t, kind: 'entry', value: '0K' });
        continue;
      }
      if (t === 'k' && tokens.length > 1 && !/^\d/.test(next || '')) {
        // "k" is kindergarten only alongside other words ("k in bushwick"); alone it's the start of a name
        out.push({ text: t, kind: 'entry', value: '0K' });
        continue;
      }
      const ord = t.match(/^(\d{1,2})(st|nd|rd|th|o|er|ro)?$/);
      if (ord && (next === 'grade' || next === 'grado') && +ord[1] >= 1 && +ord[1] <= 12) {
        out.push({ text: `${t} ${next}`, kind: 'entry', value: pad2(+ord[1]) });
        i++;
        continue;
      }
      if ((t === 'grade' || t === 'grado') && next && /^\d{1,2}$/.test(next) && +next >= 1 && +next <= 12) {
        out.push({ text: `${t} ${next}`, kind: 'entry', value: pad2(+next) });
        i++;
        continue;
      }
      if (ORD[t] && (next === 'grade' || next === 'grado')) {
        out.push({ text: `${t} ${next}`, kind: 'entry', value: pad2(ORD[t]) });
        i++;
        continue;
      }
      if (/^(grade|grado)$/.test(t) && prev && ORD[prev]) continue;
      out.push(tokens[i]);
    }
    tokens = replacePhrases(out, LEVEL_WORDS, 'level');
    tokens = replacePhrases(tokens, places.map((p) => [p.key, p]), 'place');
    tokens = replacePhrases(tokens, ALIASES, 'alias');

    const free = [];
    for (const tk of tokens) {
      if (tk.kind === 'entry') res.entry = tk.value;
      else if (tk.kind === 'level') res.levels.add(tk.value);
      else if (tk.kind === 'place') {
        res.places.push(tk.value);
        free.push({ typed: tk.text, alts: [tk.text.split(' ')] });
      } else if (tk.kind === 'alias') free.push({ typed: tk.text, alts: tk.value.map((a) => a.split(' ')) });
      else if (/^\d{5}$/.test(tk.text) && tk.text === res.zip) free.push({ typed: tk.text, alts: [[tk.text]], zip: true });
      else if (!STOP.has(tk.text) && tk.text !== 'in' && tk.text !== 'near' && tk.text !== 'en' && tk.text !== 'cerca') free.push({ typed: tk.text, alts: [[tk.text]] });
    }
    if (free.length) free[free.length - 1].last = !/\s$/.test(text);
    res.groups = free;
    return res;
  }

  // ---- Index -----------------------------------------------------------------------------------
  function createSearch(schools) {
    const docs = schools.map((s) => {
      const name = words(s.name);
      return {
        s,
        nameFold: name.join(' '),
        name: new Set(name),
        nameList: name,
        network: new Set(words(s.network)),
        place: new Set([...words(s.neighborhood), ...words(s.borough), ...words(s.address), ...(s.zip ? [s.zip] : [])]),
        fuzzyVocab: [...new Set([...name, ...words(s.network), ...words(s.neighborhood)])].filter((w) => w.length >= 4),
      };
    });
    // Places people type: neighborhoods (split "Mott Haven-Port Morris" into its parts) and boroughs
    const placeMap = new Map();
    const addPlace = (label, kind, school) => {
      const key = fold(label);
      if (!key || key.length < 3) return;
      if (!placeMap.has(key)) placeMap.set(key, { key, label, kind, count: 0, ids: new Set() });
      const p = placeMap.get(key);
      if (!p.ids.has(school.id)) {
        p.ids.add(school.id);
        p.count++;
      }
    };
    for (const s of schools) {
      if (s.neighborhood) {
        addPlace(s.neighborhood, 'hood', s);
        for (const part of s.neighborhood.split(/-|\(|\)|\//).map((x) => x.trim()).filter(Boolean)) if (fold(part) !== fold(s.neighborhood)) addPlace(part, 'hood', s);
      }
    }
    const places = [...placeMap.values()];
    const networks = new Map();
    for (const s of schools) {
      if (!s.network) continue;
      if (!networks.has(s.network)) networks.set(s.network, { name: s.network, key: fold(s.network), words: words(s.network), count: 0 });
      networks.get(s.network).count++;
    }
    const allVocab = new Set();
    for (const d of docs) for (const w of d.fuzzyVocab) allVocab.add(w);

    const wordHit = (set, w, allowPrefix) => {
      if (set.has(w)) return 2;
      if (allowPrefix && w.length >= 2) for (const x of set) if (x.startsWith(w)) return 1;
      return 0;
    };

    /** Best tier for one alternative (list of words) against one school, or -1. */
    function altTier(d, alt, isLast) {
      let worst = TIER.EXACT;
      let score = 0;
      for (let i = 0; i < alt.length; i++) {
        const w = alt[i];
        const prefix = w.length >= 3 || (isLast && i === alt.length - 1);
        let t = -1;
        let h = wordHit(d.name, w, prefix);
        if (h) {
          t = TIER.NAME;
          score += h * 3;
        } else if ((h = wordHit(d.network, w, prefix))) {
          t = TIER.NETWORK;
          score += h * 2;
        } else if ((h = wordHit(d.place, w, prefix))) {
          t = TIER.PLACE;
          score += h;
        }
        if (t < 0) return null;
        worst = Math.max(worst, t);
      }
      return { tier: worst, score };
    }

    function fuzzyGroupTier(d, group) {
      // every word of some alternative must be within its typo budget of a word in name/network/neighborhood
      for (const alt of group.alts) {
        let ok = true;
        for (const w of alt) {
          const budget = typoBudget(w);
          if (!budget || !d.fuzzyVocab.some((v) => within(w, v, budget) || (group.last && v.length > w.length && within(w, v.slice(0, w.length), budget)))) {
            ok = false;
            break;
          }
        }
        if (ok) return { tier: TIER.FUZZY, score: 0 };
      }
      return null;
    }

    const rankCache = new Map();
    /**
     * Rank every school for a query (filters other than the query are applied by the caller).
     * Returns { parsed, hits: Map(id → {tier, score, fuzzy}), fuzzyGroups:[typed words fixed by typo tolerance] }
     */
    function rank(q) {
      const key = String(q || '').slice(0, MAX_QUERY);
      if (rankCache.has(key)) return rankCache.get(key);
      const parsed = parse(key, places);
      const hits = new Map();
      const result = { parsed, hits, fuzzyGroups: [] };
      if (parsed.empty || parsed.psNumber || parsed.address) {
        if (rankCache.size > 200) rankCache.clear();
        rankCache.set(key, result);
        return result;
      }
      // Which groups match nothing literally anywhere? Only those get typo tolerance.
      const literal = parsed.groups.map((g) => docs.some((d) => g.alts.some((a) => altTier(d, a, g.last))));
      parsed.groups.forEach((g, i) => {
        if (!literal[i]) result.fuzzyGroups.push(g.typed);
      });
      const levelsOf = (grades) => {
        const L = { prek: ['PK'], elementary: ['0K', '01', '02', '03', '04', '05'], middle: ['06', '07', '08'], high: ['09', '10', '11', '12'] };
        return Object.keys(L).filter((l) => grades.some((g) => L[l].includes(g)));
      };
      for (const d of docs) {
        const s = d.s;
        if (parsed.entry && !(s.entryGrades || []).includes(parsed.entry)) continue;
        if (parsed.levels.size && !levelsOf(s.grades || []).some((l) => parsed.levels.has(l))) continue;
        let worst = TIER.EXACT;
        let score = 0;
        let fuzzy = false;
        let ok = true;
        for (let gi = 0; gi < parsed.groups.length; gi++) {
          const g = parsed.groups[gi];
          let best = null;
          if (literal[gi]) {
            for (const alt of g.alts) {
              const r = altTier(d, alt, g.last);
              if (r && (!best || r.tier < best.tier || (r.tier === best.tier && r.score > best.score))) best = r;
            }
          } else {
            best = fuzzyGroupTier(d, g);
            if (best) fuzzy = true;
          }
          if (!best) {
            ok = false;
            break;
          }
          worst = Math.max(worst, best.tier);
          score += best.score;
        }
        if (!ok) continue;
        if (!parsed.groups.length) worst = TIER.PLACE; // structure-only query ("middle school")
        const qWords = parsed.groups.flatMap((g) => g.alts[0]).join(' ');
        if (qWords && d.nameFold === qWords) worst = TIER.EXACT;
        else if (qWords && d.nameFold.startsWith(qWords)) score += 5;
        hits.set(s.id, { tier: worst, score, fuzzy });
      }
      if (rankCache.size > 200) rankCache.clear();
      rankCache.set(key, result);
      return result;
    }

    /** Sort comparator by relevance for a rank result. */
    function compare(r) {
      return (a, b) => {
        const x = r.hits.get(a.id);
        const y = r.hits.get(b.id);
        return x.tier - y.tier || y.score - x.score || NAME_COLLATOR.compare(a.name, b.name);
      };
    }

    /** Segments of a school name with the literally matched parts marked: [{text, mark}] */
    function highlight(name, q) {
      const r = rank(q);
      const segs = [{ text: name, mark: false }];
      if (!r.parsed.groups.length) return segs;
      const { text, map } = foldWithMap(name);
      const ranges = [];
      const nameWords = [];
      for (let i = 0, start = 0; i <= text.length; i++) {
        if (i === text.length || text[i] === ' ') {
          if (i > start) nameWords.push([start, i]);
          start = i + 1;
        }
      }
      for (const g of r.parsed.groups) {
        for (const alt of g.alts) {
          for (const w of alt) {
            for (const [a, b] of nameWords) {
              const nw = text.slice(a, b);
              if (nw === w || (w.length >= 2 && nw.startsWith(w))) ranges.push([a, a + w.length]);
            }
          }
        }
      }
      if (!ranges.length) return segs;
      ranges.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const rg of ranges) {
        const last = merged[merged.length - 1];
        // touching or one space apart ("Success Academy") → one highlight
        if (last && rg[0] <= last[1] + 1) last[1] = Math.max(last[1], rg[1]);
        else merged.push(rg.slice());
      }
      const out = [];
      let pos = 0;
      for (const [a, b] of merged) {
        const s = map[a][0];
        const e = map[b - 1][1];
        if (s > pos) out.push({ text: name.slice(pos, s), mark: false });
        out.push({ text: name.slice(s, e), mark: true });
        pos = e;
      }
      if (pos < name.length) out.push({ text: name.slice(pos), mark: false });
      return out;
    }

    /** Typeahead groups. limit = total rows (6 phone, 8 desktop). */
    function suggest(q, { limit = 8, isNycZip = nycZip } = {}) {
      const r = rank(q);
      const p = r.parsed;
      const out = { location: [], schools: [], networks: [], places: [], parsed: p, note: null };
      if (p.empty) return out;
      if (p.psNumber) {
        out.note = 'psNumber';
        return out;
      }
      if (p.address) {
        out.location.push({ type: 'address', query: p.text.trim() });
        return out;
      }
      if (p.zip) {
        if (isNycZip(p.zip)) out.location.push({ type: 'zip', query: p.zip, count: docs.filter((d) => d.s.zip === p.zip).length });
        else out.note = 'notNycZip';
      }
      const rest = p.groups.filter((g) => !g.zip);
      const restWords = rest.flatMap((g) => g.alts[0]);
      if (restWords.length) {
        const typed = rest.map((g) => g.typed).join(' ');
        const netTyped = rest.flatMap((g) => g.alts);
        for (const n of networks.values()) {
          const nw = new Set(n.words);
          const ok = rest.every((g) => g.alts.some((alt) => alt.every((w) => nw.has(w) || (w.length >= 2 && n.words.some((x) => x.startsWith(w))))));
          if (ok && n.count > 1) out.networks.push({ type: 'network', name: n.name, count: n.count });
        }
        void typed;
        void netTyped;
        for (const pl of places) {
          const pw = pl.key.split(' ');
          const ok = rest.every((g) => g.alts.some((alt) => alt.every((w) => pw.some((x) => x === w || (w.length >= 3 && x.startsWith(w))))));
          if (ok) out.places.push({ type: 'place', name: pl.label, count: pl.count });
        }
        out.networks.sort((a, b) => b.count - a.count);
        out.places.sort((a, b) => b.count - a.count || a.name.length - b.name.length);
        // drop places that are just a part of a longer listed name with the same schools
        out.places = out.places.filter((pl, i, arr) => !arr.some((o, j) => j < i && o.count === pl.count && fold(o.name).includes(fold(pl.name))));
      }
      if (p.zip && isNycZip(p.zip)) {
        const n = docs.filter((d) => d.s.zip === p.zip).length;
        if (n) out.places.unshift({ type: 'zipOnly', name: p.zip, count: n });
      }
      const ranked = [...r.hits.keys()].map((id) => docs.find((d) => d.s.id === id).s);
      if (!p.zip || restWords.length) out.schools = ranked.sort(compare(r));
      // share the rows: location first, up to 2 networks and 2 places, schools fill the rest
      const room = limit - out.location.length;
      out.networks = out.networks.slice(0, Math.min(2, room));
      out.places = out.places.slice(0, Math.min(2, room - out.networks.length));
      out.schools = out.schools.slice(0, Math.max(0, room - out.networks.length - out.places.length));
      return out;
    }

    /** Closest school, network or place name for a query that matched nothing (word-by-word trigram similarity). */
    // trigram sets are cached per word: candidates are fixed, so after the first miss this is cheap
    const gramCache = new Map();
    const grams = (w) => {
      let g = gramCache.get(w);
      if (!g) {
        const t = `  ${w} `;
        g = new Set();
        for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
        if (gramCache.size < 20000) gramCache.set(w, g);
      }
      return g;
    };
    const labelWords = new Map();
    function didYouMean(q) {
      const p = parse(q, places);
      const qWords = p.groups.map((g) => g.typed).join(' ').split(' ').filter((w) => w.length >= 3 && w.length <= 30).slice(0, 6);
      if (!qWords.length || qWords.join('').length < 4) return null;
      const qGrams = qWords.map((w) => { const t = `  ${w} `; const g = new Set(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; });
      const sim = (x, b) => {
        const y = grams(b);
        let inter = 0;
        for (const v of x) if (y.has(v)) inter++;
        return inter / (x.size + y.size - inter);
      };
      let best = null;
      const consider = (label) => {
        let cw = labelWords.get(label);
        if (!cw) {
          const base = words(label);
          // also try adjacent words run together, so "harlemvillage" still finds "Harlem Village"
          cw = base.concat(base.slice(1).map((w, i) => base[i] + w));
          labelWords.set(label, cw);
        }
        if (!cw.length) return;
        // every typed word should resemble some word of the candidate; average the best match per typed word
        let total = 0;
        for (const x of qGrams) {
          let m = 0;
          for (const c of cw) { const v = sim(x, c); if (v > m) m = v; }
          total += m;
        }
        const score = total / qGrams.length;
        if (!best || score > best.score || (score === best.score && label.length < best.label.length)) best = { label, query: label, score };
      };
      for (const n of networks.values()) consider(n.name);
      for (const d of docs) consider(d.s.name);
      for (const pl of places) consider(pl.label);
      return best && best.score >= 0.34 ? { label: best.label, query: best.query } : null;
    }

    return { rank, compare, highlight, suggest, didYouMean, places, networks: [...networks.values()], parse: (q) => parse(q, places) };
  }

  return { createSearch, parse, fold, foldWithMap, within, TIER, MAX_QUERY, STREET };
});
