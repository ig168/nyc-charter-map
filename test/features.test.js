'use strict';

// FAV-01/02, TRK-01..04, SHR-01, MET-01, MAP-04 (geocode), DET-* (API shape)

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, client } = require('./helpers');

let app;
test.before(async () => {
  const geocode = async (q) => {
    if (/^\d{5}$/.test(q)) return { label: `ZIP ${q}`, lat: 40.81, lng: -73.95, kind: 'zip' };
    if (/nowhere/i.test(q)) throw Object.assign(new (require('../src/geocode').GeocodeError)(404, 'not found'), {});
    return { label: '350 5th Ave, Manhattan, New York, NY', lat: 40.7484, lng: -73.9857, kind: 'address' };
  };
  app = await startApp({}, {});
  app.geocodeReal = await startApp({ OFFLINE: 'false', GEOCODER_URL: 'http://127.0.0.1:9/never' });
  app.geocodeFake = await startApp({}, { geocode });
});
test.after(async () => {
  await app.close();
  await app.geocodeReal.close();
  await app.geocodeFake.close();
});

test('DET-01..05 detail payload has every section, with nulls for unknown fields', async () => {
  const c = client(app.base);
  const kipp = (await c.get('/api/schools/k-kipp-amp-elementary-school')).json.school;
  assert.equal(kipp.name, 'KIPP AMP Elementary School');
  for (const k of ['network', 'grades', 'enrollment', 'yearFounded', 'mission', 'source', 'lastVerified']) assert.ok(k in kipp, k);
  for (const k of ['howToApply', 'eligibility', 'lotteryPreferences', 'applicationDeadline', 'applyUrl']) assert.ok(kipp.admissions[k], k);
  assert.match(kipp.admissions.applyUrl, /^https:\/\//);
  assert.equal(kipp.contact.email, 'enroll@kippnyc.org');
  assert.equal(kipp.costs.tuitionFree, true);
  for (const k of ['uniform', 'afterCare', 'meals', 'transportation']) assert.ok(k in kipp.costs, k);
  assert.match(kipp.lastVerified, /^\d{4}-\d{2}-\d{2}$/);
  const sparse = (await c.get('/api/schools/x-academic-leadership-charter-school-elementary-school')).json.school; // independent school
  assert.equal(sparse.mission, null);
  assert.equal(sparse.contact.email, null);
  assert.ok(sparse.verification && sparse.verification.confirmedBy.length >= 1, 'every campus says which sources confirm it');
});

test('FAV-01/FAV-02 save/unsave is idempotent and persists across devices', async () => {
  const laptop = client(app.base);
  const phone = client(app.base);
  await laptop.devLogin('maria');
  for (const id of ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school', 'x-kipp-academy-elementary-school']) await laptop.put(`/api/saved/${id}`, { source: 'list' });
  await laptop.put('/api/saved/k-kipp-amp-elementary-school', { source: 'detail' }); // repeat does nothing
  await phone.devLogin('maria'); // same account, second browser
  const saved = (await phone.get('/api/saved')).json.saved.map((s) => s.schoolId).sort();
  assert.deepEqual(saved, ['k-kipp-amp-elementary-school', 'm-kipp-infinity-elementary-school', 'x-kipp-academy-elementary-school']);
  await phone.del('/api/saved/m-kipp-infinity-elementary-school', { source: 'my_schools' });
  assert.equal((await laptop.get('/api/saved')).json.saved.length, 2);
});

test('TRK-01 all six statuses persist; invalid status rejected', async () => {
  const c = client(app.base);
  await c.devLogin('tracker');
  await c.put('/api/saved/k-kipp-amp-elementary-school');
  for (const st of ['researching', 'applied', 'waitlisted', 'offered', 'accepted', 'declined']) {
    assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: st })).status, 200);
    const other = client(app.base);
    await other.devLogin('tracker');
    assert.equal((await other.get('/api/saved')).json.saved[0].status, st);
  }
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'maybe' })).status, 400);
});

test('TRK-02 notes up to 2,000 characters; 2,001 rejected; HTML kept as text', async () => {
  const c = client(app.base);
  await c.devLogin('notes');
  await c.put('/api/saved/k-kipp-amp-elementary-school');
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: 'a'.repeat(2000) })).status, 200);
  const over = await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: 'a'.repeat(2001) });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /2,000/);
  assert.equal((await c.get('/api/saved')).json.saved[0].note.length, 2000, 'over-limit save did not change the note');
  const emoji = '🙂'.repeat(2000); // counted as characters, not bytes
  assert.equal((await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: emoji })).status, 200);
  const html = '<b>Tour</b> <script>alert(1)</script>';
  await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: html });
  assert.equal((await c.get('/api/saved')).json.saved[0].note, html);
});

test('TRK-04 calendar export is valid iCalendar with the right dates and names', async () => {
  const c = client(app.base);
  await c.devLogin('ics');
  await c.put('/api/saved/k-kipp-amp-elementary-school');
  await c.put('/api/saved/m-kipp-infinity-elementary-school');
  const r = await c.get('/api/saved.ics');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="charter-school-deadlines\.ics"/);
  const ics = r.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  const unfolded = ics.replace(/\r\n /g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1);
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => /DTSTART;VALUE=DATE:20270401/.test(e) && /SUMMARY:Application deadline: KIPP AMP Elementary School/.test(e)));
  assert.ok(events.every((e) => /DTEND;VALUE=DATE:20270402/.test(e) && /UID:[km]-kipp-[a-z-]+-deadline-2027-04-01@/.test(e)));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
});

test('SHR-01 read-only share link: no notes, no email, revocable', async () => {
  const c = client(app.base);
  await c.googleLogin({ sub: '9001', email: 'sharer@example.com', name: 'Sharer Person' });
  await c.put('/api/saved/k-kipp-amp-elementary-school');
  await c.patch('/api/saved/k-kipp-amp-elementary-school', { note: 'secret note', status: 'applied' });
  const { json } = await c.post('/api/share');
  const token = json.path.split('/').pop();
  const anon = client(app.base);
  assert.equal((await anon.get(json.path)).status, 200, 'share page loads signed out');
  const data = await anon.get(`/api/share/${token}`);
  assert.equal(data.status, 200);
  assert.equal(data.json.schools[0].id, 'k-kipp-amp-elementary-school');
  assert.equal(data.json.schools[0].status, 'applied');
  assert.ok(!data.text.includes('secret note'));
  assert.ok(!data.text.includes('sharer@example.com'));
  assert.ok(!data.text.includes('Sharer Person'));
  assert.equal((await anon.put('/api/saved/k-kipp-amp-elementary-school')).status, 401, 'viewer cannot edit');
  assert.equal((await c.post('/api/share')).json.path, json.path, 'same link until revoked');
  await c.del('/api/share');
  assert.equal((await anon.get(`/api/share/${token}`)).status, 404);
  assert.equal((await anon.get('/api/share/short')).status, 404);
});

test('MET-01 events: each fires once per action with the PRD properties', async () => {
  const c = client(app.base);
  const sid = 'sess_abcdefghijklmnop';
  const ev = (name, props) => c.post('/api/events', { name, props, session_id: sid });
  assert.equal((await ev('search_performed', { query: 'kipp', filters: { borough: ['Bronx'] }, result_count: 4 })).status, 204);
  assert.equal((await ev('school_viewed', { school_id: 'k-kipp-amp-elementary-school', source: 'pin' })).status, 204);
  assert.equal((await ev('outbound_link_clicked', { school_id: 'k-kipp-amp-elementary-school', type: 'apply' })).status, 204);
  assert.equal((await ev('login_prompted', { trigger: 'save' })).status, 204);
  // Server-recorded events cannot be forged by the browser
  assert.equal((await ev('favorite_added', { school_id: 'k-kipp-amp-elementary-school', source: 'list' })).status, 400);
  assert.equal((await ev('school_viewed', { school_id: 'k-kipp-amp-elementary-school', source: 'pin', email: 'x@y.z' })).status, 400, 'unexpected property');
  assert.equal((await ev('school_viewed', { school_id: 'bad', source: 'pin' })).status, 400);
  assert.equal((await ev('nope', {})).status, 400);
  assert.equal((await c.post('/api/events', { name: 'login_prompted', props: { trigger: 'save' }, session_id: 'short' })).status, 400);

  await c.googleLogin({ sub: '777', email: 'events@example.com' }, { trigger: 'save' });
  await c.put('/api/saved/k-kipp-amp-elementary-school', { source: 'pin' });
  await c.put('/api/saved/k-kipp-amp-elementary-school', { source: 'pin' }); // already saved -> no second event
  await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'applied' });
  await c.patch('/api/saved/k-kipp-amp-elementary-school', { status: 'applied' }); // unchanged -> no event
  await c.del('/api/saved/k-kipp-amp-elementary-school', { source: 'my_schools' });

  const me = app.store.db.prepare("SELECT id FROM users WHERE google_sub = 'google:777'").get().id;
  const byName = (n) => app.store.events(n).filter((e) => e.session_id === sid || e.user_id === me);
  assert.deepEqual(byName('search_performed')[0].props, { query: 'kipp', filters: { borough: ['Bronx'] }, result_count: 4 });
  assert.equal(byName('search_performed')[0].session_id, sid);
  assert.equal(byName('login_completed').at(-1).props.trigger, 'save');
  assert.equal(byName('favorite_added').length, 1);
  assert.deepEqual(byName('favorite_added')[0].props, { school_id: 'k-kipp-amp-elementary-school', source: 'pin' });
  assert.equal(byName('application_status_changed').length, 1);
  assert.deepEqual(byName('application_status_changed')[0].props, { school_id: 'k-kipp-amp-elementary-school', from: 'researching', to: 'applied' });
  assert.deepEqual(byName('favorite_removed')[0].props, { school_id: 'k-kipp-amp-elementary-school', source: 'my_schools' });
  assert.ok(byName('favorite_added')[0].user_id, 'user id attached when signed in');
  assert.equal(byName('search_performed')[0].user_id, null, 'anonymous before sign-in');
});

test('MAP-04 geocode: NYC zips resolve locally; bad input gets a friendly error; outage degrades', async () => {
  const c = client(app.base);
  const z = await c.get('/api/geocode?q=10027');
  assert.equal(z.status, 200);
  assert.equal(z.json.result.kind, 'zip');
  assert.ok(z.json.result.lat > 40.7 && z.json.result.lat < 40.9);
  assert.equal((await c.get('/api/geocode?q=90210')).status, 400);
  assert.equal((await c.get('/api/geocode?q=ab')).status, 400);
  const down = await client(app.geocodeReal.base).get('/api/geocode?q=350%205th%20Ave');
  assert.equal(down.status, 503);
  assert.match(down.json.message, /zip code|Near me/);
  const fake = client(app.geocodeFake.base);
  const addr = await fake.get('/api/geocode?q=350%205th%20Ave');
  assert.equal(addr.json.result.kind, 'address');
});

test('PRIV-01 deleting an account erases profile, saved schools, notes, share link and events, everywhere', async () => {
  const laptop = client(app.base);
  const phone = client(app.base);
  await laptop.devLogin('eraseme');
  await phone.devLogin('eraseme');
  await laptop.put('/api/saved/k-kipp-amp-elementary-school', { source: 'list' });
  await laptop.patch('/api/saved/k-kipp-amp-elementary-school', { note: 'tour notes' });
  const share = (await laptop.post('/api/share', {})).json.path;
  const before = app.store.db.prepare("SELECT id FROM users WHERE google_sub = 'dev:eraseme'").get();
  assert.ok(before, 'user exists');
  assert.equal((await laptop.del('/api/me', {}, { sameOrigin: false })).status, 403, 'cross-site delete blocked');
  assert.equal((await laptop.del('/api/me')).status, 200);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(before.id).n, 0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM saved_schools WHERE user_id = ?').get(before.id).n, 0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM events WHERE user_id = ?').get(before.id).n, 0);
  assert.equal((await laptop.get('/api/me')).json.user, null, 'signed out here');
  assert.equal((await phone.get('/api/saved')).status, 401, 'signed out on the other device too');
  assert.equal((await client(app.base).get(`/api/share/${share.split('/').pop()}`)).status, 404, 'share link stops working');
  assert.equal((await client(app.base).del('/api/me')).status, 401, 'needs sign-in');
});

test('About and Privacy pages are public', async () => {
  const c = client(app.base);
  const about = await c.get('/about');
  assert.equal(about.status, 200);
  assert.match(about.text, /organized/);
  const privacy = await c.get('/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.text, /Delete my account and data/);
});
