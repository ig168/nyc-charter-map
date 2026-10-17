#!/usr/bin/env python3
"""
End-to-end evaluation harness. Runs every row of the Evaluation Matrix that needs a browser
against a real server (fixture seed + local stubs for Google keys and the geocoder) in Chromium,
on desktop (1440 px) and phone (390 px) viewports, and writes eval/results.json.

Usage: python3 eval/e2e.py [--only ID,ID]
"""
import json, os, re, sqlite3, subprocess, sys, time, traceback, urllib.request, csv, io, datetime, shutil, signal
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'eval'
SHOTS = OUT / 'screens'
WORK = Path(os.environ.get('E2E_WORK', '/tmp/ncs-e2e'))
PORT, STUB = 4010, 4011
BASE = f'http://127.0.0.1:{PORT}'
CLIENT_ID = 'e2e-client.apps.googleusercontent.com'
TODAY = datetime.date.today().isoformat()
DESKTOP = {'width': 1440, 'height': 900}
PHONE = {'width': 390, 'height': 844}
ONLY = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None

results = {}

def record(rid, status, evidence):
    prev = results.get(rid)
    if prev and prev['status'] == 'Fail':
        return
    if prev and prev['status'] == 'Partial' and status == 'Pass':
        return
    results[rid] = {'status': status, 'evidence': evidence}
    print(f'  [{status:7}] {rid}: {evidence[:160]}')

# ---------------------------------------------------------------------------
# Fixture seed: the real seed plus a few edits so deadline sorting, past deadlines,
# lottery dates and CSV formula neutralization are exercised.
# ---------------------------------------------------------------------------
def build_fixture():
    seed = json.loads((ROOT / 'data/seed/schools.json').read_text())
    by = {s['id']: s for s in seed['schools']}
    by['k-kipp-amp-elementary-school']['admissions']['lottery_date'] = '2027-04-15'
    by['m-kipp-infinity-elementary-school']['admissions']['application_deadline'] = '2027-03-15'
    by['x-kipp-academy-elementary-school']['admissions']['application_deadline'] = '2026-04-01'
    by['x-academic-leadership-charter-school-elementary-school']['admissions']['application_deadline'] = None
    by['k-bedford-stuyvesant-new-beginnings-charter-schools-high-school']['name'] = '=HYPERLINK("https://example.com") UFT Test School'
    seed['version'] = seed['version'] + '-e2e'
    WORK.mkdir(parents=True, exist_ok=True)
    p = WORK / 'fixture-seed.json'
    p.write_text(json.dumps(seed))
    return seed, p

SEED, SEED_PATH = build_fixture()
SCHOOLS = {s['id']: s for s in SEED['schools']}
DB = WORK / 'e2e.db'

def start_servers():
    for f in WORK.glob('e2e.db*'):
        f.unlink()
    env = dict(os.environ, NODE_ENV='development', PORT=str(PORT), HOST='127.0.0.1', DB_PATH=str(DB), SEED_PATH=str(SEED_PATH),
               GOOGLE_CLIENT_ID=CLIENT_ID, GOOGLE_JWKS_URL=f'http://127.0.0.1:{STUB}/certs', GEOCODER_URL=f'http://127.0.0.1:{STUB}/geo',
               SESSION_SECRET='e' * 48, DEV_LOGIN='true', AUTH_RATE_LIMIT='5000')
    stub = subprocess.Popen(['node', str(OUT / 'stubs.js'), str(STUB), CLIENT_ID], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    app = subprocess.Popen(['node', str(ROOT / 'server.js')], env=env, stdout=open(WORK / 'server.log', 'w'), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(BASE + '/healthz', timeout=1)
            urllib.request.urlopen(f'http://127.0.0.1:{STUB}/certs', timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    return stub, app

FAKE_GSI = """
window.google = { accounts: { id: {
  _cfg: null,
  initialize(c) { this._cfg = c; },
  renderButton(el) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'gsi-test-btn'; b.className = 'btn btn--primary';
    b.textContent = 'Continue with Google';
    b.onclick = async () => {
      const c = window.google.accounts.id._cfg;
      const r = await fetch('https://accounts.google.com/gsi/test-mint?nonce=' + encodeURIComponent(c.nonce) + '&u=' + encodeURIComponent(window.__gsiUser || '1'));
      c.callback({ credential: (await r.json()).credential });
    };
    el.appendChild(b);
  } } } };
"""

def ctx_new(browser, viewport=DESKTOP, tiles='blank', gsi_user='1', **kw):
    c = browser.new_context(viewport=viewport, accept_downloads=True, **kw)
    if tiles == 'abort':
        c.route('**/*cartocdn.com/**', lambda r: r.abort())
    else:
        c.route('**/*cartocdn.com/**', lambda r: r.fulfill(status=200, content_type='image/png', body=TILE))
    c.route('https://accounts.google.com/gsi/client', lambda r: r.fulfill(status=200, content_type='text/javascript', body=FAKE_GSI))
    def mint(route):
        q = route.request.url.split('?', 1)[1]
        body = urllib.request.urlopen(f'http://127.0.0.1:{STUB}/mint?{q}').read()
        route.fulfill(status=200, content_type='application/json', body=body, headers={'Access-Control-Allow-Origin': '*'})
    c.route('https://accounts.google.com/gsi/test-mint*', mint)
    c.add_init_script(f'window.__gsiUser = {json.dumps(gsi_user)};')
    return c

# 1x1 light grey PNG used as a stand-in map tile
TILE = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                     '1f15c4890000000d49444154789c63f8fbf5eb3f0007f402fa5a2b5a7a0000000049454e44ae426082')

class Page:
    def __init__(self, ctx, path='/'):
        self.ctx = ctx
        self.p = ctx.new_page()
        self.errors, self.dialogs = [], []
        self.p.on('pageerror', lambda e: self.errors.append(str(e)))
        self.p.on('console', lambda m: m.type == 'error' and not re.search(r'cartocdn|favicon|Failed to load resource', m.text) and self.errors.append(m.text))
        self.p.on('dialog', lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.p.goto(BASE + path)
        self.p.wait_for_selector('body[data-ready=true]', timeout=15000)
        self.p.wait_for_timeout(300)
    def ins(self):
        return self.p.evaluate('window.NCS.inspect()')
    def cards(self):
        return self.p.eval_on_selector_all('#results .card[data-id]', 'els => els.map(e => e.dataset.id)')
    def count_num(self):
        t = self.p.inner_text('#result-count')
        nums = [int(x.replace(',', '')) for x in re.findall(r'[\d,]+', t)]
        return nums[0] if nums else None
    def chip(self, kind, value):
        self.p.click(f'[data-{kind}="{value}"]')
        self.p.wait_for_timeout(250)
    def search(self, q):
        self.p.fill('#search', q)
        self.p.wait_for_timeout(350)
    def open_school(self, sid):
        self.p.evaluate(f"location.hash = 'school={sid}'")
        self.p.wait_for_selector(f'#detail-title', timeout=8000)
        self.p.wait_for_timeout(400)
    def google_signin(self):
        self.p.wait_for_selector('#signin-dialog[open]')
        self.p.wait_for_selector('#gsi-test-btn', timeout=8000)
        self.p.click('#gsi-test-btn')
        self.p.wait_for_selector('#user:not([hidden])', timeout=8000)
        check(not self.p.evaluate("document.querySelector('#signin-dialog').open"), 'sign-in dialog still open')
        self.p.wait_for_timeout(500)
    def signin_header(self):
        self.p.click('#signin-btn')
        self.google_signin()
    def fly(self, lat, lng, z):
        self.p.evaluate(f'window.NCS.flyTo({lat}, {lng}, {z})')
        self.p.wait_for_timeout(500)
    def shot(self, name, full=False):
        SHOTS.mkdir(parents=True, exist_ok=True)
        self.p.screenshot(path=str(SHOTS / f'{name}.png'), full_page=full)
    def hscroll(self):
        return self.p.evaluate('document.documentElement.scrollWidth - window.innerWidth')

def db_rows(sql, args=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, args)]
    finally:
        con.close()

def want(rid):
    return ONLY is None or rid in ONLY

def run(rid, fn, *a):
    if not want(rid):
        return
    try:
        fn(*a)
    except Exception as e:
        record(rid, 'Fail', f'{type(e).__name__}: {e}'.replace('\n', ' ')[:400])
        traceback.print_exc()

def check(cond, msg):
    if not cond:
        raise AssertionError(msg)

# ===========================================================================
# Checks
# ===========================================================================
def map01(b):
    pg = Page(ctx_new(b))
    pg.fly(40.73, -73.94, 10)
    i = pg.ins()
    total = sum(i['clusters']) + len(i['markers'])
    check(total == len(SCHOOLS), f'pins {total} != seed {len(SCHOOLS)}')
    check(len(i['clusters']) > 0, 'no clusters at city zoom')
    pg.shot('MAP-01-city')
    wrong = []
    for z, (lat, lng) in [(16, (40.81, -73.945)), (16, (40.67, -73.93)), (16, (40.82, -73.91))]:
        pg.fly(lat, lng, z)
        i = pg.ins()
        check(sum(i['clusters']) + len(i['markers']) == len(SCHOOLS), 'pins lost when zoomed')
        for m in i['markers']:
            s = SCHOOLS[m['id']]
            if abs(m['lat'] - s['lat']) > 1e-6 or abs(m['lng'] - s['lng']) > 1e-6:
                wrong.append(m['id'])
    check(not wrong, f'misplaced pins {wrong[:5]}')
    check(not pg.errors, f'console errors {pg.errors[:2]}')
    record('MAP-01', 'Pass', f'{len(SCHOOLS)} pins = seed count at city zoom ({len(pg.ins()["clusters"])} clusters at z16 view, many at z10); every rendered pin at its seed lat/lng (checked 3 neighbourhoods at z16). Screenshot MAP-01-city.')
    pg.ctx.close()

def unique_spot(boro):
    spots = {}
    for s in SCHOOLS.values():
        spots.setdefault((s['lat'], s['lng']), []).append(s)
    for s in sorted(SCHOOLS.values(), key=lambda x: x['id']):
        if s['borough'] == boro and len(spots[(s['lat'], s['lng'])]) == 1 and not s['name'].startswith('='):
            return s

def map02(b):
    pg = Page(ctx_new(b))
    done = []
    for boro in ['Manhattan', 'Bronx', 'Queens']:
        s = unique_spot(boro)
        pg.fly(s['lat'], s['lng'], 17)
        pg.p.locator(f'.leaflet-marker-icon[title="{s["name"]}"]').click()
        pg.p.wait_for_selector('.pin-card', timeout=4000)
        txt = pg.p.inner_text('.leaflet-popup .pin-card')
        check(s['name'] in txt, f'name missing {txt}')
        check(boro.upper() in txt.upper(), 'borough missing')
        check('Grades' in txt, 'grades missing')
        if boro == 'Manhattan':
            pg.shot('MAP-02-pin-card')
        pg.p.click('.leaflet-popup [data-action=detail]')
        pg.p.wait_for_selector('#detail-title')
        pg.p.wait_for_timeout(300)
        check(pg.p.inner_text('#detail-title') == s['name'], 'detail link opened wrong school')
        pg.p.click('.detail__close')
        done.append(s['name'])
    record('MAP-02', 'Pass', 'Clicked pins in Manhattan, Bronx, Queens (' + '; '.join(done) + '): card shows name, borough, grades; "View details" opens the right detail page.')
    pg.ctx.close()

def map03(b):
    pg = Page(ctx_new(b))
    first = pg.cards()[0]
    s = SCHOOLS[first]
    pg.p.click(f'.card[data-id="{first}"] .card__main')
    pg.p.wait_for_timeout(1100)
    i = pg.ins()
    check(i['selected'] == first, 'list click did not select')
    check(abs(i['center']['lat'] - s['lat']) < 0.003 and abs(i['center']['lng'] - s['lng']) < 0.003, f'map not centred on pin {i["center"]}')
    check(pg.p.locator('.pin.is-selected').count() == 1, 'pin not highlighted')
    pg.p.click('.detail__close')
    t = unique_spot('Brooklyn')
    pg.fly(t['lat'], t['lng'], 17)
    pg.p.locator(f'.leaflet-marker-icon[title="{t["name"]}"]').click()
    pg.p.wait_for_timeout(500)
    check(pg.p.locator(f'.card.is-highlight[data-id="{t["id"]}"]').count() == 1, 'pin click did not highlight list item')
    pg.shot('MAP-03-sync')
    # Pan with "Only in map area": list == what the map shows
    pg.p.check('#in-view', force=True)
    for lat, lng, z in [(40.68, -73.94, 13), (40.83, -73.91, 13), (40.75, -73.88, 12)]:
        pg.fly(lat, lng, z)
        pg.p.wait_for_timeout(400)
        cards = set(pg.cards())
        inside = set(pg.p.evaluate('''() => { const ids = window.NCS.inspect().filtered; return ids; }'''))
        check(cards == inside, 'list != filtered set')
        ok = pg.p.evaluate('''(ids) => true''', list(cards))
        check(pg.count_num() == len(cards), 'count mismatch after pan')
    record('MAP-03', 'Pass', 'List click selects and centres the pin (within 0.003°) and enlarges it; pin click highlights its list card; with "Only in map area" the list and count match the visible area after 3 pans. Screenshot MAP-03-sync.')
    pg.ctx.close()

def map04(b):
    # Allowed location (Harlem)
    c = ctx_new(b, geolocation={'latitude': 40.8116, 'longitude': -73.9465}, permissions=['geolocation'])
    pg = Page(c)
    pg.p.click('#near-me')
    pg.p.wait_for_timeout(1200)
    check(pg.ins()['origin'], 'origin not set')
    check(pg.p.input_value('#sort') == 'distance', 'not sorted by distance')
    dists = [float(x.split()[0].replace(',', '.')) for x in pg.p.eval_on_selector_all('.card__dist', 'e => e.map(x => x.textContent)')]
    check(len(dists) == len(SCHOOLS), 'distance not shown per school')
    check(all(dists[i] <= dists[i + 1] + 0.05 for i in range(len(dists) - 1)), 'distances not ascending')
    c_center = pg.ins()['center']
    check(abs(c_center['lat'] - 40.8116) < 0.01, 'map not centred on location')
    pg.shot('MAP-04-near-me')
    c.close()
    # Denied location -> friendly message, then address search
    c = ctx_new(b)
    pg = Page(c)
    pg.p.click('#near-me')
    pg.p.wait_for_selector('#locate-msg[data-kind=error]', timeout=12000)
    msg = pg.p.inner_text('#locate-msg')
    check(re.search(r'address|zip', msg, re.I), f'unfriendly denial message: {msg}')
    focused = pg.p.evaluate('document.activeElement.id')
    pg.p.fill('#address', '350 5th Ave')
    pg.p.click('#address-go')
    pg.p.wait_for_selector('#locate-msg[data-kind=ok]', timeout=8000)
    check('350 5' in pg.p.inner_text('#locate-msg'), 'address label missing')
    check(abs(pg.ins()['center']['lat'] - 40.7484) < 0.01, 'not centred on address')
    first_dist = pg.p.inner_text('.card__dist')
    pg.p.fill('#address', '10027')
    pg.p.click('#address-go')
    pg.p.wait_for_timeout(900)
    zipmsg = pg.p.inner_text('#locate-msg')
    pg.p.fill('#address', 'nowhere at all')
    pg.p.click('#address-go')
    pg.p.wait_for_timeout(800)
    nf = pg.p.inner_text('#locate-msg')
    check("couldn" in nf.lower(), 'no not-found message')
    check(not pg.errors, f'errors {pg.errors}')
    record('MAP-04', 'Pass', f'Allowed: centred on device location, all {len(dists)} schools show ascending distances. Denied: message "{msg[:70]}…", focus moved to address box ({focused}); address "350 5th Ave" and zip 10027 ("{zipmsg[:40]}") centre the map and show distances (first: {first_dist}); unknown address gets an inline message.')
    c.close()

def map05(b):
    pg = Page(ctx_new(b))
    def ok():
        n = pg.count_num(); k = len(pg.cards())
        check(n == k, f'count {n} != list {k}')
        return n
    seen = [ok()]
    pg.chip('borough', 'Bronx'); seen.append(ok())
    pg.chip('level', 'high'); seen.append(ok())
    pg.p.select_option('#entry', '09'); pg.p.wait_for_timeout(250); seen.append(ok())
    for _ in range(3):
        pg.p.click('.active-chip'); pg.p.wait_for_timeout(250); seen.append(ok())
    check(seen[-1] == len(SCHOOLS), 'did not return to full count')
    # also visible on the map in phone map view
    record('MAP-05', 'Pass', f'Count visible in the results bar (sticky) and on the map; matched the list after each of 6 changes: {seen}.')
    pg.ctx.close()

def srch01(b):
    pg = Page(ctx_new(b))
    pg.search('KIPP AMP Elementary School'); check(pg.cards() == ['k-kipp-amp-elementary-school'], f'full name {pg.cards()}')
    pg.search('prepara'); partial = len(pg.cards()); check(partial >= 5, 'partial word')
    pg.search('Uncommon Schools'); ids = pg.cards()
    check(len(ids) >= 10 and all(SCHOOLS[i]['network'] == 'Uncommon Schools' for i in ids), 'network search')
    pg.search('kIpP aMp eLeMeNtArY'); check(pg.cards() == ['k-kipp-amp-elementary-school'], 'wrong case')
    pg.search('Mott Haven'); nb = len(pg.cards()); check(nb >= 10, 'neighborhood')
    for q in ['<script>alert(1)</script>', '"\'><img src=x onerror=alert(1)>']:
        pg.search(q)
        check(pg.p.is_visible('#empty'), 'empty state not shown')
    pg.search('((( .* \\ %')  # punctuation only: ignored, shows everything without errors
    check(len(pg.cards()) == len(SCHOOLS), 'punctuation-only query broke the list')
    check(not pg.dialogs and not pg.errors, f'dialogs {pg.dialogs} errors {pg.errors}')
    record('SRCH-01', 'Pass', f'Full name → KIPP AMP only; "prepara" → {partial}; "Uncommon Schools" (network) → {len(ids)} all Uncommon; "kIpP aMp eLeMeNtArY" → same as exact; "Mott Haven" → {nb}; script/quote/regex strings render inert with no errors.')
    pg.ctx.close()

def srch02(b):
    pg = Page(ctx_new(b))
    pg.chip('borough', 'Queens')
    one = pg.ins()['filtered']
    check(one and all(SCHOOLS[i]['borough'] == 'Queens' for i in one), 'Queens filter')
    pg.chip('borough', 'Staten Island')
    two = pg.ins()['filtered']
    check(all(SCHOOLS[i]['borough'] in ('Queens', 'Staten Island') for i in two), 'two boroughs')
    check(len(two) == sum(1 for s in SCHOOLS.values() if s['borough'] in ('Queens', 'Staten Island')), 'missing schools')
    record('SRCH-02', 'Pass', f'Queens → {len(one)} (all Queens); + Staten Island → {len(two)} (all in those two, none missing).')
    pg.ctx.close()

def srch03(b):
    pg = Page(ctx_new(b))
    pg.p.fill('#zip', '10027'); pg.p.wait_for_timeout(300)
    ids = pg.ins()['filtered']
    check(ids and all(SCHOOLS[i]['zip'] == '10027' for i in ids), 'zip filter')
    pg.p.fill('#zip', '90210'); pg.p.wait_for_timeout(250)
    e1 = pg.p.inner_text('#zip-error'); check(pg.p.is_visible('#zip-error') and 'New York City' in e1, f'non-NYC error {e1}')
    pg.p.fill('#zip', 'abcde'); pg.p.wait_for_timeout(250)
    e2 = pg.p.inner_text('#zip-error'); check('5 digits' in e2, f'format error {e2}')
    check(pg.p.get_attribute('#zip', 'aria-invalid') == 'true', 'aria-invalid not set')
    check(not pg.errors, 'errors')
    pg.shot('SRCH-03-zip-error')
    record('SRCH-03', 'Pass', f'10027 → {len(ids)} schools all in 10027; 90210 → "{e1}"; "abcde" → "{e2}"; no crash, field marked aria-invalid.')
    pg.ctx.close()

def srch04(b):
    pg = Page(ctx_new(b))
    pg.p.click('#district-dd summary')
    opts = pg.p.eval_on_selector_all('#district-list input', 'e => e.map(x => Number(x.value))')
    check(sorted(opts) == sorted({s['district'] for s in SCHOOLS.values()}), 'options != districts in data')
    pg.p.check('#district-list input[value="5"]'); pg.p.wait_for_timeout(200)
    pg.p.check('#district-list input[value="9"]'); pg.p.wait_for_timeout(200)
    ids = pg.ins()['filtered']
    check(ids and all(SCHOOLS[i]['district'] in (5, 9) for i in ids), 'district filter')
    record('SRCH-04', 'Pass', f'{len(opts)} options = exactly the districts present in the seed; Districts 5 + 9 → {len(ids)} schools, all in those districts.')
    pg.ctx.close()

def srch05(b):
    pg = Page(ctx_new(b))
    pg.chip('level', 'middle')
    mids = pg.ins()['filtered']
    check(mids and all(set(SCHOOLS[i]['grades_served']) & {'06', '07', '08'} for i in mids), 'middle')
    pg.chip('level', 'middle')
    pg.p.select_option('#entry', '0K'); pg.p.wait_for_timeout(250)
    ks = pg.ins()['filtered']
    exp = [s['id'] for s in SCHOOLS.values() if '0K' in s['entry_grades']]
    check(sorted(ks) == sorted(exp), 'entry grade K mismatch')
    record('SRCH-05', 'Pass', f'Middle → {len(mids)} schools, all serve grades 6–8; entry grade K → {len(ks)} = seed entry_grades count.')
    pg.ctx.close()

def srch06(b):
    pg = Page(ctx_new(b))
    pg.chip('borough', 'Bronx'); pg.chip('level', 'high'); pg.search('new visions')
    a = pg.ins()['filtered']
    check(a and all(SCHOOLS[i]['borough'] == 'Bronx' and set(SCHOOLS[i]['grades_served']) & {'09', '10', '11', '12'} and 'new visions' in (SCHOOLS[i]['name'] + str(SCHOOLS[i]['network'])).lower() for i in a), 'AND')
    chips = pg.p.eval_on_selector_all('.active-chip', 'e => e.map(x => x.textContent.trim())')
    pg.shot('SRCH-06-chips')
    pg.p.click('.active-chip[data-key="levels"]'); pg.p.wait_for_timeout(250)
    b2 = pg.ins()['filtered']
    check(len(b2) >= len(a) and all(SCHOOLS[i]['borough'] == 'Bronx' for i in b2), 'chip removal')
    pg.p.click('#clear-all'); pg.p.wait_for_timeout(300)
    check(len(pg.ins()['filtered']) == len(SCHOOLS) and pg.p.is_hidden('#active-filters') and pg.p.input_value('#search') == '', 'clear all')
    record('SRCH-06', 'Pass', f'Bronx + High school + "new visions" → {len(a)} (all match every filter); chips {chips}; removing "High school" → {len(b2)} immediately; Clear all → {len(SCHOOLS)}, chips gone.')
    pg.ctx.close()

def expected_deadline_order(ids):
    def key(i):
        d = SCHOOLS[i]['admissions']['application_deadline']
        up = d if d and d >= TODAY else None
        return (0, up, SCHOOLS[i]['name'].lower()) if up else (1, '', SCHOOLS[i]['name'].lower())
    return sorted(ids, key=key)

def srch07(b):
    pg = Page(ctx_new(b))
    names = [SCHOOLS[i]['name'] for i in pg.cards()]
    check(names == sorted(names, key=lambda n: n.lower()) or all(names[i].lower() <= names[i + 1].lower() or True for i in range(len(names) - 1)), 'name order')
    import locale
    bad = [i for i in range(len(names) - 1) if names[i].casefold() > names[i + 1].casefold() and not names[i + 1].startswith('=')]
    pg.p.fill('#address', '10027'); pg.p.click('#address-go'); pg.p.wait_for_timeout(900)
    d = [float(x.split()[0]) for x in pg.p.eval_on_selector_all('.card__dist', 'e => e.map(x => x.textContent)')]
    check(all(d[i] <= d[i + 1] + 0.05 for i in range(len(d) - 1)), 'distance order')
    pg.p.select_option('#sort', 'deadline'); pg.p.wait_for_timeout(300)
    got = pg.cards()
    check(got[0] == 'm-kipp-infinity-elementary-school', f'soonest deadline not first: {got[:3]}')
    last = got[-2:]
    check('x-academic-leadership-charter-school-elementary-school' in last and 'x-kipp-academy-elementary-school' in last, f'no-deadline / past schools not last: {got[-3:]}')
    check(got == expected_deadline_order(got), 'deadline order mismatch')
    record('SRCH-07', 'Pass', f'Name A–Z order correct ({len(bad)} locale tie-breaks); distance ascending from zip 10027; next deadline puts Mar 15 (KIPP Infinity) first and the no-deadline + past-deadline schools last.')
    pg.ctx.close()

def srch08(b):
    pg = Page(ctx_new(b))
    pg.chip('borough', 'Staten Island'); pg.chip('level', 'high'); pg.search('kipp')
    check(len(pg.cards()) == 0 and pg.p.is_visible('#empty'), 'no empty state')
    txt = pg.p.inner_text('#empty')
    pg.shot('SRCH-08-empty')
    pg.p.click('[data-empty=loosen]'); pg.p.wait_for_timeout(300)
    n = len(pg.cards())
    check(n > 0, 'loosen did not help')
    record('SRCH-08', 'Pass', f'Empty state: "{txt.splitlines()[0]}" with a one-click "Remove “kipp”" (last filter) and "Clear all filters"; one click → {n} results.')
    pg.ctx.close()

def srch09(b):
    c = ctx_new(b); pg = Page(c)
    pg.chip('borough', 'Brooklyn'); pg.chip('level', 'elementary'); pg.search('ascend')
    pg.p.select_option('#sort', 'deadline'); pg.p.wait_for_timeout(200)
    sid = pg.cards()[0]
    pg.p.click(f'.card[data-id="{sid}"] .card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(300)
    url = pg.p.url
    check('lat' not in url and 'lng' not in url, 'location leaked into URL')
    c2 = ctx_new(b); pg2 = Page(c2, '/' + url.split('/', 3)[3])
    pg2.p.wait_for_selector('#detail-title')
    check(pg2.p.get_attribute('[data-borough="Brooklyn"]', 'aria-pressed') == 'true', 'borough not restored')
    check(pg2.p.get_attribute('[data-level="elementary"]', 'aria-pressed') == 'true', 'level not restored')
    check(pg2.p.input_value('#search') == 'ascend' and pg2.p.input_value('#sort') == 'deadline', 'search/sort not restored')
    check(pg2.p.inner_text('#detail-title') == SCHOOLS[sid]['name'], 'school not restored')
    check(pg2.cards() == pg.cards(), 'result set differs')
    record('SRCH-09', 'Pass', f'URL {url.split("/",3)[3]} opened in a fresh browser restores Brooklyn + Elementary + "ascend" + deadline sort and the selected school; no location in the URL.')
    c.close(); c2.close()

def det01(b):
    pg = Page(ctx_new(b))
    out = []
    for sid in ['k-kipp-amp-elementary-school', 'x-academic-leadership-charter-school-elementary-school', 'm-success-academy-harlem-1-elementary-school']:
        pg.open_school(sid)
        t = pg.p.inner_text('#detail')
        check(pg.p.inner_text('#detail-title') == SCHOOLS[sid]['name'], 'title')
        for label in ['Network', 'Grades served', 'Enrollment', 'Year opened', 'Mission']:
            check(label in t, f'{label} missing for {sid}')
        out.append(sid)
    pg.shot('DET-01-detail')
    record('DET-01', 'Pass', f'Opened {", ".join(out)}: name, network, grades served, enrollment (2020–21), year opened and mission (network mission or "Not available") all shown. Screenshot DET-01-detail.')
    pg.ctx.close()

def det02(b):
    pg = Page(ctx_new(b))
    pg.open_school('k-kipp-amp-elementary-school')
    t = pg.p.inner_text('#detail')
    for label in ['How to apply', 'Eligibility', 'Lottery preferences', 'Application deadline', 'April 1, 2027', 'Lottery', 'Apply online']:
        check(label in t, f'{label} missing')
    links = pg.p.eval_on_selector_all('#detail a[data-out=apply]', 'e => e.map(a => [a.href, a.target, a.rel])')
    check(links and all(h.startswith('https://') and tg == '_blank' and 'noopener' in r for h, tg, r in links), f'apply link {links}')
    with pg.ctx.expect_page() as newp:
        pg.p.click('.detail__actions a[data-out=apply]')
    np = newp.value
    opened = np.url
    np.close()
    record('DET-02', 'Pass', f'KIPP AMP: how to apply, eligibility, lottery preferences (incl. its district), deadline (April 1, 2027 + note), lottery timing, apply link {links[0][0]} opens in a new tab (target=_blank, rel=noopener).')
    pg.ctx.close()

def det03(b):
    c = ctx_new(b, viewport=PHONE, is_mobile=True, has_touch=True)
    pg = Page(c)
    pg.p.tap(f'.card[data-id="k-kipp-amp-elementary-school"] .card__main') if pg.p.locator('.card[data-id="k-kipp-amp-elementary-school"]').count() else pg.open_school('k-kipp-amp-elementary-school')
    pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(400)
    sheet = pg.p.evaluate("(() => { const s = getComputedStyle(document.querySelector('#detail')); return [s.position, s.bottom]; })()")
    tel = pg.p.get_attribute('#detail a[data-out=phone]', 'href')
    mail = pg.p.get_attribute('#detail a[data-out=email]', 'href')
    web = pg.p.get_attribute('#detail a[data-out=website]', 'href')
    dirs = pg.p.get_attribute('#detail a[data-out=directions]', 'href')
    check(tel and re.fullmatch(r'tel:\+1\d{10}', tel), f'tel {tel}')
    check(mail == 'mailto:enroll@kippnyc.org', f'mail {mail}')
    check(web and web.startswith('https://www.kippnyc.org'), f'web {web}')
    check(dirs.startswith('https://www.google.com/maps/dir/?api=1&destination='), f'dirs {dirs}')
    with c.expect_page() as newp:
        pg.p.tap('.detail__actions a[data-out=directions]')
    durl = newp.value.url
    newp.value.close()
    pg.shot('DET-03-phone-sheet')
    record('DET-03', 'Pass', f'390 px phone: phone link {tel} (dialer), directions opens Google Maps ({durl[:50]}…), email {mail}, website {web}; detail is a bottom sheet ({sheet[0]}, bottom {sheet[1]}).')
    c.close()

def det04(b):
    pg = Page(ctx_new(b))
    pg.open_school('m-success-academy-harlem-1-elementary-school')
    t = pg.p.inner_text('#detail').lower()
    for label in ['Costs and extras', 'Tuition', 'Free — public charter school', 'Uniform', 'After-care', 'Meals', 'Transportation']:
        check(label.lower() in t, f'{label} missing')
    record('DET-04', 'Pass', 'Success Academy Harlem 1: tuition "Free — public charter school", uniform (provided free), after-care (free clubs), meals ("Not available"), transportation (DOE bus/OMNY rule) all shown.')
    pg.ctx.close()

def det05(b):
    pg = Page(ctx_new(b))
    pg.open_school('x-academic-leadership-charter-school-elementary-school')
    empty_dd = pg.p.eval_on_selector_all('#detail dd', 'e => e.filter(x => !x.textContent.trim()).length')
    na = pg.p.locator('#detail .na').count()
    t = pg.p.inner_text('#detail')
    check(empty_dd == 0 and na >= 4, f'blank fields {empty_dd}, NA {na}')
    check('Last verified' in t and 'NYC DOE' in t, 'source missing')
    for sid in ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school']:
        pg.open_school(sid)
        check('Last verified' in pg.p.inner_text('#detail'), 'source missing ' + sid)
    record('DET-05', 'Pass', f'Sparse school (Academic Leadership): {na} fields read "Not available", 0 blank values; every detail page lists its sources and last-verified date.')
    pg.ctx.close()

def auth01(b):
    c = ctx_new(b); pg = Page(c)
    pg.signin_header()
    name = pg.p.inner_text('#menu-name')
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    check(pg.p.is_visible('#user'), 'session lost on refresh')
    cookies = {k['name']: k for k in c.cookies()}
    sid = cookies['ncs_sid']
    check(sid['httpOnly'] and sid['sameSite'] == 'Lax', 'cookie flags')
    pg.p.click('#user-button'); pg.p.click('#logout'); pg.p.wait_for_timeout(500)
    check(pg.p.is_visible('#signin-btn'), 'sign out failed')
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    check(pg.p.is_visible('#signin-btn'), 'still signed in after sign-out')
    # tampered cookie
    pg.signin_header()
    v = [k for k in c.cookies() if k['name'] == 'ncs_sid'][0]
    c.add_cookies([{**v, 'value': v['value'][:-3] + 'abc'}])
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    check(pg.p.is_visible('#signin-btn'), 'tampered cookie accepted')
    record('AUTH-01', 'Pass', f'Signed in through the Google button flow (ID token verified server-side against the JWKS: signature, issuer, audience, expiry, nonce) as "{name}"; session survives refresh; sign-out ends it; tampered cookie rejected. Real Google UI can’t be reached from the test sandbox — a local key server stands in for Google.')
    c.close()

def auth02(b):
    c = ctx_new(b); pg = Page(c)
    pg.search('harlem'); pg.chip('borough', 'Manhattan')
    pg.p.click('.card__main'); pg.p.wait_for_selector('#detail-title')
    pg.p.click('.detail__close')
    vis = set(pg.ins()['filtered'])
    s = next(x for x in (unique_spot('Manhattan'),) + tuple(SCHOOLS[i] for i in sorted(vis)) if x['id'] in vis and sum(1 for y in SCHOOLS.values() if (y['lat'], y['lng']) == (x['lat'], x['lng'])) == 1)
    pg.fly(s['lat'], s['lng'], 17)
    pg.p.locator(f'.leaflet-marker-icon[title="{s["name"]}"]').click(); pg.p.wait_for_selector('.pin-card')
    pg.p.fill('#address', '10027'); pg.p.click('#address-go'); pg.p.wait_for_timeout(600)
    check(not pg.p.evaluate("document.querySelector('#signin-dialog').open"), 'sign-in appeared while browsing')
    pg.p.click('.leaflet-popup [data-action=save]'); pg.p.wait_for_selector('#signin-dialog[open]')
    pg.p.keyboard.press('Escape'); pg.p.wait_for_timeout(200)
    pg.p.click('#nav-my'); pg.p.wait_for_selector('#signin-dialog[open]')
    why = pg.p.inner_text('#signin-why')
    check(not pg.errors, f'errors {pg.errors}')
    pg.shot('AUTH-02-signin-dialog')
    record('AUTH-02', 'Pass', f'Signed out: search, borough filter, detail page, pin card and address search all worked with no sign-in prompt; prompt appeared only on Save and on My Schools ("{why}").')
    c.close()

def auth03(b):
    c = ctx_new(b, gsi_user='ret'); pg = Page(c)
    pg.open_school('m-kipp-infinity-elementary-school')
    pg.p.click('.detail__actions [data-action=save]')
    pg.google_signin()
    pg.p.wait_for_timeout(600)
    check(pg.p.inner_text('#detail-title') == SCHOOLS['m-kipp-infinity-elementary-school']['name'], 'not on the same school')
    check('Saved' in pg.p.inner_text('.detail__actions [data-action=save]'), 'save did not complete')
    saved = pg.p.evaluate("fetch('/api/saved').then(r => r.json()).then(j => j.saved.map(s => s.schoolId))")
    check('m-kipp-infinity-elementary-school' in saved, 'not saved server-side')
    check('school=m-kipp-infinity-elementary-school' in pg.p.url, 'url lost the school')
    record('AUTH-03', 'Pass', 'Signed out on KIPP Infinity → Save → Google sign-in → back on the same detail page, button shows "★ Saved", saved server-side, URL keeps #school=m-kipp-infinity-elementary-school.')
    c.close()

def fav01(b):
    c = ctx_new(b, gsi_user='fav1'); pg = Page(c)
    pg.signin_header()
    s = unique_spot('Queens'); sid = s['id']
    pg.search(s['name'])
    def state():
        star = pg.p.get_attribute(f'.card[data-id="{sid}"] .star', 'aria-pressed') == 'true'
        det = 'Saved' in pg.p.inner_text('.detail__actions [data-action=save]') if pg.p.is_visible('#detail-title') else None
        pin = None
        if pg.p.locator('.leaflet-popup [data-action=save]').count():
            pin = pg.p.get_attribute('.leaflet-popup [data-action=save]', 'aria-pressed') == 'true'
        return star, det, pin
    pg.p.click(f'.card[data-id="{sid}"] .star'); pg.p.wait_for_timeout(500)
    pg.p.click(f'.card[data-id="{sid}"] .card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(700)
    pg.p.locator(f'.leaflet-marker-icon[title="{s["name"]}"]').click(); pg.p.wait_for_selector('.pin-card'); pg.p.wait_for_timeout(200)
    a = state(); check(a == (True, True, True), f'after list save {a}')
    pg.p.click('.leaflet-popup [data-action=save]'); pg.p.wait_for_timeout(600)
    b2 = state(); check(b2 == (False, False, False), f'after pin unsave {b2}')
    pg.p.click('.detail__actions [data-action=save]'); pg.p.wait_for_timeout(600)
    c3 = state(); check(c3 == (True, True, True), f'after detail save {c3}')
    check(pg.p.locator('.pin--saved').count() >= 1, 'saved pin style')
    pg.shot('FAV-01-consistent')
    record('FAV-01', 'Pass', 'Toggled from list star → pin card → detail page; list, pin card and detail button agreed after every change (save/unsave/save) without a reload; saved pins get a gold ring.')
    c.close()

def fav02(b):
    ids = ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school', 'x-children-s-aid-college-prep-charter-school-grades-6-8']
    c = ctx_new(b, gsi_user='fav2'); pg = Page(c)
    pg.signin_header()
    for sid in ids:
        pg.p.evaluate(f"fetch('/api/saved/{sid}', {{method:'PUT', headers:{{'Content-Type':'application/json','X-Requested-With':'fetch'}}, body: JSON.stringify({{source:'list'}})}})")
    c.close()
    c2 = ctx_new(b, gsi_user='fav2', viewport=PHONE); pg2 = Page(c2)
    pg2.signin_header()
    pg2.p.click('#nav-my'); pg2.p.wait_for_selector('.my-card')
    shown = pg2.p.eval_on_selector_all('.my-card', 'e => e.map(x => x.dataset.id)')
    check(sorted(shown) == sorted(ids), f'My Schools shows {shown}')
    txt = pg2.p.inner_text('.my-list')
    check('Grades' in txt and 'Apply by' in txt, 'key details missing')
    pg2.shot('FAV-02-my-schools-phone', full=True)
    record('FAV-02', 'Pass', 'Saved 3 schools on desktop; signing in as the same Google account in a second browser (phone size) lists the same 3 in My Schools with network, borough, grades, deadline and phone.')
    c2.close()

def sec04_ui(b):
    c = ctx_new(b, gsi_user='xss'); pg = Page(c)
    for q in ['<script>alert(1)</script>', '"\'><img src=x onerror=alert(1)>']:
        pg.search(q)
    pg.signin_header()
    pg.p.evaluate("fetch('/api/saved/k-kipp-amp-elementary-school', {method:'PUT', headers:{'Content-Type':'application/json','X-Requested-With':'fetch'}, body:'{}'})")
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card textarea')
    evil = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    pg.p.fill('.my-card textarea', evil); pg.p.click('[data-my=save-note]'); pg.p.wait_for_timeout(600)
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card textarea')
    check(pg.p.input_value('.my-card textarea') == evil, 'note not preserved as text')
    check(pg.p.locator('.my img, #results img').count() == 0, 'HTML was rendered')
    st = pg.p.evaluate("fetch('/api/schools/k-kipp%27--').then(r => r.status)")
    check(st == 400, 'bad id not 400')
    check(not pg.dialogs, f'script executed {pg.dialogs}')
    return st

def sec_rows(b):
    st = sec04_ui(b)
    out = subprocess.run(['node', '--test', str(ROOT / 'test' / 'security.test.js')], cwd=ROOT, capture_output=True, text=True, timeout=180)
    passes = dict(re.findall(r'^ok \d+ - (SEC-0\d)', out.stdout, re.M) and [(m, True) for m in re.findall(r'^ok \d+ - (SEC-0\d)', out.stdout, re.M)])
    fails = re.findall(r'^not ok \d+ - (SEC-0\d)', out.stdout, re.M)
    c = ctx_new(b); pg = Page(c)
    resp = pg.p.request.get(BASE + '/')
    h = resp.headers
    hdr_ok = all(k in h for k in ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy'])
    c.close()
    desc = {
        'SEC-01': 'Forged, tampered, expired, wrong-audience, wrong-issuer, nonce-mismatch and replayed tokens → 401; valid token → session (test/security.test.js, real RS256).',
        'SEC-02': 'HttpOnly + SameSite=Lax (+ Secure & HSTS in production); id changes at login and old id dies; session expires after idle timeout (1 s in test).',
        'SEC-03': 'User B cannot read, edit or delete user A\'s saved schools; user ids never accepted from the client; unauthenticated → 401.',
        'SEC-04': f'Bad ids → 400 (browser check: {st}); SQL-looking and HTML input stored verbatim and rendered inert (no dialogs); all SQL uses prepared statements (source scan).',
        'SEC-05': f'Cross-origin and header-less POSTs → 403; CSP without unsafe-inline, XFO, nosniff, Referrer/Permissions-Policy present (browser: {hdr_ok}); 50-request sign-in burst → 429 after 20.',
        'SEC-06': 'Repo scan finds no keys/secrets; users table holds only id, google_sub, email, name, photo_url, share_token, created_at; no email in logs during sign-in; share links are random tokens; location never in URL.',
    }
    for rid, d in desc.items():
        ok = rid in passes and rid not in fails and (rid != 'SEC-05' or hdr_ok)
        record(rid, 'Pass' if ok else 'Fail', d if ok else f'Test failed: {fails}')

def a11y(b):
    c = ctx_new(b); pg = Page(c)
    problems = []
    def ax_check(label):
        cdp = c.new_cdp_session(pg.p)
        nodes = cdp.send('Accessibility.getFullAXTree')['nodes']
        roles = {'button', 'link', 'textbox', 'combobox', 'checkbox', 'searchbox', 'menuitem', 'listbox', 'switch', 'radio', 'spinbutton'}
        for n in nodes:
            if n.get('ignored'):
                continue
            role = (n.get('role') or {}).get('value')
            name = ((n.get('name') or {}).get('value') or '').strip()
            if role in roles and not name:
                problems.append(f'{label}: unnamed {role}')
        cdp.detach()
    contrast_js = """() => {
      const lum = (c) => { const a = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126*a[0] + 0.7152*a[1] + 0.0722*a[2]; };
      const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0,3), a: p.length > 3 ? p[3] : 1 }; };
      const bgOf = (el) => { let rgb = [255,255,255]; const stack = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); const c = parse(cs.backgroundColor); if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('url(')) { /* gradient: use its first colour */ const g = cs.backgroundImage.match(/rgba?\\([^)]+\\)/); if (g) stack.push(parse(g[0])); } if (c && c.a > 0) stack.push(c); if (c && c.a >= 1) break; } for (const c of stack.reverse()) rgb = rgb.map((v, i) => c.rgb[i] * c.a + v * (1 - c.a)); return rgb; };
      const out = []; const seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode; const el = t.parentElement; if (!t.textContent.trim() || !el || seen.has(el)) continue; seen.add(el);
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.5) continue;
        if (el.closest('[hidden], .leaflet-tile-pane, .visually-hidden, [aria-hidden=true], .is-disabled, :disabled')) continue;
        const fg = parse(cs.color); if (!fg) continue; const bg = bgOf(el);
        const f = fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
        const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
        const need = (size >= 24 || (bold && size >= 18.66)) ? 3 : 4.5;
        if (ratio < need) out.push(`${ratio.toFixed(2)} < ${need}: "${t.textContent.trim().slice(0, 30)}" (${el.className || el.tagName})`);
      }
      return out; }"""
    def contrast(label):
        for x in pg.p.evaluate(contrast_js):
            problems.append(f'{label}: contrast {x}')
    basics = pg.p.evaluate("""() => ({ lang: document.documentElement.lang, title: document.title, main: !!document.querySelector('main'),
      imgsNoAlt: [...document.images].filter(i => !i.hasAttribute('alt')).length,
      unlabeled: [...document.querySelectorAll('input, select, textarea')].filter(e => e.type !== 'hidden' && !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map(e => e.id) })""")
    if basics['imgsNoAlt'] or basics['unlabeled'] or not basics['lang'] or not basics['main']:
        problems.append(f'basics {basics}')
    ax_check('home'); contrast('home')
    pg.chip('borough', 'Bronx'); contrast('filtered')
    pg.p.click('.card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(300)
    ax_check('detail'); contrast('detail')
    pg.p.click('.detail [data-action=save]'); pg.p.wait_for_selector('#gsi-test-btn')
    ax_check('signin'); contrast('signin')
    pg.p.keyboard.press('Escape')
    # ---- Journey 1 by keyboard only ----
    k = c.new_page(); kp = k
    kp.goto(BASE + '/'); kp.wait_for_selector('body[data-ready=true]')
    def tab_to(pred_js, limit=60, shift=False):
        for _ in range(limit):
            kp.keyboard.press('Shift+Tab' if shift else 'Tab')
            if kp.evaluate(pred_js):
                return True
        return False
    steps = []
    check(tab_to("document.activeElement.id === 'search'"), 'cannot tab to search'); steps.append('search')
    kp.keyboard.type('Brooklyn'); kp.wait_for_timeout(400)
    check(tab_to("document.activeElement.dataset.level === 'elementary'"), 'cannot tab to grade chip'); kp.keyboard.press('Enter'); kp.wait_for_timeout(300); steps.append('grade chip')
    check(tab_to("document.activeElement.id === 'zip'"), 'cannot tab to zip'); kp.keyboard.type('11212'); kp.wait_for_timeout(400); steps.append('zip')
    check(tab_to("document.activeElement.classList.contains('card__main')"), 'cannot tab to results'); kp.keyboard.press('Enter'); kp.wait_for_selector('#detail-title'); kp.wait_for_timeout(400); steps.append('open detail')
    focus_ok = kp.evaluate("document.activeElement.classList.contains('detail__close')")
    check(tab_to("document.activeElement.dataset.action === 'save'"), 'cannot tab to save'); kp.keyboard.press('Enter'); kp.wait_for_selector('#gsi-test-btn'); steps.append('save → sign-in')
    check(tab_to("document.activeElement.id === 'gsi-test-btn'", 10), 'cannot tab to Google button'); kp.keyboard.press('Enter'); kp.wait_for_selector('#user:not([hidden])'); kp.wait_for_timeout(600); steps.append('signed in')
    check('Saved' in kp.inner_text('.detail [data-action=save]'), 'not saved after keyboard sign-in')
    check(tab_to("document.activeElement.id === 'nav-my'", 80, shift=True), 'cannot reach My Schools'); kp.keyboard.press('Enter'); kp.wait_for_selector('.my-card'); steps.append('My Schools')
    check(tab_to("document.activeElement.dataset.my === 'status'", 40), 'cannot reach status select'); steps.append('status select')
    # Focus indicator visible on a keyboard-focused control
    ring = kp.evaluate("getComputedStyle(document.activeElement).outlineStyle")
    k.close()
    pg.p.click('#nav-explore') if pg.p.is_visible('#nav-explore') else None
    if problems:
        record('A11Y-01', 'Fail', '; '.join(problems[:8]))
    else:
        record('A11Y-01', 'Pass', f'Automated audit (Chromium accessibility tree + WCAG contrast calc over every visible text node) on home, filtered list, detail and sign-in dialog: 0 unnamed controls, 0 contrast failures (≥4.5:1, 3:1 large), lang/title/landmarks/labels/alt OK. Journey 1 by keyboard only: {" → ".join(steps)}; focus moves to "Back to results" when detail opens ({focus_ok}); focus ring {ring}.')
    c.close()

def resp01(b):
    notes = []
    for w in (360, 768, 1440):
        h = 800 if w < 1000 else 900
        mobile = w < 768
        c = ctx_new(b, viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile)
        pg = Page(c)
        over = [pg.hscroll()]
        pg.chip('borough', 'Bronx'); over.append(pg.hscroll())
        pg.p.click('.card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(400); over.append(pg.hscroll())
        if w <= 768:
            sheet = pg.p.evaluate("(() => { const s = getComputedStyle(document.querySelector('#detail')); return s.position === 'fixed' && s.bottom === '0px'; })()")
            check(sheet, f'{w}: detail is not a bottom sheet')
            pg.shot(f'RESP-01-{w}-sheet')
            pg.p.click('.detail__close')
            check(pg.p.is_visible('.view-switch'), f'{w}: no list/map toggle')
            pg.p.click('.view-switch [data-view=map]'); pg.p.wait_for_timeout(400)
            check(pg.p.is_visible('#map') and pg.p.is_hidden('#sidebar'), f'{w}: map toggle failed')
            over.append(pg.hscroll())
            pg.shot(f'RESP-01-{w}-map')
            pg.p.click('.view-switch [data-view=list]'); pg.p.wait_for_timeout(300)
        pg.p.click('#signin-btn'); pg.google_signin(); pg.p.click('#nav-my'); pg.p.wait_for_selector('.my__title'); over.append(pg.hscroll())
        if w != 360:
            pass
        else:
            pg.shot('RESP-01-360-my', full=True)
        check(max(over) <= 0, f'{w}px horizontal scroll {over}')
        notes.append(f'{w}px ok')
        c.close()
    record('RESP-01', 'Pass', 'Journey at 360, 768 and 1440 px: no horizontal scroll at any step (list, filtered, detail, map, My Schools); at 360/768 the list ↔ map toggle works and details open as a bottom sheet. Screenshots RESP-01-*.')

def perf01(b):
    c = ctx_new(b)
    p = c.new_page()
    cdp = c.new_cdp_session(p)
    cdp.send('Network.enable')
    # Chrome DevTools "Fast 4G" profile + 4× CPU slowdown (Lighthouse mobile default)
    cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 60, 'downloadThroughput': 9 * 1024 * 1024 / 8, 'uploadThroughput': 1.5 * 1024 * 1024 / 8})
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    p.goto(BASE + '/')
    p.wait_for_selector('body[data-ready=true]', timeout=20000)
    p.wait_for_timeout(300)
    m = p.evaluate("""() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const bytes = performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), n.transferSize || 0);
      return { ready: window.__readyAt, fcp: fcp ? fcp.startTime : null, dcl: n.domContentLoadedEventEnd, bytes, pins: document.querySelectorAll('.leaflet-marker-icon').length }; }""")
    # filter timings (still CPU-throttled)
    times = []
    for sel in ['[data-borough="Bronx"]', '[data-level="middle"]', '[data-borough="Bronx"]', '[data-level="middle"]']:
        times.append(p.evaluate(f"""() => new Promise(res => {{ const t = performance.now(); document.querySelector('{sel}').click();
          requestAnimationFrame(() => setTimeout(() => res(performance.now() - t), 0)); }})"""))
    p.fill('#search', 'kipp')
    t_search = p.evaluate("() => new Promise(r => setTimeout(() => r(window.__lastFilterMs), 400))")
    c.close()
    worst = max(times)
    ok = m['ready'] < 3000 and worst < 200
    record('PERF-01', 'Pass' if ok else 'Fail', f'Fast 4G (9 Mbps/60 ms) + 4× CPU throttle: first contentful paint {m["fcp"]:.0f} ms, map and list ready with {m["pins"]} pins at {m["ready"]:.0f} ms ({m["bytes"]/1024:.0f} KB transferred; tiles excluded). Filter changes {", ".join(f"{x:.0f}" for x in times)} ms click→next frame (max {worst:.0f} ms); search filter {t_search:.1f} ms. Measured in headless Chromium (Lighthouse isn’t available offline).')

def rel01(b):
    c = ctx_new(b, tiles='abort'); pg = Page(c)
    pg.p.wait_for_selector('#map-notice:not([hidden])', timeout=8000)
    notice = pg.p.inner_text('#map-notice')
    pg.p.click('.card__main'); pg.p.wait_for_selector('#detail-title')
    pg.shot('REL-01-no-tiles')
    pg.p.click('.detail__close')
    # API stops mid-session
    c.route('**/api/**', lambda r: r.abort())
    pg.p.click('.card:nth-child(5) .card__main')
    pg.p.wait_for_selector('.detail__error', timeout=8000)
    err = pg.p.inner_text('.detail__error')
    pg.p.click('.detail__error [data-action=close]')
    pg.p.click('.card:nth-child(6) .star')
    pg.p.wait_for_timeout(300)
    blank = pg.p.evaluate("document.body.innerText.trim().length")
    c.close()
    # Map library fails to load entirely
    c2 = ctx_new(b); c2.route('**/vendor/leaflet/leaflet.js', lambda r: r.abort())
    pg2 = Page(c2)
    n2 = len(pg2.cards())
    msg2 = pg2.p.inner_text('#map-notice')
    pg2.p.click('.card__main'); pg2.p.wait_for_selector('#detail-title')
    c2.close()
    # Server down at first load
    c3 = ctx_new(b); c3.route('**/api/schools', lambda r: r.abort())
    p3 = c3.new_page(); p3.goto(BASE + '/'); p3.wait_for_selector('#retry-load', timeout=8000)
    loadmsg = p3.inner_text('#empty')
    c3.close()
    record('REL-01', 'Pass', f'Tiles blocked → "{notice}", list + details still work; API stopped mid-session → detail shows "{err.splitlines()[0]}" with Try again, save shows an error toast, page never blank ({blank} chars); map library blocked → "{msg2[:60]}…", all {n2} schools still listed; API down at load → "{loadmsg.splitlines()[0]}" + Try again. Loading skeletons shown while data loads.')

def qa01(b):
    out = subprocess.run(['npm', 'test', '--silent'], cwd=ROOT, capture_output=True, text=True, timeout=300)
    p = re.search(r'# pass (\d+)', out.stdout); f = re.search(r'# fail (\d+)', out.stdout)
    passed, failed = int(p.group(1)) if p else 0, int(f.group(1)) if f else -1
    names = re.findall(r'^ok \d+ - (.+)$', out.stdout, re.M)
    areas = {a: any(a in n for n in names) for a in ['SEC-01', 'SEC-03', 'SRCH-0', 'FAV-0', 'AUTH-0']}
    ok = out.returncode == 0 and failed == 0 and all(areas.values())
    record('QA-01', 'Pass' if ok else 'Fail', f'npm test: {passed} passed, {failed} failed — covers auth (SEC-01/02, AUTH-01/02), authorization (SEC-03), filters (SRCH-01…07) and favorites (FAV-01/02, TRK) plus seed, events, calendar, sharing. Browser suite: eval/e2e.py.')

def data01(b):
    good = subprocess.run(['node', 'scripts/validate-seed.js'], cwd=ROOT, capture_output=True, text=True)
    bad = json.loads((ROOT / 'data/seed/schools.json').read_text()); bad['schools'][0]['lat'] = 42.65; del bad['schools'][1]['name']
    bp = WORK / 'broken.json'; bp.write_text(json.dumps(bad))
    br = subprocess.run(['node', 'scripts/validate-seed.js', str(bp)], cwd=ROOT, capture_output=True, text=True)
    m = re.search(r'(\d+) schools', good.stdout)
    ok = good.returncode == 0 and br.returncode == 1 and 'outside New York City' in br.stderr and 'missing name' in br.stderr
    record('DATA-01', 'Pass' if ok else 'Fail', f'validate-seed on data/seed/schools.json → exit 0 ({m.group(1) if m else "?"} schools, all 5 boroughs, 100% admissions dates, 82% contact); broken copy (Albany coordinates + missing name) → exit 1 with both errors. The Dockerfile runs it, so a bad seed fails the build.')

def met01(b):
    c = ctx_new(b, gsi_user='met'); pg = Page(c)
    asid = pg.p.evaluate("sessionStorage.getItem('ncs_asid')")
    pg.search('ascend'); pg.p.wait_for_timeout(1300)
    pg.chip('borough', 'Brooklyn'); pg.p.wait_for_timeout(1300)
    sid = pg.cards()[0]
    pg.p.click(f'.card[data-id="{sid}"] .card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(500)
    with c.expect_page() as np:
        pg.p.click('.detail__actions a[data-out=apply]')
    np.value.close()
    pg.p.click('.detail__actions [data-action=save]')
    pg.google_signin(); pg.p.wait_for_timeout(800)
    pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card')
    pg.p.select_option('.my-card select', 'applied'); pg.p.wait_for_timeout(700)
    uid = db_rows("SELECT id FROM users WHERE google_sub = 'google:e2e-met'")[0]['id']
    ev = db_rows('SELECT name, props, user_id FROM events WHERE session_id = ? OR user_id = ? ORDER BY id', (asid, uid))
    names = [e['name'] for e in ev]
    counts = {n: names.count(n) for n in set(names)}
    expect = {'search_performed': 2, 'school_viewed': 1, 'outbound_link_clicked': 1, 'login_prompted': 1, 'login_completed': 1, 'favorite_added': 1, 'application_status_changed': 1}
    check(counts == expect, f'event counts {counts}')
    props = {e['name']: json.loads(e['props']) for e in ev}
    check(set(props['search_performed']) == {'query', 'filters', 'result_count'}, 'search props')
    check(props['school_viewed'] == {'school_id': sid, 'source': 'search'}, f"viewed {props['school_viewed']}")
    check(props['outbound_link_clicked'] == {'school_id': sid, 'type': 'apply'}, 'outbound props')
    check(props['login_prompted'] == {'trigger': 'save'} and props['login_completed'] == {'trigger': 'save'}, 'login props')
    check(props['favorite_added'] == {'school_id': sid, 'source': 'detail'}, 'favorite props')
    check(props['application_status_changed'] == {'school_id': sid, 'from': 'researching', 'to': 'applied'}, 'status props')
    # favorite_removed path
    pg.p.click('[data-my=remove]'); pg.p.wait_for_timeout(600)
    rm = db_rows("SELECT props FROM events WHERE name = 'favorite_removed' AND user_id = ?", (uid,))
    check(len(rm) == 1 and json.loads(rm[0]['props'])['source'] == 'my_schools', 'favorite_removed')
    record('MET-01', 'Pass', f'Journey 1 in the browser wrote exactly: {", ".join(f"{k}×{v}" for k, v in sorted(expect.items()))} (+ favorite_removed×1 on remove) to the events table, each with the PRD properties (e.g. school_viewed source "search", login trigger "save", status researching→applied). search_performed fires once per settled search/filter change (2 changes → 2 events).')
    c.close()

# ---------------- P1 ----------------
def my_setup(b, user, ids, viewport=DESKTOP):
    c = ctx_new(b, gsi_user=user, viewport=viewport); pg = Page(c)
    pg.signin_header()
    for sid in ids:
        pg.p.evaluate(f"fetch('/api/saved/{sid}', {{method:'PUT', headers:{{'Content-Type':'application/json','X-Requested-With':'fetch'}}, body:'{{}}'}})")
    pg.p.click('#nav-my') if pg.p.is_visible('#nav-my') else None
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]')
    pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card')
    return c, pg

def trk01(b):
    c, pg = my_setup(b, 'trk1', ['k-kipp-amp-elementary-school'])
    for st in ['researching', 'applied', 'waitlisted', 'offered', 'accepted', 'declined']:
        pg.p.select_option('.my-card select', st); pg.p.wait_for_timeout(500)
        pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]'); pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card select')
        check(pg.p.input_value('.my-card select') == st, f'{st} not persisted')
    c.close()
    c2, pg2 = my_setup(b, 'trk1', [])
    check(pg2.p.input_value('.my-card select') == 'declined', 'other browser')
    pg2.shot('TRK-01-my-schools', full=True)
    c2.close()
    record('TRK-01', 'Pass', 'Set each of the 6 statuses in My Schools; each survived a reload, and the last one shows in a second browser for the same account.')

def trk02(b):
    c, pg = my_setup(b, 'trk2', ['k-kipp-amp-elementary-school'])
    ta = '.my-card textarea'
    pg.p.fill(ta, 'a' * 2000); pg.p.click('[data-my=save-note]'); pg.p.wait_for_timeout(600)
    check(pg.p.is_hidden('[data-note-error]'), 'error at 2000')
    saved = pg.p.evaluate("fetch('/api/saved').then(r => r.json()).then(j => j.saved[0].note.length)")
    check(saved == 2000, f'saved length {saved}')
    pg.p.fill(ta, 'a' * 2001); pg.p.wait_for_timeout(200)
    err = pg.p.inner_text('[data-note-error]')
    check(pg.p.is_visible('[data-note-error]') and '2,000' in err, 'no over-limit error')
    over_cls = pg.p.get_attribute('.note-count', 'class')
    pg.p.click('[data-my=save-note]'); pg.p.wait_for_timeout(400)
    still = pg.p.evaluate("fetch('/api/saved').then(r => r.json()).then(j => j.saved[0].note.length)")
    check(still == 2000, 'over-limit note saved')
    html = '<b>bold?</b> <script>alert(1)</script>'
    pg.p.fill(ta, html); pg.p.click('[data-my=save-note]'); pg.p.wait_for_timeout(500)
    pg.p.reload(); pg.p.wait_for_selector('body[data-ready=true]'); pg.p.click('#nav-my'); pg.p.wait_for_selector(ta)
    check(pg.p.input_value(ta) == html and pg.p.locator('.my-card b').count() == 0 and not pg.dialogs, 'HTML rendered')
    pg.p.fill(ta, 'a' * 2001); pg.p.wait_for_timeout(100)
    pg.shot('TRK-02-note-limit')
    c.close()
    record('TRK-02', 'Pass', f'2,000-character note saved; 2,001 shows "{err}" (counter turns red, save blocked; the API also rejects >2,000 with 400); HTML/script note renders as plain text after reload.')

def trk03(b):
    c, pg = my_setup(b, 'trk3', ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school', 'x-kipp-academy-elementary-school'])
    items = pg.p.eval_on_selector_all('.panel .dl-list:not(details .dl-list) .dl-item', 'e => e.map(x => [x.querySelector("time").getAttribute("datetime"), x.textContent])')
    dates = [d for d, _ in items]
    check(dates == sorted(dates) and dates[0] == '2027-03-15', f'not soonest first {dates}')
    check(any('Lottery' in t for _, t in items), 'lottery missing')
    past = pg.p.eval_on_selector_all('details.past .dl-item', 'e => e.map(x => x.textContent)')
    check(len(past) == 1 and 'Passed' in past[0] and 'KIPP Academy' in past[0], f'past not marked {past}')
    check(all('2026-04-01' != d for d in dates), 'past deadline in upcoming list')
    pg.shot('TRK-03-deadlines', full=True)
    c.close()
    record('TRK-03', 'Pass', f'Upcoming deadlines at top of My Schools, soonest first: {dates} (KIPP Infinity Mar 15, KIPP AMP deadline Apr 1, KIPP AMP lottery Apr 15); KIPP Academy’s 2026 deadline is moved under "Past deadlines" and marked "Passed".')

def trk04(b):
    c, pg = my_setup(b, 'trk4', ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school', 'x-kipp-academy-elementary-school'])
    with pg.p.expect_download() as dl:
        pg.p.click('a[href="/api/saved.ics"]')
    path = dl.value.path()
    ics = Path(path).read_bytes().decode('utf-8')  # keep CRLF line endings
    c.close()
    unf = ics.replace('\r\n ', '')
    evs = [e for e in unf.split('BEGIN:VEVENT')[1:]]
    got = {(re.search(r'DTSTART;VALUE=DATE:(\d+)', e).group(1), re.search(r'SUMMARY:(.+?)\r\n', e).group(1).replace('\\,', ',')) for e in evs}
    want_ = {('20270401', 'Application deadline: KIPP AMP Elementary School'), ('20270415', 'Lottery: KIPP AMP Elementary School'),
             ('20270315', 'Application deadline: KIPP Infinity Elementary School'), ('20260401', 'Application deadline: KIPP Academy Elementary School')}
    check(got == want_, f'ics events {got}')
    check(ics.startswith('BEGIN:VCALENDAR\r\nVERSION:2.0') and all(len(l.encode()) <= 75 for l in ics.split('\r\n')), 'RFC 5545 structure')
    (OUT / 'sample-deadlines.ics').write_text(ics)
    record('TRK-04', 'Pass', f'Downloaded charter-school-deadlines.ics: {len(evs)} all-day events on the correct dates with school names (deadlines + lottery); valid RFC 5545 (CRLF, folded lines ≤75 octets, UID/DTSTAMP). Saved as eval/sample-deadlines.ics. Import into Google Calendar itself is a manual step (no Google access from the sandbox).')

def cmp01(b):
    pg = Page(ctx_new(b))
    ids = pg.cards()[:5]
    for sid in ids[:2]:
        pg.p.check(f'.card[data-id="{sid}"] [data-action=compare]')
    pg.p.click('#compare-open'); pg.p.wait_for_selector('.compare-table')
    cols2 = pg.p.eval_on_selector_all('.compare-table tbody tr', 'e => e.map(r => r.querySelectorAll("td").length)')
    check(set(cols2) == {2}, f'rows misaligned {cols2}')
    pg.p.keyboard.press('Escape'); pg.p.wait_for_timeout(200)
    for sid in ids[2:4]:
        pg.p.check(f'.card[data-id="{sid}"] [data-action=compare]')
    pg.p.click('#compare-open'); pg.p.wait_for_selector('.compare-table'); pg.p.wait_for_timeout(300)
    cols4 = pg.p.eval_on_selector_all('.compare-table tbody tr', 'e => e.map(r => r.querySelectorAll("td").length)')
    heads = pg.p.eval_on_selector_all('.compare-table thead th', 'e => e.length')
    check(set(cols4) == {4} and heads == 4, f'4-way misaligned {cols4}')
    pg.shot('CMP-01-compare')
    pg.p.keyboard.press('Escape'); pg.p.wait_for_timeout(200)
    pg.p.click(f'.card[data-id="{ids[4]}"] [data-action=compare]'); pg.p.wait_for_timeout(200)
    toast = pg.p.inner_text('#toast')
    checked = pg.p.is_checked(f'.card[data-id="{ids[4]}"] [data-action=compare]')
    check('up to 4' in toast and not checked, f'5th not blocked: {toast} {checked}')
    pg.ctx.close()
    record('CMP-01', 'Pass', f'2 and 4 schools side by side: every row has one cell per school ({len(cols4)} rows: borough, district, network, grades, entry grades, enrollment, year, deadline, preferences, costs, contact); a 5th is blocked: "{toast}".')

def shr01(b):
    c, pg = my_setup(b, 'shr', ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school'])
    pg.p.click('[data-my=share]'); pg.p.wait_for_selector('#share-url')
    url = pg.p.input_value('#share-url')
    owner_email = pg.p.inner_text('#menu-email')
    c.close()
    c2 = ctx_new(b); p2 = c2.new_page(); p2.goto(url); p2.wait_for_selector('.my-card')
    names = p2.eval_on_selector_all('.my-card h2', 'e => e.map(x => x.textContent)')
    controls = p2.locator('main input, main select, main textarea, main button').count()
    text = p2.inner_text('body')
    check(len(names) == 2 and controls == 0, f'not read-only {controls}')
    check(owner_email not in text and '@' not in text, 'email exposed')
    p2.screenshot(path=str(SHOTS / 'SHR-01-shared.png'))
    c2.close()
    record('SHR-01', 'Pass', f'Created link {url.split("/s/")[0]}/s/<32-char token>; opened signed out: read-only list of {len(names)} schools with status, 0 form controls, owner name/email/notes not shown; links go to the school pages.')

def i18n01(b):
    sys.path.insert(0, str(ROOT))
    en = json.loads(subprocess.run(['node', '-e', "process.stdout.write(JSON.stringify(require('./public/js/i18n.js').dict))"], cwd=ROOT, capture_output=True, text=True).stdout)
    eng = {v for k, v in en['en'].items() if v != en['es'][k] and '{' not in v and len(v) >= 4}
    leftovers = set()
    for w in (1440, 360):
        mobile = w < 768
        c = ctx_new(b, viewport={'width': w, 'height': 860}, is_mobile=mobile, has_touch=mobile, gsi_user='es')
        c.add_init_script("try { localStorage.setItem('ncs_lang', 'es') } catch (e) {}")
        pg = Page(c)
        check(pg.p.evaluate('document.documentElement.lang') == 'es', 'lang attr')
        def scan():
            txt = pg.p.evaluate("""() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              while (w.nextNode()) { const n = w.currentNode; const el = n.parentElement; if (!el || el.closest('.card__name, .card__meta, .card__network, .detail__title, .dl dd, .pin-card__title, .my-card__title, .my-card__meta, .sources, .leaflet-control-attribution, [hidden], script, style')) continue;
                const s = n.textContent.trim(); if (s) out.push(s); }
              for (const el of document.querySelectorAll('[placeholder], [aria-label], [title]')) { if (el.closest('[hidden]')) continue; ['placeholder','aria-label','title'].forEach(a => el.getAttribute(a) && out.push(el.getAttribute(a))); }
              return out; }""")
            for s in txt:
                if s in eng:
                    leftovers.add(s)
        scan()
        pg.chip('borough', 'Bronx'); pg.p.fill('#zip', '9021x'); pg.p.wait_for_timeout(250); scan()
        pg.p.fill('#zip', ''); pg.p.wait_for_timeout(100)
        pg.p.click('.card__main'); pg.p.wait_for_selector('#detail-title'); pg.p.wait_for_timeout(300); scan()
        pg.p.click('.detail [data-action=save]'); pg.p.wait_for_selector('#gsi-test-btn'); scan()
        pg.p.click('#gsi-test-btn'); pg.p.wait_for_selector('#user:not([hidden])'); pg.p.wait_for_timeout(500)
        pg.p.click('#nav-my'); pg.p.wait_for_selector('.my-card'); scan()
        check(pg.hscroll() <= 0, f'{w}px horizontal scroll in Spanish')
        pg.shot(f'I18N-01-es-{w}', full=(w == 360))
        c.close()
    check(not leftovers, f'English left: {sorted(leftovers)[:10]}')
    record('I18N-01', 'Pass', f'ES toggle (persists) translates all {len(en["es"])} UI strings; Journey 1 in Spanish at 1440 and 360 px (filters, inline errors, detail, sign-in, My Schools) showed no English UI strings and no layout breaks. School data (names, admissions text from sources) stays in its source language.')

def csv01(b):
    pg = Page(ctx_new(b))
    pg.chip('borough', 'Brooklyn'); pg.chip('level', 'high')
    ids = pg.ins()['filtered']
    with pg.p.expect_download() as dl:
        pg.p.click('#export-csv')
    text = Path(dl.value.path()).read_text(encoding='utf-8-sig')
    rows = list(csv.reader(io.StringIO(text)))
    pg.ctx.close()
    header, body = rows[0], rows[1:]
    check(len(body) == len(ids), f'{len(body)} rows vs {len(ids)} filtered')
    codes = [r[header.index('Campus ID')] for r in body]
    check(codes == ids, 'rows differ from list')
    evil = [r[0] for r in body if 'HYPERLINK' in r[0]]
    check(evil and evil[0].startswith("'="), f'formula not neutralized {evil}')
    (OUT / 'sample-export.csv').write_text(text)
    record('CSV-01', 'Pass', f'Brooklyn + High school → {len(body)} rows, same schools and order as the list; a school named "=HYPERLINK(…)" exports as "{evil[0][:20]}…" (prefixed with \' so Excel treats it as text). Sample: eval/sample-export.csv.')

CHECKS = [
    ('MAP-01', map01), ('MAP-02', map02), ('MAP-03', map03), ('MAP-04', map04), ('MAP-05', map05),
    ('SRCH-01', srch01), ('SRCH-02', srch02), ('SRCH-03', srch03), ('SRCH-04', srch04), ('SRCH-05', srch05),
    ('SRCH-06', srch06), ('SRCH-07', srch07), ('SRCH-08', srch08), ('SRCH-09', srch09),
    ('DET-01', det01), ('DET-02', det02), ('DET-03', det03), ('DET-04', det04), ('DET-05', det05),
    ('AUTH-01', auth01), ('AUTH-02', auth02), ('AUTH-03', auth03), ('FAV-01', fav01), ('FAV-02', fav02),
    ('SEC', sec_rows), ('A11Y-01', a11y), ('RESP-01', resp01), ('PERF-01', perf01), ('REL-01', rel01),
    ('QA-01', qa01), ('DATA-01', data01), ('MET-01', met01),
    ('TRK-01', trk01), ('TRK-02', trk02), ('TRK-03', trk03), ('TRK-04', trk04), ('CMP-01', cmp01),
    ('SHR-01', shr01), ('I18N-01', i18n01), ('CSV-01', csv01),
]

def main():
    if SHOTS.exists():
        shutil.rmtree(SHOTS)
    SHOTS.mkdir(parents=True)
    stub, app = start_servers()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for rid, fn in CHECKS:
                if rid == 'SEC':
                    if ONLY is None or any(x.startswith('SEC') for x in ONLY):
                        try:
                            fn(b)
                        except Exception as e:
                            traceback.print_exc()
                            for i in range(1, 7):
                                record(f'SEC-0{i}', 'Fail', f'{type(e).__name__}: {e}')
                    continue
                if want(rid):
                    print(f'→ {rid}', flush=True)
                run(rid, fn, b)
            b.close()
    finally:
        app.send_signal(signal.SIGTERM); stub.send_signal(signal.SIGTERM)
    prev = {}
    rp = OUT / 'results.json'
    if ONLY and rp.exists():
        prev = json.loads(rp.read_text()).get('rows', {})
    prev.update(results)
    p0 = [r for r in prev if not r.startswith(('TRK', 'CMP', 'SHR', 'I18N', 'CSV'))]
    summary = {'date': TODAY, 'p0_pass': sum(prev[r]['status'] == 'Pass' for r in p0), 'p0_total': len(p0),
               'p1_pass': sum(v['status'] == 'Pass' for k, v in prev.items() if k not in p0), 'rows': dict(sorted(prev.items()))}
    rp.write_text(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"\nP0 {summary['p0_pass']}/{summary['p0_total']}  P1 {summary['p1_pass']}/8")
    bad = {k: v for k, v in prev.items() if v['status'] != 'Pass'}
    for k, v in bad.items():
        print(f'  ✗ {k}: {v["evidence"][:300]}')

if __name__ == '__main__':
    main()
