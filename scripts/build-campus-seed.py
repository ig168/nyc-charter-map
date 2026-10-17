#!/usr/bin/env python3
"""
Builds the campus-level seed (data/seed/schools.json) by combining independent sources and recording,
for every campus, which sources confirm it and which checks it fails.

Sources (all in data/sources/):
  finder-campuses.json        NYC Charter School Center FINDER: 418 campus pages (pulled 2026-10-17)
  network-sites.json          KIPP NYC, Achievement First, Ascend, Uncommon campus lists from their websites
  success-academy-campuses.json  Success Academy's 59 campus pages
  nys-charter-school-directory-as-of-09-02-2025.xlsx   NYSED list of licensed charter schools
  location-checks.json        NYC Planning GeoSearch geocode of every address, plus the official school
                              district (8ugf-3d8u) and neighborhood (2020 NTA, 9nt8-h7nd) at each point
  data/seed/schools-2019-licenses.json   the previous license-level seed (NYC DOE 2019-20), used only to
                              carry over facts for the same school (DOE code, mission, network apply details)

Rules
  * Network websites are the authority for their own campuses (they list each elementary, middle and
    high school separately; FINDER sometimes merges them). FINDER listings for those networks that match
    no current network campus are left out and reported.
  * Every campus must be geocoded by GeoSearch inside NYC; pins use the geocoded point unless the source's
    own coordinates are within 150 m of it (then the source point is kept).
  * District and neighborhood come from the official boundary maps, not from any listing.
  * Nothing is invented: a fact no source gives stays null and the app shows "Not available".
"""
import json, math, re, difflib, collections, pathlib, datetime
import openpyxl, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from geocode_check import matches as geo_matches

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'data' / 'sources'
TODAY = '2026-10-17'
CYCLE, DEADLINE = '2027-28', '2027-04-01'
COMMON_APP = 'https://nyccharterschools.schoolmint.net/signup'
BORO_LETTER = {'Manhattan': 'm', 'Brooklyn': 'k', 'Bronx': 'x', 'Queens': 'q', 'Staten Island': 'r'}
BORO_FIX = {'New York': 'Manhattan', 'Manhattan': 'Manhattan', 'Brooklyn': 'Brooklyn', 'Bronx': 'Bronx', 'The Bronx': 'Bronx',
            'Queens': 'Queens', 'Staten Island': 'Staten Island', 'Kings': 'Brooklyn', 'Richmond': 'Staten Island'}
GRADES = ['PK', '0K', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']

finder = [c for c in json.loads((SRC / 'finder-campuses.json').read_text())['campuses'] if c and c.get('name')]
netsites = json.loads((SRC / 'network-sites.json').read_text())['networks']
sa = json.loads((SRC / 'success-academy-campuses.json').read_text())['campuses']
loc = json.loads((SRC / 'location-checks.json').read_text())
old = json.loads((ROOT / 'data/seed/schools-2019-licenses.json').read_text())['schools']
wb = openpyxl.load_workbook(SRC / 'nys-charter-school-directory-as-of-09-02-2025.xlsx', read_only=True)
nysed = [dict(zip(['active', 'inst_id', 'sed_code', 'name', 'district', 'county', 'region', 'opened', 'authorizer'], r[:9]))
         for r in wb.active.iter_rows(min_row=3, values_only=True) if r[3] and r[6] == 'New York City']
fgeo = {g['u']: g for g in loc['finder']}
ngeo = {g['k']: g for g in loc['network']}
FIX = json.loads((SRC / 'location-fixes.json').read_text())['fixes']
NBORO = json.loads((SRC / 'network-boroughs.json').read_text())


def confirmed_geo(key, street, boro):
    """GeoSearch result only if it is the same building (house number + street), else a re-geocode fix, else None."""
    if key in FIX:
        return FIX[key]
    g = (fgeo.get(key[2:]) if key.startswith('F|') else ngeo.get(key)) or {}
    geo = g.get('geo')
    if geo and geo_matches(street, geo['label'], boro):
        if key.startswith('F|'):
            geo = {**geo, 'csd': g.get('geoCsd'), 'nta': None}
        return geo
    return None

# ---------------------------------------------------------------------------------------------
NETWORKS = [  # (pattern on campus name, canonical network name)
    (r'success academy', 'Success Academy Charter Schools'), (r'\bkipp\b', 'KIPP NYC'), (r'achievement first', 'Achievement First'),
    (r'\buncommon\b', 'Uncommon Schools'), (r'\bascend\b', 'Ascend Public Charter Schools'), (r'\bzeta\b', 'Zeta Charter Schools'),
    (r'\bbrilla\b', 'Brilla Public Charter Schools'), (r'democracy prep', 'Democracy Prep Public Schools'),
    (r'promise academy', "Harlem Children's Zone"), (r'\bicahn\b', 'Icahn Charter Schools'),
    (r'south bronx classical|classical charter', 'Classical Charter Schools'), (r'girls prep|boys prep|public prep', 'Public Prep'),
    (r'\bdream\b', 'DREAM'), (r'\bexplore\b', 'Explore Schools'), (r'\bhyde\b', 'Hyde Leadership Charter Schools'),
    (r'harlem village', 'Harlem Village Academies'), (r'great oaks', 'Great Oaks Charter Schools'), (r'\bamber\b', 'Amber Charter Schools'),
    (r'capital prep', 'Capital Preparatory Schools'), (r'brooklyn prospect', 'Brooklyn Prospect Charter Schools'),
    (r'urban dove', 'Urban Dove'), (r'united charter high|new visions', 'United Charter High Schools (formerly New Visions)'),
    (r'bronx charter school for excellence', 'Bronx Charter School for Excellence'), (r'family life', 'Family Life Academy Charter Schools'),
    (r'inwood academy', 'Inwood Academy'), (r'hebrew', 'Hebrew Public'), (r'east harlem scholars', 'East Harlem Scholars Academies'),
    (r'storefront academy', 'Storefront Academy Charter Schools'), (r'growing up green', 'Growing Up Green Charter Schools'),
    (r'our world neighborhood', 'Our World Neighborhood Charter Schools'), (r'nyc autism', 'NYC Autism Charter Schools'),
    (r'new dawn', 'New Dawn Charter Schools'), (r'brooklyn lab', 'Brooklyn LAB'), (r'hellenic', 'Hellenic Classical Charter Schools'),
    (r'success academy', 'Success Academy Charter Schools'), (r'lamad', 'Lamad Academy Charter Schools'),
    (r'renaissance charter', 'Renaissance Charter Schools'), (r'mott haven academy', 'Mott Haven Academy'),
]
AUTHORITATIVE = {'Success Academy Charter Schools', 'KIPP NYC', 'Achievement First', 'Uncommon Schools', 'Ascend Public Charter Schools'}


STREET_TYPES = {'STREET', 'AVENUE', 'ROAD', 'PLACE', 'DRIVE', 'LANE', 'TERRACE', 'COURT', 'BOULEVARD', 'PARKWAY', 'ST', 'AVE', 'RD', 'PL', 'DR', 'BLVD', 'PKWY'}
SPELL = {'BLEEKER': 'BLEECKER', 'FT': 'FORT', 'MT': 'MOUNT', "B'WAY": 'BROADWAY', 'BWAY': 'BROADWAY'}  # aliases/abbreviations in listings


def tidy_address(listed, label=None):
    """Listed street address in normal capitalization with ordinals ('532 West 215th Street');
    a word the geocoder spells differently by one or two letters (a typo such as 'Streeet') takes the geocoder's spelling."""
    street = re.sub(r'\.?\s*(Queens|Brooklyn|Bronx|Manhattan|Staten Island)\s*$', '', (listed or '').split(',')[0].strip(), flags=re.I)
    street = re.sub(r'\s+(Floor|Fl|Suite|Ste|Room|Rm|#)\b.*$', '', street, flags=re.I).strip().rstrip('.')
    ref = [w for w in re.split(r'\s+', (label or '').split(',')[0].upper()) if w]
    words = street.upper().split()
    out = []
    for i, w in enumerate(words):
        w = SPELL.get(w, w)
        base = re.sub(r'(\d+)(ST|ND|RD|TH)$', r'\1', w)
        if len(w) > 4 and not re.search(r'\d', w) and w not in [r.upper() for r in ref]:
            close = [r for r in ref if not re.search(r'\d', r) and len(r) >= len(w) - 2 and difflib.SequenceMatcher(None, w, r).ratio() >= 0.8]
            if close:
                w = base = SPELL.get(close[0], close[0])
        nxt = words[i + 1] if i + 1 < len(words) else ''
        if i > 0 and re.fullmatch(r'\d+', base) and nxt.upper() in STREET_TYPES:
            n = int(base)
            out.append(f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}")
        elif re.fullmatch(r'[\d-]+[A-Z]?', w):
            out.append(w)
        elif w in ('N', 'S', 'E', 'W'):
            out.append(w)
        else:
            out.append(w.capitalize() if "'" not in w else w[0] + w[1:].lower())
    return ' '.join(out)


def network_of(name):
    for pat, net in NETWORKS:
        if re.search(pat, name, re.I):
            return net
    return None


ABR = {'STREET': 'ST', 'AVENUE': 'AVE', 'AV': 'AVE', 'BOULEVARD': 'BLVD', 'PLACE': 'PL', 'ROAD': 'RD', 'PARKWAY': 'PKWY', 'DRIVE': 'DR',
       'EAST': 'E', 'WEST': 'W', 'NORTH': 'N', 'SOUTH': 'S', 'TERRACE': 'TER', 'LANE': 'LN', 'FIRST': '1', 'SECOND': '2', 'THIRD': '3',
       'FOURTH': '4', 'FIFTH': '5', 'SAINT': 'ST', 'CONCOURSE': 'CONC', 'PAULS': 'PAUL'}


def akey(a):
    if not a:
        return None
    a = re.sub(r"[.']", '', a.upper().split(',')[0])
    a = re.sub(r'\b(FLOOR|FL|SUITE|STE|ROOM|RM|#)\b.*$', '', a)
    a = ' '.join(ABR.get(w, w) for w in a.split())
    a = re.sub(r'(\d+)(ST|ND|RD|TH)\b', r'\1', a)
    return re.sub(r'\s+', ' ', a).strip()


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0])))


def grades_of(text):
    """'K,1,2' | 'K-4' | 'K to 4' | '5 to 8' | 'PK,K' → ['0K','01',...]"""
    if not text:
        return []
    t = text.upper().replace('PRE-K', 'PK').replace('KINDERGARTEN', 'K').replace(' THROUGH ', '-').replace(' TO ', '-').replace('–', '-')
    def code(g):
        g = g.strip()
        if g in ('PK', '3K'):
            return 'PK'
        if g == 'K':
            return '0K'
        if g.isdigit() and 1 <= int(g) <= 12:
            return f'{int(g):02d}'
        return None
    out = set()
    for part in re.split(r'[,/;]| AND ', t):
        part = part.strip()
        m = re.match(r'^(PK|K|\d{1,2})\s*-\s*(K|\d{1,2})$', part)
        if m:
            a, b = code(m.group(1)), code(m.group(2))
            if a and b:
                out.update(GRADES[GRADES.index(a):GRADES.index(b) + 1])
        elif code(part):
            out.add(code(part))
    return [g for g in GRADES if g in out]


def phone_of(p):
    d = re.sub(r'\D', '', p or '')
    if len(d) == 11 and d[0] == '1':
        d = d[1:]
    return f'{d[:3]}-{d[3:6]}-{d[6:]}' if len(d) == 10 else None


def https(u):
    if not u:
        return None
    u = u.strip()
    if u.startswith('http://'):
        u = 'https://' + u[7:]
    return u if re.match(r'^https://[^\s"<>]+$', u) else None


def norm(name):
    s = re.sub(r'[^a-z0-9 ]+', ' ', name.lower().replace('&', ' and ').replace('–', '-'))
    stop = {'charter', 'school', 'schools', 'the', 'of', 'for', 'and', 'academy', 'public', 'nyc', 'campus'}
    return ' '.join(w for w in s.split() if w not in stop)


def slug(s):
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s.lower())).strip('-')[:70]


# ---------------------------------------------------------------------------------------------
# 1. Candidate campuses from network websites (authoritative for their networks)
cands = []
for x in sa:
    key = 'SA|' + x['u'].rstrip('/').split('/')[-1]
    name = 'Success Academy ' + (x.get('h1') or '').replace('A Groundbreaking K-12 Campus.', 'Bronx K-12 Campus').strip()
    if key == 'SA|k12campus':
        name = 'Success Academy Bronx K-12 Campus'
    cands.append({'key': key, 'name': name, 'network': 'Success Academy Charter Schools', 'street': (x.get('street') or '').split(',')[0].strip(),
                  'zip': x.get('zip'), 'phone': phone_of(x.get('phone')), 'grades_text': x.get('grades'), 'entry_text': x.get('appGrades'),
                  'website': https(x['u']), 'district_src': int(x['district']) if (x.get('district') or '').isdigit() else None,
                  'sources': ['Success Academy website'], 'formerly': None})
for net, v in netsites.items():
    cols = v.get('columns', ['name', 'grades', 'street', 'borough'])
    canon = {'KIPP NYC': 'KIPP NYC', 'Achievement First': 'Achievement First', 'Ascend Public Charter Schools': 'Ascend Public Charter Schools', 'Uncommon Schools': 'Uncommon Schools'}[net]
    for row in v['campuses']:
        r = dict(zip(cols, row))
        cands.append({'key': net[:3] + '|' + r['name'], 'name': r['name'], 'network': canon, 'street': r.get('street'), 'zip': r.get('zip'),
                      'phone': phone_of(r.get('phone')), 'grades_text': r.get('grades'), 'entry_text': None, 'website': https(v['url']),
                      'district_src': None, 'sources': [f'{canon} website'], 'formerly': r.get('formerly')})

# 2. FINDER campuses: corroborate network campuses, or stand on their own
dropped, finder_used = [], set()
for c in finder:
    net = network_of(c['name'])
    g = fgeo.get(c['u']) or {}
    if net in AUTHORITATIVE:
        # same network + same building (address or geocoded within 60 m) + compatible level
        best = None
        for k in cands:
            if k['network'] != net:
                continue
            if not k['street']:  # network site gave no address: match the FINDER listing by name alone
                ns = difflib.SequenceMatcher(None, norm(k['name']), norm(c['name'])).ratio()
                if ns >= 0.9 and (not best or ns > best[0]):
                    best = (ns, k)
                continue
            same_addr = akey(k['street']) and akey(k['street']) == akey(c['street'])
            kg = confirmed_geo(k['key'], k['street'], NBORO.get(k['key']))
            near = kg and dist((kg['lat'], kg['lng']), (c['lat'], c['lng'])) < 60
            if not (same_addr or near):
                continue
            ns = difflib.SequenceMatcher(None, norm(k['name']), norm(c['name'])).ratio()
            if not best or ns > best[0]:
                best = (ns, k)
        if best:
            k = best[1]
            k.setdefault('finder', []).append(c)
            finder_used.add(c['u'])
            if 'NYC Charter School Center FINDER' not in k['sources']:
                k['sources'].append('NYC Charter School Center FINDER')
        else:
            dropped.append({'name': c['name'], 'street': c['street'], 'reason': f'not on the {net} website at this address'})
        continue
    cands.append({'key': 'F|' + c['u'], 'name': re.sub(r'\s+', ' ', c['name'].replace('\xa0', ' ')).strip(), 'network': net,
                  'street': c['street'], 'zip': c['zip'], 'phone': phone_of(c['phone']), 'grades_text': c['grades'], 'entry_text': None,
                  'website': https(c['web']), 'apply': https(c['apply']), 'district_src': int(c['csd'][0]) if len(c['csd']) == 1 else None,
                  'sources': ['NYC Charter School Center FINDER'], 'formerly': None, 'finder': [c], 'fpt': (c['lat'], c['lng'])})

# 3. Collapse exact duplicates (same name and building)
seen, uniq, dupes = {}, [], []
for k in cands:
    sig = (norm(k['name']), akey(k['street']))
    if sig in seen:
        dupes.append(k['name'])
        continue
    seen[sig] = k
    uniq.append(k)

# 4. Location: GeoSearch is the check for every campus
lic_names = [(norm(r['name']), r) for r in nysed]
records, rejected = [], []
for k in uniq:
    f0 = (k.get('finder') or [None])[0]
    boro_hint = (f0 or {}).get('boro') or NBORO.get(k['key'])
    if (not k.get('street')) and f0:  # network site gave no address (e.g. Uncommon Bed-Stuy East MS): use FINDER's
        k['street'], k['zip'] = f0['street'], f0['zip']
        k['key_for_geo'] = 'F|' + f0['u']
    gkey = k.get('key_for_geo') or k['key']
    geo = confirmed_geo(gkey, k['street'], boro_hint) if k.get('street') else None
    src_pt = (f0['lat'], f0['lng']) if f0 else None
    flags = []
    if geo:
        gd = round(dist((geo['lat'], geo['lng']), src_pt)) if src_pt else None
        if src_pt and gd <= 150:
            lat, lng = src_pt
        else:
            lat, lng = geo['lat'], geo['lng']
            if src_pt:
                flags.append(f'FINDER pin was {gd} m from the address; pin moved to the geocoded address')
            gd = 0
        csd = geo.get('csd') if geo.get('csd') else (fgeo.get(gkey[2:]) or {}).get('csd')
        nta = geo.get('nta') or (fgeo.get(gkey[2:]) or {}).get('nta')
        if src_pt and gd <= 150 and gkey.startswith('F|'):
            csd, nta = (fgeo.get(gkey[2:]) or {}).get('csd') or csd, (fgeo.get(gkey[2:]) or {}).get('nta') or nta
    elif src_pt:
        lat, lng = src_pt
        gd = None
        g = fgeo.get(f0['u']) or {}
        csd, nta = g.get('csd'), g.get('nta')
        flags.append('address is not in the city geocoder (often a new building); location from FINDER')
    else:
        rejected.append({'name': k['name'], 'street': k['street'], 'reason': 'address could not be confirmed by the geocoder and no other source gives a location'})
        continue
    tidy = tidy_address(k['street'], geo.get('label') if geo else None)
    if tidy:
        k['street'] = tidy
    boro = BORO_FIX.get((geo or {}).get('boro') or '', None) or BORO_FIX.get((f0 or {}).get('boro', ''), None) or BORO_FIX.get(boro_hint or '', None)
    if not boro:
        rejected.append({'name': k['name'], 'street': k['street'], 'reason': 'borough unknown'})
        continue
    zip_ = (geo or {}).get('zip') or k.get('zip')
    if k.get('zip') and geo and geo.get('zip') and k['zip'] != geo['zip']:
        flags.append(f"listed zip {k['zip']} differs from geocoded zip {geo['zip']}; geocoded zip used")
    if k.get('district_src') and csd and k['district_src'] != csd:
        flags.append(f"listed district {k['district_src']} differs from the district map ({csd}); map used")
    grades = grades_of(k['grades_text'])
    if not grades:
        for f in k.get('finder') or []:
            grades = grades_of(f.get('grades'))
            if grades:
                break
    if not grades:
        rejected.append({'name': k['name'], 'street': k['street'], 'reason': 'no source gives the grades served'})
        continue
    entry = [g for g in grades_of(k.get('entry_text')) if g in grades] or [grades[0]]
    # NYSED license (state check): best name match, also trying the former name
    best = (0, None)
    level = re.compile(r'\(.*?\)|\b(elementary|middle|high|lower|upper|primary|intermediate|campus|grades?\s*[k0-9 ,&-]+)\b', re.I)
    names = [k['name'], level.sub(' ', k['name']), k.get('formerly') or '']
    names += [f['name'] for f in k.get('finder') or []] + [level.sub(' ', f['name']) for f in k.get('finder') or []]
    for nm in names:
        if not nm:
            continue
        n = norm(nm)
        for ln, r in lic_names:
            s = difflib.SequenceMatcher(None, n, ln).ratio()
            if s > best[0]:
                best = (s, r)
    lic = best[1] if best[0] >= 0.82 else None
    if lic:  # numbered schools must agree on the number (Excellence 2 is not Excellence 3; Bronx 1 is not Bronx 5)
        def nums(t):
            t = re.sub(r'\b(i{1,3}|iv|v|vi{0,3}|ix|x)\b', lambda m: str({'i': 1, 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10}[m.group(1)]), t.lower())
            t = re.sub(r'grades?\s*[k0-9 ,&-]+|\(.*?\)|csd\s*\d+|\d+(st|nd|rd|th)\b', ' ', t)
            return set(re.findall(r'\b\d{1,2}\b', t))
        ln = nums(lic['name'])
        cn = set().union(*[nums(n) for n in names if n])
        if (ln or cn) and not (ln & cn) and not (not ln and len(cn) == 0):
            if ln != cn:
                lic = None
    records.append({**k, 'lat': round(lat, 6), 'lng': round(lng, 6), 'borough': boro, 'zip': zip_, 'district': csd, 'neighborhood': nta,
                    'grades': grades, 'entry': entry, 'geo_d': gd, 'geocoded': bool(geo), 'license': lic, 'lic_score': round(best[0], 3), 'flags': flags})

# 5. Carry over facts from the 2019-20 license seed for the same school (same building and similar name)
old_by_net = collections.defaultdict(list)
for o in old:
    old_by_net[o['network']].append(o)
used_old = collections.Counter()
for r in records:
    best = None
    for o in old:
        d = dist((o['lat'], o['lng']), (r['lat'], r['lng']))
        same = akey(o['address']) == akey(r['street']) or d < 60
        if not same:
            continue
        ns = max(difflib.SequenceMatcher(None, norm(o['name']), norm(r['name'])).ratio(),
                 difflib.SequenceMatcher(None, norm(o['name']), norm(r.get('formerly') or '')).ratio())
        if ns >= 0.55 and (not best or ns > best[0]):
            best = (ns, o)
    r['old'] = best[1] if best else None
    if best:
        used_old[best[1]['id']] += 1

# 6. Network-level admissions details (from the previous seed, checked against network sites 2026-10-17)
NET_ADMIT = {}
for n, l in old_by_net.items():
    if n:
        NET_ADMIT[n] = l[0]


def admissions_for(r):
    base = NET_ADMIT.get(r['network'])
    a = dict(base['admissions']) if base else None
    c = dict(base['contact_costs']) if base else None
    district = r['district']
    pref = ('Returning students; Siblings of students already enrolled; ' + (f'Students living in Community School District {district}. ' if district else '') +
            'Some schools also prefer English language learners, students with disabilities, or students eligible for free or reduced-price lunch.')
    if not a:
        a = {'cycle': CYCLE, 'how_to_apply': "Apply with the school's own application, or the NYC Charter School Center Common Online Charter School Application.",
             'eligibility': 'Open to all New York City children entering the grades the school serves. Charter schools must admit students of all kinds and cannot use admissions tests.',
             'application_open': None, 'application_deadline': DEADLINE,
             'deadline_note': "By law the deadline can't be earlier than April 1; some schools accept applications later. Confirm with the school.",
             'lottery_date': None, 'lottery_note': 'If applications exceed seats, a random lottery is held (typically April–May).',
             'apply_url': COMMON_APP, 'apply_url_label': 'Common Online Charter School Application'}
    a['lottery_preferences'] = pref
    a['cycle'] = CYCLE
    a['application_deadline'] = DEADLINE
    if r.get('apply') and r['network'] not in AUTHORITATIVE:
        a['apply_url'] = r['apply']
        a['apply_url_label'] = 'School application'
    c = c or {'phone': None, 'email': None, 'website': None, 'tuition_free': True, 'uniform': None, 'after_care': None, 'meals': None,
              'transportation': 'NYC DOE school bus or student OMNY card, based on grade and walking distance. Confirm with the school.'}
    c['phone'] = r['phone'] or next((phone_of(f.get('phone')) for f in r.get('finder') or [] if phone_of(f.get('phone'))), None)
    c['website'] = r['website'] or next((https(f.get('web')) for f in r.get('finder') or [] if https(f.get('web'))), None) or c.get('website')
    c['email'] = (r['old'] or {}).get('contact_costs', {}).get('email') if r['old'] and r['old']['network'] == r['network'] else None
    c['tuition_free'] = True
    return a, c


# Campuses sharing a name get their grade range (and street if needed) so families can tell them apart
def glabel(g):
    lab = lambda x: 'Pre-K' if x == 'PK' else 'K' if x == '0K' else str(int(x))
    return lab(g[0]) if len(g) == 1 else f'{lab(g[0])}–{lab(g[-1])}'


name_count = collections.Counter(r['name'] for r in records)
for r in records:
    if name_count[r['name']] > 1:
        r['official_name'] = r['name']
        r['name'] = f"{r['name']} (Grades {glabel(r['grades'])})"
name_count = collections.Counter(r['name'] for r in records)
for r in records:
    if name_count[r['name']] > 1:
        r['name'] = r['name'][:-1] + f", {r['street'].title()})"

out, ids = [], set()
for r in sorted(records, key=lambda x: (x['borough'], x['name'])):
    sid = BORO_LETTER[r['borough']] + '-' + slug(r['name'])
    base, i = sid, 2
    while sid in ids:
        sid, i = f'{base}-{i}', i + 1
    ids.add(sid)
    a, c = admissions_for(r)
    o = r['old']
    lic = r['license']
    sources = list(r['sources']) + ['NYC Planning GeoSearch (location)', 'NYC school district and 2020 neighborhood maps']
    if lic:
        sources.append('NYSED Charter School Directory (license)')
    if o:
        sources.append('NYC DOE 2019–20 School Locations (DOE code, mission)')
    checks = {
        'confirmed_by': [s for s in r['sources']] + (['NYSED license list'] if lic else []) + (['NYC Planning GeoSearch'] if r['geocoded'] else []),
        'geocoded': r['geocoded'], 'pin_vs_address_m': r['geo_d'],
        'license': {'name': lic['name'], 'sed_code': str(lic['sed_code']), 'authorizer': lic['authorizer'], 'opened': lic['opened']} if lic else None,
        'flags': r['flags'],
        'notes': [] if lic else ['campus name does not match a license name in the NYSED directory (networks often run several campuses under one license)'],
    }
    out.append({
        'id': sid, 'name': r['name'], 'official_name': r.get('official_name'), 'network': r['network'], 'borough': r['borough'], 'district': r['district'], 'zip': r['zip'],
        'neighborhood': r['neighborhood'], 'address': r['street'], 'lat': r['lat'], 'lng': r['lng'],
        'grades_served': r['grades'], 'entry_grades': r['entry'],
        'enrollment': o.get('enrollment') if o and used_old[o['id']] == 1 else None,
        'enrollment_year': '2020–21' if o and used_old[o['id']] == 1 and o.get('enrollment') is not None else None, 'year_founded': lic['opened'] if lic else (o or {}).get('year_founded'),
        'mission': (o or {}).get('mission') or (NET_ADMIT.get(r['network']) or {}).get('mission'),
        'building_code': (o or {}).get('building_code'), 'doe_code': (o or {}).get('id'),
        'source': '; '.join(sources), 'last_verified': TODAY, 'checks': checks,
        'admissions': a, 'contact_costs': c,
    })

seed = {
    'version': '2026-10-17.2', 'generated': TODAY, 'unit': 'campus',
    'description': 'Campus-level list of open NYC charter schools, cross-checked across independent sources. Facts without a source are null.',
    'sources': {
        'finder': 'https://findnyccharterschools.org/', 'nysed': 'https://www.nysed.gov/charter-schools/charter-schools-directory',
        'networks': {k: v['url'] for k, v in netsites.items()} | {'Success Academy Charter Schools': 'https://www.successacademies.org/schools/'},
        'geocoder': 'https://geosearch.planninglabs.nyc/', 'districts': 'https://data.cityofnewyork.us/d/8ugf-3d8u',
        'neighborhoods': 'https://data.cityofnewyork.us/d/9nt8-h7nd', 'previous_seed': 'https://data.cityofnewyork.us/d/wg9x-4ke6',
        'admissions_rules': 'https://www.schools.nyc.gov/enrollment/enroll-in-charter-schools/how-to-enroll-in-charter-schools',
    },
    'schools': out,
}
(ROOT / 'data/seed/schools.json').write_text(json.dumps(seed, indent=1, ensure_ascii=False))
report = {'campuses': len(out), 'dropped_finder_listings': dropped, 'duplicates_collapsed': dupes, 'rejected': rejected,
          'old_schools_carried': len(used_old), 'by_network': collections.Counter(s['network'] or '(independent)' for s in out).most_common(),
          'flags': collections.Counter(f.split(';')[0].split(' m ')[0][:60] for s in out for f in s['checks']['flags']).most_common()}
(SRC / 'build-report.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
print(json.dumps({k: (v if not isinstance(v, list) or len(v) < 12 else f'{len(v)} items') for k, v in report.items()}, indent=1, ensure_ascii=False))
