#!/usr/bin/env python3
"""
Cross-references the seed (NYC DOE 2019-20 locations) against independent, current sources:

  1. NYSED Charter School Directory (as of 2025-09-02): the state's list of licensed charter schools
  2. NYC Charter School Center FINDER (findnyccharterschools.org, pulled 2026-10-17): every campus
  3. Network websites (Success Academy's school pages, pulled 2026-10-17)

Writes data/sources/reconciliation.json and prints a summary. Matching is by normalized name
(licenses) and by name + distance (campuses), since the sources share no common ID.
"""
import json, math, re, difflib, collections, pathlib, sys
import openpyxl

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'sources'

seed = json.loads((ROOT / 'data/seed/schools.json').read_text())['schools']
finder = [c for c in json.loads((SRC / 'finder-campuses.json').read_text())['campuses'] if c and c.get('name')]
sa_site = json.loads((SRC / 'success-academy-campuses.json').read_text())['campuses']
wb = openpyxl.load_workbook(SRC / 'nys-charter-school-directory-as-of-09-02-2025.xlsx', read_only=True)
nysed = [dict(zip(['active', 'inst_id', 'sed_code', 'name', 'district', 'county', 'region', 'opened', 'authorizer'], r[:9]))
         for r in wb.active.iter_rows(min_row=3, values_only=True) if r[3] and r[6] == 'New York City']

ROMAN = {'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10'}
STOP = {'charter', 'school', 'schools', 'the', 'of', 'for', 'and', 'nyc', 'new', 'york', 'city', 'academy', 'a', 'cs', 'public', 'inc'}
LEVEL = {'elementary', 'middle', 'high', 'lower', 'upper', 'campus', 'es', 'ms', 'hs', 'k', 'grade', 'grades'}


def norm(name, drop_level=False):
    s = name.lower().replace('&', ' and ').replace('–', '-').replace('’', "'")
    s = re.sub(r"[^a-z0-9' ]+", ' ', s).replace("'", '')
    words = [ROMAN.get(w, w) for w in s.split()]
    words = [w for w in words if w not in STOP and not (drop_level and w in LEVEL)]
    return ' '.join(words)


def sim(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


def dist_m(a, b):
    ky, kx = 111320, 111320 * math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * ky, (a[1] - b[1]) * kx)


# --- 1. licenses: seed ↔ NYSED -------------------------------------------------------------------
def best(name, pool, key):
    n = norm(name)
    scored = sorted(((sim(n, norm(key(p))), p) for p in pool), key=lambda x: -x[0])
    return scored[0] if scored else (0, None)


ALIAS = {  # seed name → NYSED name, where the official name changed (checked by hand on both sources)
}
lic_match, seed_unmatched = {}, []
used = set()
for s in seed:
    score, p = best(ALIAS.get(s['name'], s['name']), nysed, lambda r: r['name'])
    if score >= 0.86 and id(p) not in used:
        lic_match[s['id']] = (p, round(score, 3))
        used.add(id(p))
    else:
        seed_unmatched.append((s, p, round(score, 3)))
nysed_unmatched = [r for r in nysed if id(r) not in used]

# --- 2. campuses: FINDER ↔ seed (name + location) ------------------------------------------------
camp_to_seed, finder_unmatched = {}, []
for c in finder:
    cn = norm(c['name'], drop_level=True)
    cands = []
    for s in seed:
        sn = norm(s['name'], drop_level=True)
        ns = sim(cn, sn)
        if cn.startswith(sn) or sn.startswith(cn):
            ns = max(ns, 0.92)
        d = dist_m((c['lat'], c['lng']), (s['lat'], s['lng'])) if c.get('lat') else 1e9
        cands.append((ns, d, s))
    # same license: strong name match, or same building with a decent name match
    good = [x for x in cands if x[0] >= 0.85 or (x[1] < 120 and x[0] >= 0.6)]
    if good:
        ns, d, s = max(good, key=lambda x: (x[0], -x[1]))
        camp_to_seed[c['u']] = (s['id'], round(ns, 3), round(d))
    else:
        finder_unmatched.append(c)

by_seed = collections.defaultdict(list)
for u, (sid, ns, d) in camp_to_seed.items():
    by_seed[sid].append((u, d))
seed_no_campus = [s for s in seed if s['id'] not in by_seed]
moved = []
for s in seed:
    if s['id'] in by_seed:
        dmin = min(d for _, d in by_seed[s['id']])
        if dmin > 400:
            moved.append((s['id'], s['name'], s['address'], dmin))


# --- 3. network check: Success Academy ------------------------------------------------------------
def is_sa(name):
    return 'success academy' in name.lower()


net = {
    'seed_licenses': sum(is_sa(s['name']) for s in seed),
    'nysed_licenses': sum(is_sa(r['name']) for r in nysed),
    'finder_campuses': sum(is_sa(c['name']) for c in finder),
    'network_site_campuses': len(sa_site),
}
sa_finder = {norm(c['name'], True) for c in finder if is_sa(c['name'])}
sa_site_missing_in_finder = [x.get('h1') or x['u'] for x in sa_site
                             if not any(sim(norm('success academy ' + (x.get('h1') or ''), True), f) > 0.85 for f in sa_finder)]

report = {
    'sources': {
        'seed': f'{len(seed)} schools (NYC DOE 2019-20 School Locations, wg9x-4ke6)',
        'nysed': f'{len(nysed)} NYC charter licenses (NYSED directory as of 2025-09-02; includes approved schools not yet open)',
        'finder': f'{len(finder)} campuses (NYC Charter School Center FINDER, pulled 2026-10-17)',
        'success_academy_site': f'{len(sa_site)} campuses (successacademies.org, pulled 2026-10-17)',
    },
    'licenses': {
        'matched': len(lic_match),
        'seed_not_in_nysed': [{'id': s['id'], 'name': s['name'], 'closest_nysed': p['name'] if p else None, 'score': sc} for s, p, sc in seed_unmatched],
        'nysed_not_in_seed': [{'name': r['name'], 'district': r['district'], 'opened': r['opened'], 'authorizer': r['authorizer'], 'sed_code': r['sed_code']} for r in nysed_unmatched],
    },
    'campuses': {
        'finder_matched_to_seed': len(camp_to_seed),
        'finder_not_matched': [{'u': c['u'], 'name': c['name'], 'street': c['street'], 'boro': c['boro'], 'grades': c['grades']} for c in finder_unmatched],
        'seed_without_finder_campus': [{'id': s['id'], 'name': s['name'], 'address': s['address']} for s in seed_no_campus],
        'seed_far_from_every_campus': [{'id': i, 'name': n, 'address': a, 'nearest_m': d} for i, n, a, d in moved],
        'campuses_per_seed_school': collections.Counter(len(v) for v in by_seed.values()),
    },
    'success_academy': {**net, 'site_campuses_not_in_finder': sa_site_missing_in_finder},
}
(SRC / 'reconciliation.json').write_text(json.dumps(report, indent=1, default=str))

L, C = report['licenses'], report['campuses']
print(json.dumps(report['sources'], indent=1))
print(f"\nLicenses: {L['matched']} of {len(seed)} seed schools matched to NYSED; "
      f"{len(L['seed_not_in_nysed'])} seed schools not in NYSED; {len(L['nysed_not_in_seed'])} NYSED licenses not in seed")
print(f"Campuses: {C['finder_matched_to_seed']} of {len(finder)} FINDER campuses tied to a seed school; "
      f"{len(C['finder_not_matched'])} unmatched; {len(C['seed_without_finder_campus'])} seed schools with no FINDER campus; "
      f"{len(C['seed_far_from_every_campus'])} seed schools >400 m from all their campuses")
print('Success Academy:', json.dumps(report['success_academy']))
