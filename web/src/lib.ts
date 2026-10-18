// Shared helpers for the React front end. The filter/sort/search logic (core), translations (i18n) and pin
// clustering (cluster) are the same UMD modules the Node tests exercise, so behaviour is tested in one place.
import coreModule from '../../public/js/core.js';
import i18nModule from '../../public/js/i18n.js';
import clusterModule from '../../public/js/cluster.js';
import searchModule from '../../public/js/search.js';
import type { Borough, SchoolSummary, Filters } from './types';

// If the page already loaded these modules (the hosted demo does, for its offline API shim), share that
// instance so both sides agree on the current language.
const pre: any = (window as any).NCS || {};
export const core: any = pre.core || coreModule;
export const i18n: any = pre.i18n || i18nModule;
export const clusterLib: any = pre.cluster || clusterModule;
export const searchLib: any = pre.search || searchModule;

export const t = (k: string, v?: Record<string, unknown>): string => i18n.t(k, v);
export const lang = (): 'en' | 'es' => i18n.lang();

export const BOROUGHS: { id: Borough; key: string; color: string }[] = [
  { id: 'Manhattan', key: 'manhattan', color: '#2462d8' },
  { id: 'Brooklyn', key: 'brooklyn', color: '#c4650a' },
  { id: 'Bronx', key: 'bronx', color: '#0f7a57' },
  { id: 'Queens', key: 'queens', color: '#7b3fc7' },
  { id: 'Staten Island', key: 'staten', color: '#c2334d' },
];
export const BKEY: Record<string, string> = Object.fromEntries(BOROUGHS.map((b) => [b.id, b.key]));
export const STATUSES = ['researching', 'applied', 'waitlisted', 'offered', 'accepted', 'declined'] as const;
export const NOTE_MAX = 2000;
export const COMPARE_MAX = 4;
export const NYC_CENTER: [number, number] = [40.7128, -73.94];
export const MOBILE = window.matchMedia('(max-width: 860px)');

const pad = (n: number) => String(n).padStart(2, '0');
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for the few HTML strings Leaflet needs (popups, legend); React escapes everything else. */
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const safeUrl = (u?: string | null) => {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.href : null;
  } catch {
    return null;
  }
};
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let h: ReturnType<typeof setTimeout>;
  return (...a: A) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...a), ms);
  };
}
export const fmtNum = (n: number) => Number(n).toLocaleString(lang() === 'es' ? 'es-US' : 'en-US');
export const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(lang() === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' });
export const gradeLabel = (g: string[]) => core.gradeLabel(g, lang());
export const gradeName = (g: string) => core.gradeName(g, lang());
export const boroughName = (b: string) => t(`boro_${BKEY[b] || 'other'}`);
export const levelName = (l: string) => t(`level_${l}`);
export const statusName = (s: string) => t(`status_${s}`);
export const hostOf = (u: string) => new URL(u).host.replace(/^www\./, '');

// ---- Storage (private mode safe) -------------------------------------------------------------
function store(kind: 'sessionStorage' | 'localStorage'): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}
const ss = store('sessionStorage');
export const ssGet = (k: string) => {
  try {
    return ss ? ss.getItem(k) : null;
  } catch {
    return null;
  }
};
export const ssSet = (k: string, v: string | null) => {
  try {
    if (ss) v === null ? ss.removeItem(k) : ss.setItem(k, v);
  } catch {
    /* private mode */
  }
};

// Anonymous analytics session id (not an auth token; never contains personal data).
let analyticsId = ssGet('ncs_asid');
if (!analyticsId || !/^[A-Za-z0-9_-]{16,64}$/.test(analyticsId)) {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  analyticsId = btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  ssSet('ncs_asid', analyticsId);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON API call with the CSRF header the server requires on every state change. */
export async function api<T = any>(path: string, { method = 'GET', body }: { method?: string; body?: object } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify({ ...body, session_id: analyticsId }) : undefined,
    });
  } catch {
    throw new ApiError(0, t('errNetwork'));
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).message || t('errGeneric'));
  return data as T;
}

export function track(name: string, props: Record<string, unknown>) {
  fetch('/api/events', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ name, props, session_id: analyticsId }),
  }).catch(() => {});
}

// ---- Filters -----------------------------------------------------------------------------------
export const FILTER_KEYS = ['q', 'boroughs', 'levels', 'entry', 'districts', 'zip', 'savedOnly', 'inView', 'networks', 'places', 'radius'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export function isActive(f: Filters, name: FilterKey) {
  return {
    q: !!f.q, boroughs: f.boroughs.size > 0, levels: f.levels.size > 0, entry: !!f.entry,
    districts: f.districts.size > 0, zip: !!f.zip, savedOnly: f.savedOnly, inView: f.inView,
    networks: f.networks.size > 0, places: f.places.size > 0, radius: !!f.radius,
  }[name];
}
export const anyFilter = (f: Filters) => FILTER_KEYS.some((k) => k !== 'radius' && isActive(f, k));
export const cloneFilters = (f: Filters): Filters => ({
  ...f, boroughs: new Set(f.boroughs), levels: new Set(f.levels), districts: new Set(f.districts),
  networks: new Set(f.networks), places: new Set(f.places),
});
/** Filters that live in the Filters drawer (counted on its button). */
export const drawerCount = (f: Filters) => (f.entry ? 1 : 0) + f.districts.size + (f.inView ? 1 : 0);

export function chipList(f: Filters) {
  const out: { key: FilterKey; value?: string; label: string }[] = [];
  if (f.q) out.push({ key: 'q', label: `“${f.q}”` });
  for (const b of f.boroughs) out.push({ key: 'boroughs', value: b, label: boroughName(b) });
  for (const l of f.levels) out.push({ key: 'levels', value: l, label: levelName(l) });
  if (f.entry) out.push({ key: 'entry', label: t('entryChip', { g: gradeName(f.entry) }) });
  for (const d of [...f.districts].sort((a, b) => a - b)) out.push({ key: 'districts', value: String(d), label: t('districtN', { d }) });
  for (const n of f.networks) out.push({ key: 'networks', value: n, label: n });
  for (const p of f.places) out.push({ key: 'places', value: p, label: p });
  if (f.zip) out.push({ key: 'zip', label: t('zipChip', { z: f.zip }) });
  if (f.savedOnly) out.push({ key: 'savedOnly', label: t('savedOnly') });
  if (f.inView) out.push({ key: 'inView', label: t('inView') });
  return out;
}

export function nextDeadlineText(s: SchoolSummary) {
  if (!s.deadline) return '';
  const days = core.daysUntil(s.deadline, localToday());
  if (days < 0) return t('deadlinePassed');
  return t('deadlineOn', { d: fmtDate(s.deadline) });
}

export const distanceText = (origin: { lat: number; lng: number } | null, s: { lat: number; lng: number }) =>
  origin ? core.formatMiles(core.distanceKm(origin, s), lang()) : null;

/** Downloads rows as a UTF-8 CSV (with BOM so Excel reads accents); core.toCsv neutralises spreadsheet formulas. */
export function toCsvDownload(header: string[], rows: unknown[][], filename: string) {
  const blob = new Blob([`﻿${core.toCsv(header, rows)}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- Recent searches (this browser only; never addresses, zip codes or coordinates) ------------------
export interface Recent { type: 'text' | 'school' | 'network' | 'place'; label: string; value: string }
function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function getRecent(): Recent[] {
  try {
    const v = JSON.parse(ls()?.getItem('ncs_recent') || '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.label === 'string' && typeof r.value === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}
export function addRecent(r: Recent) {
  // privacy: anything that looks like a location is never stored
  if (/\d{5}/.test(r.value) || searchLib.parse(r.value).address) return;
  try {
    const list = [r, ...getRecent().filter((x) => !(x.type === r.type && x.value === r.value))].slice(0, 5);
    ls()?.setItem('ncs_recent', JSON.stringify(list));
  } catch {
    /* storage blocked */
  }
}
export function clearRecent() {
  try {
    ls()?.removeItem('ncs_recent');
  } catch {
    /* storage blocked */
  }
}
