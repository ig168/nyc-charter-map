'use strict';

/**
 * Analytics event schema (PRD "Events to instrument"). Every event is validated against this
 * list before it is stored, so the events table only ever holds known names and properties.
 */

const { SCHOOL_ID, STATUSES } = require('./nyc');

const str = (max) => (v) => typeof v === 'string' && v.length <= max;
const oneOf = (...vals) => (v) => vals.includes(v);
const schoolId = (v) => typeof v === 'string' && SCHOOL_ID.test(v);
const count = (v) => Number.isInteger(v) && v >= 0 && v < 100000;
const filters = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = JSON.stringify(v);
  return s.length <= 600 && Object.keys(v).every((k) => ['borough', 'level', 'entry', 'district', 'zip', 'saved', 'inView', 'sort'].includes(k));
};
const SOURCES = ['pin', 'list', 'search', 'link', 'detail', 'my_schools', 'compare'];

const EVENTS = {
  search_performed: { query: str(100), filters, result_count: count },
  school_viewed: { school_id: schoolId, source: oneOf('pin', 'list', 'search', 'link') },
  outbound_link_clicked: { school_id: schoolId, type: oneOf('apply', 'website', 'directions', 'streetview', 'phone', 'email') },
  login_prompted: { trigger: oneOf('save', 'my_schools', 'header') },
  login_completed: { trigger: oneOf('save', 'my_schools', 'header') },
  favorite_added: { school_id: schoolId, source: oneOf(...SOURCES) },
  favorite_removed: { school_id: schoolId, source: oneOf(...SOURCES) },
  application_status_changed: { school_id: schoolId, from: oneOf(...STATUSES), to: oneOf(...STATUSES) },
};
// Events the browser may send directly. The rest are recorded by the server when the action happens.
const CLIENT_EVENTS = new Set(['search_performed', 'school_viewed', 'outbound_link_clicked', 'login_prompted']);
const SESSION_ID = /^[A-Za-z0-9_-]{16,64}$/;

function validateEvent(name, props) {
  const schema = EVENTS[name];
  if (!schema) return 'Unknown event';
  if (!props || typeof props !== 'object' || Array.isArray(props)) return 'props must be an object';
  for (const k of Object.keys(props)) if (!schema[k]) return `Unexpected property "${k}"`;
  for (const [k, check] of Object.entries(schema)) if (!check(props[k])) return `Invalid or missing "${k}"`;
  return null;
}

module.exports = { EVENTS, CLIENT_EVENTS, SESSION_ID, SOURCES, validateEvent };
