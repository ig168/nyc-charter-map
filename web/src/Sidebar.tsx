import React, { memo, startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from './App';
import type { Filters as FiltersT, Origin, SchoolSummary } from './types';
import {
  anyFilter, BKEY, BOROUGHS, boroughName, chipList, cloneFilters, core, distanceText, drawerCount, fmtNum, gradeLabel, gradeName, levelName,
  localToday, MOBILE, nextDeadlineText, t, toCsvDownload,
} from './lib';
import { Marked, SearchBox } from './SearchBox';

// ---------------------------------------------------------------------------------------------
// Per-option counts (each ignores its own filter)
// ---------------------------------------------------------------------------------------------
function useCounts(filters: FiltersT) {
  const app = useApp();
  const { schools, filterCtx } = app;
  return useMemo(() => {
    const c = { b: {} as Record<string, number>, l: {} as Record<string, number>, e: {} as Record<string, number>, d: {} as Record<string, number> };
    for (const s of schools as SchoolSummary[]) {
      if (core.matches(s, filters, filterCtx, 'boroughs')) c.b[s.borough] = (c.b[s.borough] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'levels')) for (const l of core.levelsOf(s.grades)) c.l[l] = (c.l[l] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'entry')) for (const g of s.entryGrades) c.e[g] = (c.e[g] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'districts')) c.d[String(s.district)] = (c.d[String(s.district)] || 0) + 1;
    }
    return c;
  }, [schools, filters, filterCtx]);
}

const chipProps = (on: boolean, n: number) => ({
  className: `chip${on ? ' is-on' : ''}`,
  'aria-pressed': on,
  count: <span className="chip__count" aria-label={t('nSchools', { n })}>{n}</span>,
});

// ---------------------------------------------------------------------------------------------
// Filters drawer (SX-10): entry grade, district, map area. Desktop: applies as you go.
// Phone: a bottom sheet that applies only on "Show N schools" (results are hidden behind it).
// ---------------------------------------------------------------------------------------------
function DrawerFields({ f, set, counts }: { f: FiltersT; set: (name: any, m: (f: any) => void, o?: { fit?: boolean }) => void; counts: ReturnType<typeof useCounts> }) {
  const app = useApp();
  const { schools } = app;
  const entries = useMemo(() => core.GRADES.filter((g: string) => schools.some((s: SchoolSummary) => s.entryGrades.includes(g))), [schools]);
  const districts = useMemo(() => {
    const ds = [...new Set(schools.map((s: SchoolSummary) => s.district).filter(Boolean))] as number[];
    return ds.sort((a, b) => a - b).map((d) => ({ d, borough: schools.find((s: SchoolSummary) => s.district === d)!.borough }));
  }, [schools]);
  useEffect(() => {
    if (!app.districtOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('#district-dd')) app.setDistrictOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [app.districtOpen, app.setDistrictOpen]);
  return (
    <div className="filter-grid">
      <div className="field">
        <label htmlFor="entry">{t('entryGrade')}</label>
        <select id="entry" value={f.entry} onChange={(e) => set('entry', (g: any) => (g.entry = e.target.value))}>
          <option value="">{t('anyEntryGrade')}</option>
          {entries.map((g: string) => (
            <option key={g} value={g}>{`${g === 'PK' || g === '0K' ? gradeName(g) : t('gradeN', { g: gradeName(g) })} (${counts.e[g] || 0})`}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <span className="field__label" id="district-label">{t('district')}</span>
        <details className="multi" id="district-dd" open={app.districtOpen} onToggle={(e) => app.setDistrictOpen((e.target as HTMLDetailsElement).open)}>
          <summary aria-describedby="district-label">
            <span id="district-summary">{f.districts.size ? [...f.districts].sort((a, b) => a - b).map((d) => t('districtShort', { d })).join(', ') : t('anyDistrict')}</span>
          </summary>
          <div className="multi__list" id="district-list" role="group" aria-labelledby="district-label">
            {districts.map(({ d, borough }) => (
              <label className="multi__opt" key={d}>
                <input type="checkbox" value={d} checked={f.districts.has(d)}
                  onChange={(e) => set('districts', (g: any) => (e.target.checked ? g.districts.add(d) : g.districts.delete(d)), { fit: true })} />{' '}
                <span>{t('districtN', { d })} <span className="muted">· {boroughName(borough)}</span></span>
                <span className="chip__count">{counts.d[String(d)] || 0}</span>
              </label>
            ))}
          </div>
        </details>
      </div>
      <label className="switch field--wide">
        <input type="checkbox" id="in-view" checked={f.inView} onChange={(e) => set('inView', (g: any) => (g.inView = e.target.checked))} />
        <span className="switch__track" aria-hidden="true"></span><span>{t('inView')}</span>
      </label>
    </div>
  );
}

function FiltersDrawer() {
  const app = useApp();
  const n = drawerCount(app.filters);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FiltersT | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const phone = MOBILE.matches;
  const draftCounts = useCounts(draft || app.filters);
  const liveCounts = useCounts(app.filters);
  const draftTotal = useMemo(() => (draft ? core.filterSchools(app.schools, draft, app.filterCtx).length : 0), [draft, app.schools, app.filterCtx]);

  const openIt = () => {
    if (phone) setDraft(cloneFilters(app.filters));
    setOpen(true);
  };
  const close = (apply: boolean) => {
    if (phone && apply && draft) {
      const d = draft;
      app.updateFilters('entry', (f: any) => {
        f.entry = d.entry;
        f.districts = new Set(d.districts);
        f.inView = d.inView;
      }, { fit: true });
    }
    setOpen(false);
    setDraft(null);
    btnRef.current?.focus();
  };
  // phone sheet: focus inside, Esc closes, Tab stays inside
  useEffect(() => {
    if (!open || !phone) return;
    document.body.classList.add('sheet-open');
    const el = sheetRef.current;
    (el?.querySelector('select, input, button') as HTMLElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('select, input, button, summary, [href]')].filter((x) => !x.hasAttribute('disabled') && x.offsetParent);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('sheet-open');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phone]);

  const setDraftF = (_name: any, m: (f: any) => void) =>
    setDraft((d) => {
      const g = cloneFilters(d || app.filters);
      m(g);
      return g;
    });

  return (
    <>
      <button type="button" ref={btnRef} className={`btn btn--ghost btn--sm filters-btn${n ? ' has-count' : ''}`} id="filters-btn"
        aria-expanded={open} aria-controls="filters-panel" onClick={() => (open ? close(false) : openIt())}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <span>{n ? t('filtersN', { n }) : t('filtersBtn')}</span>
      </button>
      {open && !phone ? (
        <div className="filters-panel" id="filters-panel" role="region" aria-label={t('moreFilters')}>
          <DrawerFields f={app.filters} set={app.updateFilters} counts={liveCounts} />
        </div>
      ) : null}
      {open && phone && draft ? createPortal(
        <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <div className="sheet" id="filters-panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheetRef}>
            <div className="sheet__head">
              <h2 id="sheet-title">{t('moreFilters')}</h2>
              <button type="button" className="icon-btn" aria-label={t('close')} onClick={() => close(false)}>×</button>
            </div>
            <div className="sheet__body">
              <DrawerFields f={draft} set={setDraftF} counts={draftCounts} />
            </div>
            <div className="sheet__foot">
              <button type="button" className="link-btn" onClick={() => setDraft((d) => ({ ...cloneFilters(d!), entry: '', districts: new Set(), inView: false }))}>{t('reset')}</button>
              <button type="button" className="btn btn--primary" id="sheet-apply" onClick={() => close(true)}>{t('showNSchools', { n: fmtNum(draftTotal) })}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Top of the sidebar: search, location banner, borough/grade chips
// ---------------------------------------------------------------------------------------------
function Filters() {
  const app = useApp();
  const { filters } = app;
  const counts = useCounts(filters);
  return (
    <div className="filters">
      <SearchBox />
      <LocationBanner />
      <p className="locate__msg" id="locate-msg" aria-live="polite" data-kind={app.locateMsg.kind} hidden={!app.locateMsg.text || app.locateMsg.kind === 'ok'}>
        {app.locateMsg.text}
      </p>

      <div className="filter-group">
        <span className="filter-group__label" id="borough-label">{t('borough')}</span>
        <div className="chips" id="borough-chips" role="group" aria-labelledby="borough-label">
          {BOROUGHS.map((b) => {
            const c = chipProps(filters.boroughs.has(b.id), counts.b[b.id] || 0);
            return (
              <button key={b.id} type="button" className={c.className} data-borough={b.id} aria-pressed={c['aria-pressed']}
                onClick={() => app.updateFilters('boroughs', (f: any) => (f.boroughs.has(b.id) ? f.boroughs.delete(b.id) : f.boroughs.add(b.id)), { fit: true })}>
                <i className={`swatch swatch--${b.key}`} aria-hidden="true"></i>{boroughName(b.id)}{c.count}
              </button>
            );
          })}
        </div>
      </div>

      <div className="filter-group">
        <span className="filter-group__label" id="level-label">{t('gradeLevel')}</span>
        <div className="chips" id="level-chips" role="group" aria-labelledby="level-label">
          {core.LEVEL_IDS.map((l: string) => {
            const c = chipProps(filters.levels.has(l), counts.l[l] || 0);
            return (
              <button key={l} type="button" className={c.className} data-level={l} aria-pressed={c['aria-pressed']}
                onClick={() => app.updateFilters('levels', (f: any) => (f.levels.has(l) ? f.levels.delete(l) : f.levels.add(l)))}>
                {levelName(l)}{c.count}
              </button>
            );
          })}
        </div>
      </div>

      <div className="toggles">
        <label className="switch">
          <input type="checkbox" id="saved-only" checked={filters.savedOnly}
            onChange={(e) => {
              if (e.target.checked && !app.user) {
                app.openSignIn('my_schools');
                return;
              }
              app.updateFilters('savedOnly', (f: any) => (f.savedOnly = e.target.checked));
            }} />
          <span className="switch__track" aria-hidden="true"></span><span>{t('savedOnly')}</span>
        </label>
        <FiltersDrawer />
      </div>
    </div>
  );
}

/** After a zip, address or Near me (SX-07, SX-08): how many nearby, radius, district. */
function LocationBanner() {
  const app = useApp();
  const o: Origin | null = app.origin;
  if (!o) return null;
  const n = app.filtered.length;
  const r = app.filters.radius;
  const nearestMi = app.filtered.length ? core.distanceKm(o, app.filtered[0]) * 0.621371 : 0;
  return (
    <div className="loc-banner" id="loc-banner" role="region" aria-label={t('locationResults')}>
      <div className="loc-banner__row">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c-3.6 0-6.5 2.8-6.5 6.4 0 4.8 6.5 12.6 6.5 12.6s6.5-7.8 6.5-12.6c0-3.6-2.9-6.4-6.5-6.4zm0 8.9a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor" /></svg>
        <p className="loc-banner__text" id="loc-text">
          {app.nearest
            ? t('noneWithinShowingNearest', { r, p: o.label, n, d: core.formatMiles(nearestMi / 0.621371, app.lang) })
            : r
              ? t('nWithinR', { n: fmtNum(n), r, p: o.label })
              : t('nAnyDistance', { n: fmtNum(n), p: o.label })}
        </p>
        <button type="button" className="link-btn" id="clear-origin" onClick={() => app.setOrigin(null)}>{t('clearLocation')}</button>
      </div>
      <div className="loc-banner__row loc-banner__controls">
        <label htmlFor="radius" className="small">{t('within')}</label>
        <select id="radius" value={String(r)} onChange={(e) => app.updateFilters('radius', (f: any) => (f.radius = Number(e.target.value)))}>
          {[1, 2, 5].map((m) => <option key={m} value={m}>{t('nMiles', { n: m })}</option>)}
          <option value="0">{t('anyDistance')}</option>
        </select>
        <span className="small muted">{t('sortedByDistanceShort')}</span>
      </div>
      {o.district ? (
        <p className="loc-banner__district" id="your-district">
          <strong>{t('yourDistrict', { d: o.district })}</strong> {t('yourDistrictWhy')}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
interface CardProps {
  s: SchoolSummary; saved: boolean; compared: boolean; selected: boolean; highlight: boolean; hover: boolean; origin: Origin | null; lng: string; q: string;
  homeDistrict: boolean;
  onOpen: (id: string) => void; onSave: (id: string) => void; onCompare: (id: string, on: boolean, el: HTMLInputElement) => void;
  onHover: (id: string, on: boolean) => void;
}

const SchoolCard = memo(function SchoolCard({ s, saved, compared, selected, highlight, hover, origin, q, homeDistrict, onOpen, onSave, onCompare, onHover }: CardProps) {
  const dist = distanceText(origin, s);
  const sub = [s.neighborhood, boroughName(s.borough)].filter(Boolean).join(' · ');
  return (
    <li className={`card${selected ? ' is-selected' : ''}${highlight ? ' is-highlight' : ''}${hover ? ' is-hover' : ''}`} data-id={s.id}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('label, a, button')) onOpen(s.id); }}
      onMouseEnter={() => onHover(s.id, true)} onMouseLeave={() => onHover(s.id, false)}>
      <span className={`card__bar card__bar--${BKEY[s.borough]}`} aria-hidden="true"></span>
      <button type="button" className="card__main" data-action="open" aria-describedby={`m-${s.id}`} onClick={() => onOpen(s.id)}>
        <span className="card__name"><Marked name={s.name} q={q} /></span>
      </button>
      <div className="card__body" id={`m-${s.id}`}>
        <span className="card__meta">{sub}</span>
        {s.network ? <span className="card__network">{s.network}</span> : null}
        <span className="card__tags">
          <span className="tag">{t('gradesX', { g: gradeLabel(s.grades) })}</span>
          {homeDistrict ? <span className="tag tag--home">{t('inYourDistrict')}</span> : null}
          {s.deadline ? <span className="tag tag--soft">{nextDeadlineText(s)}</span> : null}
          {dist ? <span className="card__dist">{dist}</span> : null}
        </span>
      </div>
      <div className="card__side">
        <button type="button" className={`star${saved ? ' is-saved' : ''}`} data-action="save" aria-pressed={saved}
          aria-label={t(saved ? 'unsaveSchoolX' : 'saveSchoolX', { n: s.name })} onClick={() => onSave(s.id)}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
        </button>
        <label className="cmp" title={t('compare')}>
          <input type="checkbox" data-action="compare" checked={compared} aria-label={t('compareX', { n: s.name })}
            onChange={(e) => onCompare(s.id, e.target.checked, e.target)} />
          <span aria-hidden="true">{t('compareShort')}</span>
        </label>
      </div>
    </li>
  );
});

// First screenful renders in the same frame as the filter change; the rest fills in during idle time,
// so every result is in the page (screen readers, find-in-page) without slowing the click (PERF-01).
const FIRST = 40;
const IDLE_MAX = Infinity; // every result ends up in the DOM (find-in-page, screen-reader browsing); growth is idle-time and interruptible
const CHUNK = 30; // small enough that each idle chunk stays well under a frame budget on slow phones

function Results() {
  const app = useApp();
  const { saved, compare, selectedId, highlightId, hoverId, origin } = app as any;
  const filtered: SchoolSummary[] = useDeferredValue(app.filtered); // cards render after the urgent chip/count update
  const [limit, setLimit] = useState(FIRST);
  const listRef = useRef(filtered);
  if (listRef.current !== filtered) {
    listRef.current = filtered;
    if (limit !== FIRST) setLimit(FIRST);
  }
  // Grow the list in idle time up to IDLE_MAX cards; past that, only as the reader scrolls near the end.
  // Keeps the DOM small so every filter change or keystroke has little to tear down (SXP-01 / PERF-01).
  const sentinel = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (limit >= filtered.length) return;
    if (limit < IDLE_MAX) {
      const ric: any = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 16));
      const cic: any = (window as any).cancelIdleCallback || clearTimeout;
      const h = ric(() => startTransition(() => setLimit((n: number) => Math.min(n + CHUNK, IDLE_MAX))), { timeout: 60 }); // interruptible by typing
      return () => cic(h);
    }
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setLimit(filtered.length);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && startTransition(() => setLimit((n: number) => n + CHUNK)), { rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, filtered]);

  const handlers = useMemo(
    () => ({
      onOpen: (id: string) => app.openDetail(id, { source: app.filters.q ? 'search' : 'list' }),
      onSave: (id: string) => app.toggleSave(id, 'list'),
      onCompare: (id: string, on: boolean, el: HTMLInputElement) => {
        if (!app.toggleCompare(id, on)) el.checked = false;
      },
      onHover: (id: string, on: boolean) => app.mapApi.current?.hover(id, on),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app.openDetail, app.toggleSave, app.toggleCompare, app.filters.q],
  );

  // keep the highlighted card in view when a pin is clicked
  useEffect(() => {
    if (!highlightId || MOBILE.matches) return;
    document.querySelector(`#results .card[data-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlightId]);

  if (!app.loaded) {
    return (
      <ul className="results" id="results" tabIndex={-1} aria-label={t('resultsLabel')}>
        {app.loadError ? null : Array.from({ length: 6 }, (_, i) => <li key={i} className="card card--skeleton" aria-hidden="true"><span></span><span></span></li>)}
      </ul>
    );
  }
  const shown = filtered.slice(0, Math.max(limit, FIRST));
  // the selected or highlighted school must exist in the DOM even if it is far down the list
  const extra = [selectedId, highlightId, hoverId].filter((id: string | null) => id && !shown.some((s) => s.id === id) && filtered.some((s) => s.id === id));
  const list = extra.length ? filtered.filter((s) => shown.includes(s) || extra.includes(s.id)) : shown;
  const q = app.rank && !app.rank.parsed.zip && !app.rank.parsed.address ? app.filters.q : '';
  const homeD = origin?.district;
  return (
    <ul className="results" id="results" tabIndex={-1} aria-label={t('resultsLabel')}>
      {list.map((s) => (
        <SchoolCard key={s.id} s={s} saved={saved.has(s.id)} compared={compare.has(s.id)} selected={s.id === selectedId} highlight={s.id === highlightId}
          hover={s.id === hoverId} origin={origin} lng={app.lang} q={q} homeDistrict={!!homeD && s.district === homeD} {...handlers} />
      ))}
      {shown.length < filtered.length ? <li ref={sentinel} className="results__more" aria-hidden="true"></li> : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Zero results (SX-05): previewed ways out, each with its real count; "did you mean"
// ---------------------------------------------------------------------------------------------
function relaxLabel(r: { key: string; value?: string }, f: FiltersT) {
  switch (r.key) {
    case 'q': return t('relaxQ', { q: f.q });
    case 'boroughs': return t('relaxRemove', { f: boroughName(r.value!) });
    case 'levels': return t('relaxRemove', { f: levelName(r.value!) });
    case 'entry': return t('relaxRemove', { f: t('entryChip', { g: gradeName(f.entry) }) });
    case 'districts': return t('relaxRemove', { f: t('districtN', { d: r.value }) });
    case 'networks':
    case 'places': return t('relaxRemove', { f: r.value });
    case 'zip': return t('relaxRemove', { f: t('zipChip', { z: f.zip }) });
    case 'savedOnly': return t('relaxRemove', { f: t('savedOnly') });
    case 'inView': return t('relaxInView');
    case 'radius': return t('relaxRadius');
    default: return r.key;
  }
}

function Empty() {
  const app = useApp();
  const f: FiltersT = app.filters;
  const empty = app.loaded && !app.filtered.length && !app.loadError;
  const rel = useMemo(() => (empty ? (core.relaxations(app.schools, f, app.filterCtx) as { key: any; value?: string; count: number }[]).slice(0, 3) : []), [empty, app.schools, f, app.filterCtx]);
  const p = app.rank?.parsed;
  const textMisses = !!(app.rank && !app.rank.hits.size && !p?.zip && !p?.address);
  const dym = useMemo(() => (empty && textMisses && !p?.psNumber ? app.search.didYouMean(f.q) : null), [empty, textMisses, f.q, p, app.search]);
  // Only one way out (and it isn't their own typing): take it, say so, offer undo
  const auto = useRef('');
  useEffect(() => {
    if (!empty || rel.length !== 1 || rel[0].key === 'q' || app.filterOrder[app.filterOrder.length - 1] === 'q') return;
    const r = rel[0];
    const sig = `${r.key}|${r.value}`;
    if (auto.current === sig) return;
    auto.current = sig;
    const before = cloneFilters(f);
    const label = relaxLabel(r, f).replace(/^\S+\s/, '');
    app.removeFilter(r.key, r.value);
    setTimeout(() => app.setNotice({ text: t('autoRelaxed', { f: label, n: fmtNum(r.count) }), undo: () => app.setFilters(before) }), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, rel]);

  if (app.loadError) {
    return (
      <div className="empty" id="empty">
        <p><strong>{t('loadFailed')}</strong></p><p className="muted">{app.loadError}</p>
        <button type="button" className="btn btn--primary btn--sm" id="retry-load" onClick={() => location.reload()}>{t('retry')}</button>
      </div>
    );
  }
  if (!empty) return <div className="empty" id="empty" hidden></div>;
  const last = app.filterOrder[app.filterOrder.length - 1];
  const lastChip = chipList(f).filter((c) => c.key === last).pop();
  return (
    <div className="empty" id="empty">
      <p><strong>{p?.psNumber ? t('psNote') : t('emptyTitle')}</strong></p>
      {dym ? (
        <p className="empty__dym">
          {t('didYouMean')}{' '}
          <button type="button" className="link-btn" data-empty="dym" onClick={() => { app.setSearchText(dym.query); app.updateFilters('q', (g: any) => (g.q = dym.query)); }}>{dym.label}</button>?
        </p>
      ) : null}
      {rel.length ? (
        <>
          <p className="muted">{t('emptyTry')}</p>
          <ul className="relax-list">
            {rel.map((r) => (
              <li key={`${r.key}|${r.value ?? ''}`}>
                <button type="button" className="btn btn--ghost btn--sm" data-empty="relax" data-key={r.key} data-value={r.value ?? ''}
                  onClick={() => {
                    if (r.key === 'q') app.setSearchText('');
                    app.removeFilter(r.key, r.value);
                  }}>
                  {relaxLabel(r, f)} <span className="relax-count">({fmtNum(r.count)})</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="muted">{t('emptyBody')}</p>}
      <div className="empty__actions">
        {lastChip && !rel.some((r) => r.key === lastChip.key) ? (
          <button type="button" className="btn btn--ghost btn--sm" data-empty="loosen" onClick={() => app.removeFilter(lastChip.key, lastChip.value)}>
            {t('removeX', { f: lastChip.label })}
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost btn--sm" data-empty="clear" onClick={app.clearAll}>{t('clearAllFilters')}</button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const app = useApp();
  const chips = chipList(app.filters);
  const n = app.filtered.length;
  const total = app.schools.length;

  // one polite announcement after typing or filtering pauses (SX-12)
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (!app.loaded) return;
    const h = setTimeout(() => setAnnounce(anyFilter(app.filters) || app.origin ? t('srCount', { n: fmtNum(n), total: fmtNum(total) }) : ''), 900);
    return () => clearTimeout(h);
  }, [n, total, app.filters, app.origin, app.loaded, app.lang]);

  const exportCsv = () => {
    const header = ['Name', 'Network', 'Borough', 'District', 'Neighborhood', 'Address', 'Zip', 'Grades', 'Entry grades', 'Enrollment', 'Year opened', 'Application deadline', 'Phone', 'Saved', 'Campus ID', 'Latitude', 'Longitude'];
    if (app.origin) header.push('Distance (mi)');
    const rows = (app.filtered as SchoolSummary[]).map((s) => {
      const r: unknown[] = [s.name, s.network, s.borough, s.district, s.neighborhood, s.address, s.zip, core.gradeLabel(s.grades, 'en'),
        s.entryGrades.map((g) => core.gradeName(g, 'en')).join(' '), s.enrollment, s.yearFounded, s.deadline, s.phone, app.saved.has(s.id) ? 'Yes' : '', s.id, s.lat, s.lng];
      if (app.origin) r.push((core.distanceKm(app.origin, s) * 0.621371).toFixed(2));
      return r;
    });
    toCsvDownload(header, rows, `nyc-charter-schools-${localToday()}.csv`);
    app.toast(t('csvDone', { n: rows.length }));
  };

  return (
    <aside className="sidebar" id="sidebar" aria-label={t('searchAndResults')}>
      <Filters />
      <div className="active-filters" id="active-filters" hidden={!chips.length}>
        <ul className="active-filters__list" id="active-chips" aria-label={t('activeFilters')}>
          {chips.map((c) => (
            <li key={`${c.key}|${c.value ?? ''}`}>
              <button type="button" className="active-chip" data-key={c.key} data-value={c.value ?? ''} aria-label={t('removeFilter', { f: c.label })}
                onClick={() => {
                  if (c.key === 'q') app.setSearchText('');
                  app.removeFilter(c.key, c.value);
                }}>
                <span>{c.label}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="link-btn" id="clear-all" onClick={app.clearAll}>{t('clearAll')}</button>
      </div>
      {app.notice ? (
        <p className="notice" id="auto-notice" role="status">
          {app.notice.text}{' '}
          {app.notice.undo ? <button type="button" className="link-btn" onClick={() => { app.notice.undo(); app.setNotice(null); }}>{t('undo')}</button> : null}
        </p>
      ) : null}
      <div className="results-bar">
        <p className="results-bar__count" id="result-count" aria-atomic="true">
          {!app.loaded ? (app.loadError ? '' : t('loadingSchools')) : (
            <CountText filtered={anyFilter(app.filters) || !!app.origin} n={n} total={total} />
          )}
        </p>
        <div className="results-bar__actions">
          <label className="visually-hidden" htmlFor="sort">{t('sortBy')}</label>
          <select id="sort" value={app.sort}
            onChange={(e) => {
              app.setSort(e.target.value);
              if (e.target.value === 'distance' && !app.origin) {
                app.locateError(t('setLocationForDistance'));
                document.getElementById('search')?.focus();
              }
            }}>
            {app.filters.q ? <option value="relevance">{t('sortRelevance')}</option> : null}
            <option value="name">{t('sortName')}</option>
            <option value="distance">{t('sortDistance')}</option>
            <option value="deadline">{t('sortDeadline')}</option>
          </select>
          <button className="icon-btn" id="export-csv" type="button" title={t('exportCsv')} aria-label={t('exportCsv')} onClick={exportCsv}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" id="sr-status">{announce}</p>
      <Results />
      <Empty />
      <footer className="side-foot">
        <a href="/about">{t('aboutLink')}</a> · <a href="/privacy">{t('privacyLink')}</a>
      </footer>
    </aside>
  );
}

/** "Showing <b>n</b> of N schools": the translation carries the placement of the bold number. */
function CountText({ filtered, n, total }: { filtered: boolean; n: number; total: number }) {
  const MARK = '\u0000';
  const s = filtered ? t('countFiltered', { n: MARK, total: fmtNum(total) }) : t('countAll', { n: MARK });
  const [a, b] = s.split(MARK);
  return <>{a}<strong>{fmtNum(filtered ? n : total)}</strong>{b}</>;
}
