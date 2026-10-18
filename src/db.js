'use strict';

/**
 * SQLite storage (Node's built-in node:sqlite). Every statement is prepared with bound
 * parameters; no SQL is ever built by concatenating user input (SEC-04).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// node:sqlite prints an "experimental" warning on load; it is stable enough for this app.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w && w.message ? w.message : w).includes('SQLite is an experimental feature')) return;
  return emit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

const { validateSeed } = require('./seed');
const { STATUSES } = require('./nyc');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schools (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  network       TEXT,
  borough       TEXT NOT NULL,
  district      INTEGER,
  zip           TEXT,
  neighborhood  TEXT,
  address       TEXT NOT NULL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  grades_served TEXT NOT NULL,
  entry_grades  TEXT NOT NULL,
  enrollment    INTEGER,
  year_founded  INTEGER,
  mission       TEXT,
  building_code TEXT,
  source        TEXT NOT NULL,
  last_verified TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_admissions (
  school_id            TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  cycle                TEXT NOT NULL,
  how_to_apply         TEXT,
  eligibility          TEXT,
  lottery_preferences  TEXT,
  application_open     TEXT,
  application_deadline TEXT,
  deadline_note        TEXT,
  lottery_date         TEXT,
  lottery_note         TEXT,
  apply_url            TEXT,
  apply_url_label      TEXT,
  PRIMARY KEY (school_id, cycle)
);
CREATE TABLE IF NOT EXISTS school_contact_costs (
  school_id      TEXT PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  phone          TEXT,
  email          TEXT,
  website        TEXT,
  tuition_free   INTEGER NOT NULL DEFAULT 1,
  uniform        TEXT,
  after_care     TEXT,
  meals          TEXT,
  transportation TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT,
  photo_url   TEXT,
  share_token TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS saved_schools (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'researching'
             CHECK (status IN ('researching','applied','waitlisted','offered','accepted','declined')),
  note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, school_id)
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  session_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  props      TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS events_name ON events(name, created_at);
`;

const now = () => new Date().toISOString();

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    // Columns added with the campus-level seed (2026-10-17); older databases get them here.
    const cols = new Set(this.db.prepare('PRAGMA table_info(schools)').all().map((c) => c.name));
    const ADD = {
      official_name: 'ALTER TABLE schools ADD COLUMN official_name TEXT',
      doe_code: 'ALTER TABLE schools ADD COLUMN doe_code TEXT',
      enrollment_year: 'ALTER TABLE schools ADD COLUMN enrollment_year TEXT',
      checks: 'ALTER TABLE schools ADD COLUMN checks TEXT',
    };
    for (const [col, sql] of Object.entries(ADD)) if (!cols.has(col)) this.db.exec(sql);
    this.stmts = {};
    this.cache = null; // cached public school data
  }

  st(sql) {
    return (this.stmts[sql] ||= this.db.prepare(sql));
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.db.close();
  }

  // ---- Seed ---------------------------------------------------------------------

  /** Loads the seed file into the read-only school tables when its contents change. */
  loadSeed(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const seed = JSON.parse(raw);
    const result = validateSeed(seed);
    if (!result.ok) {
      const e = new Error(`Seed file is invalid:\n  - ${result.errors.slice(0, 10).join('\n  - ')}`);
      e.validation = result;
      throw e;
    }
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const current = this.st('SELECT value FROM meta WHERE key = ?').get('seed_hash');
    if (!current || current.value !== hash) {
      this.tx(() => {
        this.st('DELETE FROM schools').run();
        const ins = this.st(`INSERT INTO schools (id, name, network, borough, district, zip, neighborhood, address, lat, lng,
          grades_served, entry_grades, enrollment, year_founded, mission, building_code, source, last_verified,
          official_name, doe_code, enrollment_year, checks)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const adm = this.st(`INSERT INTO school_admissions (school_id, cycle, how_to_apply, eligibility, lottery_preferences,
          application_open, application_deadline, deadline_note, lottery_date, lottery_note, apply_url, apply_url_label)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        const cc = this.st(`INSERT INTO school_contact_costs (school_id, phone, email, website, tuition_free, uniform,
          after_care, meals, transportation) VALUES (?,?,?,?,?,?,?,?,?)`);
        const v = (x) => (x === undefined ? null : x);
        for (const s of seed.schools) {
          ins.run(s.id, s.name, v(s.network), s.borough, v(s.district), v(s.zip), v(s.neighborhood), s.address, s.lat, s.lng,
            s.grades_served.join(','), s.entry_grades.join(','), v(s.enrollment), v(s.year_founded), v(s.mission),
            v(s.building_code), s.source, s.last_verified, v(s.official_name), v(s.doe_code), v(s.enrollment_year),
            s.checks ? JSON.stringify(s.checks) : null);
          const a = s.admissions || {};
          adm.run(s.id, a.cycle || 'current', v(a.how_to_apply), v(a.eligibility), v(a.lottery_preferences), v(a.application_open),
            v(a.application_deadline), v(a.deadline_note), v(a.lottery_date), v(a.lottery_note), v(a.apply_url), v(a.apply_url_label));
          const c = s.contact_costs || {};
          cc.run(s.id, v(c.phone), v(c.email), v(c.website), c.tuition_free === false ? 0 : 1, v(c.uniform), v(c.after_care),
            v(c.meals), v(c.transportation));
        }
        const meta = this.st('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        meta.run('seed_hash', hash);
        meta.run('seed_version', String(seed.version));
        meta.run('seed_generated', String(seed.generated || ''));
        meta.run('seed_sources', JSON.stringify(seed.sources || {}));
      });
    }
    this.cache = null;
    return { hash, version: seed.version, count: seed.schools.length, stats: result.stats, warnings: result.warnings };
  }

  // ---- Schools (public, read-only) ---------------------------------------------

  meta() {
    const rows = this.st('SELECT key, value FROM meta').all();
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      version: m.seed_version || null,
      generated: m.seed_generated || null,
      hash: m.seed_hash || null,
      sources: m.seed_sources ? JSON.parse(m.seed_sources) : {},
    };
  }

  /** Compact list used by the map/list (one row per school). */
  schoolSummaries() {
    if (this.cache) return this.cache;
    const rows = this.st(`SELECT s.id, s.name, s.network, s.borough, s.district, s.zip, s.neighborhood, s.address, s.lat, s.lng,
        s.grades_served, s.entry_grades, s.enrollment, s.year_founded, s.building_code,
        a.application_deadline, a.lottery_date, c.phone
      FROM schools s
      LEFT JOIN school_admissions a ON a.school_id = s.id
      LEFT JOIN school_contact_costs c ON c.school_id = s.id
      ORDER BY s.name COLLATE NOCASE`).all();
    // Campuses in the same building share coordinates or a street address
    const bkey = (r) => `${r.lat.toFixed(4)},${r.lng.toFixed(4)}|${String(r.address).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const buildings = new Map();
    for (const r of rows) buildings.set(bkey(r), (buildings.get(bkey(r)) || 0) + 1);
    const schools = rows.map((r) => ({
      id: r.id,
      name: r.name,
      network: r.network,
      borough: r.borough,
      district: r.district,
      zip: r.zip,
      neighborhood: r.neighborhood,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      grades: r.grades_served ? r.grades_served.split(',') : [],
      entryGrades: r.entry_grades ? r.entry_grades.split(',') : [],
      enrollment: r.enrollment,
      yearFounded: r.year_founded,
      deadline: r.application_deadline,
      lotteryDate: r.lottery_date,
      phone: r.phone,
      sharedBuilding: buildings.get(bkey(r)) > 1,
    }));
    this.cache = { meta: this.meta(), schools, ids: new Set(schools.map((s) => s.id)) };
    return this.cache;
  }

  hasSchool(id) {
    return this.schoolSummaries().ids.has(id);
  }

  schoolDetail(id) {
    const s = this.st('SELECT * FROM schools WHERE id = ?').get(id);
    if (!s) return null;
    const a = this.st('SELECT * FROM school_admissions WHERE school_id = ? ORDER BY cycle DESC LIMIT 1').get(id) || {};
    const c = this.st('SELECT * FROM school_contact_costs WHERE school_id = ?').get(id) || {};
    const summary = this.schoolSummaries().schools.find((x) => x.id === id);
    let checks = null;
    try {
      checks = s.checks ? JSON.parse(s.checks) : null;
    } catch {
      checks = null;
    }
    return {
      ...summary,
      officialName: s.official_name || null,
      doeCode: s.doe_code || null,
      enrollmentYear: s.enrollment_year || null,
      verification: checks
        ? { confirmedBy: checks.confirmed_by || [], geocoded: !!checks.geocoded, pinVsAddressM: checks.pin_vs_address_m ?? null,
            license: checks.license || null, flags: checks.flags || [], notes: checks.notes || [] }
        : null,
      mission: s.mission,
      source: s.source,
      lastVerified: s.last_verified,
      admissions: {
        cycle: a.cycle || null,
        howToApply: a.how_to_apply || null,
        eligibility: a.eligibility || null,
        lotteryPreferences: a.lottery_preferences || null,
        applicationOpen: a.application_open || null,
        applicationDeadline: a.application_deadline || null,
        deadlineNote: a.deadline_note || null,
        lotteryDate: a.lottery_date || null,
        lotteryNote: a.lottery_note || null,
        applyUrl: a.apply_url || null,
        applyUrlLabel: a.apply_url_label || null,
      },
      contact: {
        phone: c.phone || null,
        email: c.email || null,
        website: c.website || null,
      },
      costs: {
        tuitionFree: c.tuition_free !== 0,
        uniform: c.uniform || null,
        afterCare: c.after_care || null,
        meals: c.meals || null,
        transportation: c.transportation || null,
      },
    };
  }

  // ---- Users --------------------------------------------------------------------

  /** Creates or updates a user from verified Google claims. Only name, email and photo are kept. */
  upsertUser({ sub, email, name, picture }) {
    const photo = typeof picture === 'string' && /^https:\/\/lh3\.googleusercontent\.com\//.test(picture) ? picture : null;
    this.st(`INSERT INTO users (google_sub, email, name, photo_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, photo_url = excluded.photo_url`)
      .run(String(sub), String(email).slice(0, 320), name ? String(name).slice(0, 200) : null, photo);
    return this.st('SELECT id, email, name, photo_url FROM users WHERE google_sub = ?').get(String(sub));
  }

  getUser(id) {
    return this.st('SELECT id, email, name, photo_url FROM users WHERE id = ?').get(id) || null;
  }

  /** Erases a user and everything tied to them: profile, saved schools, notes, share link and analytics events. */
  deleteUser(id) {
    this.db.exec('BEGIN');
    try {
      this.st('DELETE FROM events WHERE user_id = ?').run(id);
      const n = this.st('DELETE FROM users WHERE id = ?').run(id).changes; // saved_schools cascade
      this.db.exec('COMMIT');
      return n > 0;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- Saved schools (always scoped to one user) --------------------------------

  listSaved(userId) {
    return this.st(`SELECT school_id AS schoolId, status, note, updated_at AS updatedAt FROM saved_schools
      WHERE user_id = ? ORDER BY created_at DESC`).all(userId).filter((r) => this.hasSchool(r.schoolId));
  }

  getSaved(userId, schoolId) {
    return this.st('SELECT school_id AS schoolId, status, note, updated_at AS updatedAt FROM saved_schools WHERE user_id = ? AND school_id = ?').get(userId, schoolId) || null;
  }

  /** Returns true when a new row was created. */
  addSaved(userId, schoolId) {
    const r = this.st('INSERT INTO saved_schools (user_id, school_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id, school_id) DO NOTHING').run(userId, schoolId, now());
    return r.changes > 0;
  }

  removeSaved(userId, schoolId) {
    return this.st('DELETE FROM saved_schools WHERE user_id = ? AND school_id = ?').run(userId, schoolId).changes > 0;
  }

  updateSaved(userId, schoolId, { status, note }) {
    const cur = this.getSaved(userId, schoolId);
    if (!cur) return null;
    const next = { status: status === undefined ? cur.status : status, note: note === undefined ? cur.note : note };
    if (!STATUSES.includes(next.status)) throw Object.assign(new Error('Invalid status'), { status: 400 });
    this.st('UPDATE saved_schools SET status = ?, note = ?, updated_at = ? WHERE user_id = ? AND school_id = ?').run(next.status, next.note, now(), userId, schoolId);
    return { before: cur, after: this.getSaved(userId, schoolId) };
  }

  // ---- Shareable shortlist ----------------------------------------------------

  setShareToken(userId, token) {
    this.st('UPDATE users SET share_token = ? WHERE id = ?').run(token, userId);
  }

  getShareToken(userId) {
    const r = this.st('SELECT share_token FROM users WHERE id = ?').get(userId);
    return r ? r.share_token : null;
  }

  userIdForShareToken(token) {
    const r = this.st('SELECT id FROM users WHERE share_token = ?').get(token);
    return r ? r.id : null;
  }

  // ---- Events -------------------------------------------------------------------

  addEvent({ userId = null, sessionId, name, props = {} }) {
    this.st('INSERT INTO events (user_id, session_id, name, props) VALUES (?, ?, ?, ?)').run(userId, sessionId, name, JSON.stringify(props));
  }

  events(name) {
    const rows = name
      ? this.st('SELECT * FROM events WHERE name = ? ORDER BY id').all(name)
      : this.st('SELECT * FROM events ORDER BY id').all();
    return rows.map((r) => ({ ...r, props: JSON.parse(r.props) }));
  }
}

module.exports = { Store };
