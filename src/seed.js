'use strict';

/**
 * Seed validation (DATA-01). Fails on missing required fields or coordinates outside NYC, and
 * reports per-field completeness (the PRD's "seed data completeness" guardrail).
 */

const { BOROUGHS, BOROUGH_LETTER, GRADES, SCHOOL_ID, isNycZip, inNyc } = require('./nyc');

const MIN_SCHOOLS = 40;
const MIN_COMPLETE_SHARE = 0.8;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\d{3}-\d{3}-\d{4}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

const isHttps = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};
const filled = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);

function validateSeed(seed) {
  const errors = [];
  const warnings = [];
  const err = (id, msg) => errors.push(id ? `${id}: ${msg}` : msg);

  if (!seed || typeof seed !== 'object' || !Array.isArray(seed.schools)) {
    return { ok: false, errors: ['Seed must be an object with a "schools" array'], warnings, stats: null };
  }
  if (!seed.version) err(null, 'Seed is missing a "version"');

  const schools = seed.schools;
  if (schools.length < MIN_SCHOOLS) err(null, `Seed has ${schools.length} schools; at least ${MIN_SCHOOLS} are required`);

  const ids = new Set();
  for (const [i, s] of schools.entries()) {
    const id = s && s.id ? s.id : `#${i}`;
    if (!s || typeof s !== 'object') {
      err(id, 'record is not an object');
      continue;
    }
    // Required fields
    if (!SCHOOL_ID.test(s.id || '') || s.id.length > 90) err(id, 'invalid or missing id');
    else if (ids.has(s.id)) err(id, 'duplicate id');
    ids.add(s.id);
    if (!filled(s.name) || typeof s.name !== 'string') err(id, 'missing name');
    if (!BOROUGHS.includes(s.borough)) err(id, `invalid borough "${s.borough}"`);
    else if (SCHOOL_ID.test(s.id || '') && BOROUGH_LETTER[s.id[0]] !== s.borough) err(id, 'borough does not match the id prefix');
    if (!filled(s.address)) err(id, 'missing address');
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') err(id, 'missing lat/lng');
    else if (!inNyc(s.lat, s.lng)) err(id, `coordinates ${s.lat},${s.lng} are outside New York City`);
    if (!Array.isArray(s.grades_served) || !s.grades_served.length) err(id, 'missing grades_served');
    else if (s.grades_served.some((g) => !GRADES.includes(g))) err(id, 'grades_served has an unknown grade');
    if (!Array.isArray(s.entry_grades) || s.entry_grades.some((g) => !(s.grades_served || []).includes(g))) {
      err(id, 'entry_grades must be a subset of grades_served');
    }
    if (!filled(s.source)) err(id, 'missing source');
    if (!ISO_DATE.test(s.last_verified || '')) err(id, 'missing or invalid last_verified date');

    // Optional fields: must be well-formed when present
    if (filled(s.zip) && !isNycZip(s.zip)) err(id, `zip ${s.zip} is not a NYC zip code`);
    if (filled(s.district) && !(Number.isInteger(s.district) && s.district >= 1 && s.district <= 32)) err(id, 'district must be 1–32');
    if (filled(s.enrollment) && !(Number.isInteger(s.enrollment) && s.enrollment >= 0)) err(id, 'enrollment must be a whole number');
    if (filled(s.year_founded) && !(Number.isInteger(s.year_founded) && s.year_founded >= 1990 && s.year_founded <= 2100)) err(id, 'year_founded out of range');

    const a = s.admissions || {};
    for (const k of ['application_open', 'application_deadline', 'lottery_date']) {
      if (filled(a[k]) && !ISO_DATE.test(a[k])) err(id, `admissions.${k} must be YYYY-MM-DD`);
    }
    if (filled(a.apply_url) && !isHttps(a.apply_url)) err(id, 'admissions.apply_url must be an https URL');

    const c = s.contact_costs || {};
    if (filled(c.phone) && !PHONE.test(c.phone)) err(id, 'contact phone must look like 212-555-0100');
    if (filled(c.email) && !EMAIL.test(c.email)) err(id, 'contact email is invalid');
    if (filled(c.website) && !isHttps(c.website)) err(id, 'contact website must be an https URL');
    if (typeof c.tuition_free !== 'boolean') err(id, 'contact_costs.tuition_free must be true/false');
  }

  // Cross-source checks (campus-level seed): every campus is backed by a current listing and a confirmed location
  let multiSource = 0, geocoded = 0, licensed = 0;
  if (seed.unit === 'campus') {
    const LISTINGS = /FINDER|website/i;
    const names = new Map();
    for (const s of schools) {
      if (!s || !s.id) continue;
      const c = s.checks;
      if (!c || !Array.isArray(c.confirmed_by)) {
        err(s.id, 'missing checks.confirmed_by');
        continue;
      }
      const listings = c.confirmed_by.filter((x) => LISTINGS.test(x));
      if (!listings.length) err(s.id, 'not confirmed by any current listing (FINDER or the network website)');
      if (c.confirmed_by.filter((x) => !/GeoSearch/.test(x)).length >= 2) multiSource++;
      if (c.geocoded) {
        geocoded++;
        if (typeof c.pin_vs_address_m === 'number' && c.pin_vs_address_m > 150) err(s.id, `pin is ${c.pin_vs_address_m} m from the geocoded address`);
      } else if (!(c.flags || []).some((f) => /geocoder/.test(f))) {
        err(s.id, 'location not geocoded and no flag explains why');
      }
      if (c.license) licensed++;
      const k = String(s.name).toLowerCase();
      if (names.has(k)) err(s.id, `same name as ${names.get(k)}; campuses must be distinguishable`);
      names.set(k, s.id);
    }
  }

  const present = new Set(schools.map((s) => s && s.borough));
  for (const b of BOROUGHS) if (!present.has(b)) err(null, `No schools in ${b}; all 5 boroughs are required`);

  // Completeness, reported per field (guardrail metric)
  const fields = {
    network: (s) => s.network,
    zip: (s) => s.zip,
    district: (s) => s.district,
    enrollment: (s) => s.enrollment,
    year_founded: (s) => s.year_founded,
    mission: (s) => s.mission,
    application_deadline: (s) => s.admissions && s.admissions.application_deadline,
    apply_url: (s) => s.admissions && s.admissions.apply_url,
    phone: (s) => s.contact_costs && s.contact_costs.phone,
    email: (s) => s.contact_costs && s.contact_costs.email,
    website: (s) => s.contact_costs && s.contact_costs.website,
    uniform: (s) => s.contact_costs && s.contact_costs.uniform,
    after_care: (s) => s.contact_costs && s.contact_costs.after_care,
    meals: (s) => s.contact_costs && s.contact_costs.meals,
    transportation: (s) => s.contact_costs && s.contact_costs.transportation,
  };
  const n = schools.length || 1;
  const completeness = {};
  for (const [k, get] of Object.entries(fields)) completeness[k] = Math.round((schools.filter((s) => s && filled(get(s))).length / n) * 1000) / 10;

  const datesShare = schools.filter((s) => s && s.admissions && filled(s.admissions.application_deadline)).length / n;
  const contactShare = schools.filter((s) => s && s.contact_costs && filled(s.contact_costs.phone) && filled(s.address)).length / n;
  if (datesShare < MIN_COMPLETE_SHARE) err(null, `Only ${Math.round(datesShare * 100)}% of schools have admissions dates (need ${MIN_COMPLETE_SHARE * 100}%)`);
  if (contactShare < MIN_COMPLETE_SHARE) err(null, `Only ${Math.round(contactShare * 100)}% of schools have contact details (need ${MIN_COMPLETE_SHARE * 100}%)`);
  if (datesShare === 1) warnings.push('Every school has an admissions date, so the "no deadline" empty state is only exercised in tests.');

  const byBorough = Object.fromEntries(BOROUGHS.map((b) => [b, schools.filter((s) => s && s.borough === b).length]));
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      count: schools.length, byBorough, completeness, admissionsDatesPct: Math.round(datesShare * 100), contactPct: Math.round(contactShare * 100),
      ...(seed.unit === 'campus' ? { confirmedBy2PlusPct: Math.round((multiSource / n) * 100), geocodedPct: Math.round((geocoded / n) * 100), licenseMatchedPct: Math.round((licensed / n) * 100) } : {}),
    },
  };
}

module.exports = { validateSeed, MIN_SCHOOLS };
