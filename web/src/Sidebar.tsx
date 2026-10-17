import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './App';
import type { Origin, SchoolSummary } from './types';
import {
  anyFilter, BKEY, BOROUGHS, boroughName, chipList, core, debounce, distanceText, fmtNum, gradeLabel, gradeName, lang, levelName,
  localToday, MOBILE, nextDeadlineText, t, toCsvDownload,
} from './lib';

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------
function Filters() {
  const app = useApp();
  const { schools, filters, filterCtx } = app;

  // One pass over the schools computes every per-option count (each ignores its own filter).
  const counts = useMemo(() => {
    const c = { b: {} as Record<string, number>, l: {} as Record<string, number>, e: {} as Record<string, number>, d: {} as Record<string, number> };
    for (const s of schools as SchoolSummary[]) {
      if (core.matches(s, filters, filterCtx, 'boroughs')) c.b[s.borough] = (c.b[s.borough] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'levels')) for (const l of core.levelsOf(s.grades)) c.l[l] = (c.l[l] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'entry')) for (const g of s.entryGrades) c.e[g] = (c.e[g] || 0) + 1;
      if (core.matches(s, filters, filterCtx, 'districts')) c.d[String(s.district)] = (c.d[String(s.district)] || 0) + 1;
    }
    return c;
  }, [schools, filters, filterCtx]);
  const entries = useMemo(() => core.GRADES.filter((g: string) => schools.some((s: SchoolSummary) => s.entryGrades.includes(g))), [schools]);
  const districts = useMemo(() => {
    const ds = [...new Set(schools.map((s: SchoolSummary) => s.district).filter(Boolean))] as number[];
    return ds.sort((a, b) => a - b).map((d) => ({ d, borough: schools.find((s: SchoolSummary) => s.district === d)!.borough }));
  }, [schools]);

  // Search: type freely, filter after a short pause
  const applySearch = useMemo(
    () => debounce((v: string) => app.updateFilters('q', (f: any) => (f.q = v.trim().slice(0, 100))), 120),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app.updateFilters],
  );

  // Zip (SRCH-03): validate as they type, apply on 5 valid digits
  const handleZip = (v: string, { final = false } = {}) => {
    v = v.trim();
    if (!v) {
      app.setZipError('');
      if (filters.zip) app.updateFilters('zip', (f: any) => (f.zip = ''));
      return;
    }
    if (/\D/.test(v)) return app.setZipError(t('zipFormat', { z: v }));
    if (v.length < 5) {
      if (final) app.setZipError(t('zipFormat', { z: v }));
      return;
    }
    const p = core.zipProblem(v);
    if (p) return app.setZipError(t(p === 'not-nyc' ? 'zipNotNyc' : 'zipFormat', { z: v }));
    app.setZipError('');
    if (filters.zip !== v) app.updateFilters('zip', (f: any) => (f.zip = v), { fit: true });
  };

  const districtRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!app.districtOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('#district-dd')) app.setDistrictOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [app.districtOpen, app.setDistrictOpen]);

  const chip = (on: boolean, n: number) => ({ className: `chip${on ? ' is-on' : ''}`, 'aria-pressed': on, count: <span className="chip__count" aria-label={t('nSchools', { n })}>{n}</span> });

  return (
    <div className="filters">
      <label className="search" htmlFor="search">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <span className="visually-hidden">{t('searchLabel')}</span>
        <input
          id="search" type="search" autoComplete="off" maxLength={100} placeholder={t('searchPlaceholder')} value={app.searchText}
          onChange={(e) => {
            app.setSearchText(e.target.value);
            applySearch(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (app.filtered.length) (document.querySelector('#results .card__main') as HTMLElement | null)?.focus();
            }
          }}
        />
      </label>

      <form className="locate" id="locate-form" noValidate onSubmit={(e) => { e.preventDefault(); app.searchAddress((document.getElementById('address') as HTMLInputElement).value); }}>
        <div className="locate__row">
          <button type="button" className="btn btn--ghost btn--sm" id="near-me" onClick={app.nearMe}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor" /><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 1v3m0 16v3M1 12h3m16 0h3" stroke="currentColor" strokeWidth="2" /></svg>
            <span>{t('nearMe')}</span>
          </button>
          <label className="visually-hidden" htmlFor="address">{t('addressLabel')}</label>
          <input id="address" type="text" autoComplete="street-address" maxLength={120} placeholder={t('addressPlaceholder')} aria-describedby="locate-msg" />
          <button type="submit" className="btn btn--primary btn--sm" id="address-go">{t('go')}</button>
        </div>
        <p className="locate__msg" id="locate-msg" aria-live="polite" data-kind={app.locateMsg.kind}>
          {app.locateMsg.text}
          {app.locateMsg.clearable ? (
            <>
              {' '}
              <button type="button" className="link-btn" id="clear-origin" onClick={() => { (document.getElementById('address') as HTMLInputElement).value = ''; app.setOrigin(null); }}>
                {t('clearLocation')}
              </button>
            </>
          ) : null}
        </p>
      </form>

      <fieldset className="filter-group">
        <legend>{t('borough')}</legend>
        <div className="chips" id="borough-chips">
          {BOROUGHS.map((b) => {
            const c = chip(filters.boroughs.has(b.id), counts.b[b.id] || 0);
            return (
              <button key={b.id} type="button" className={c.className} data-borough={b.id} aria-pressed={c['aria-pressed']}
                onClick={() => app.updateFilters('boroughs', (f: any) => (f.boroughs.has(b.id) ? f.boroughs.delete(b.id) : f.boroughs.add(b.id)), { fit: true })}>
                <i className={`swatch swatch--${b.key}`} aria-hidden="true"></i>{boroughName(b.id)}{c.count}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="filter-group">
        <legend>{t('gradeLevel')}</legend>
        <div className="chips" id="level-chips">
          {core.LEVEL_IDS.map((l: string) => {
            const c = chip(filters.levels.has(l), counts.l[l] || 0);
            return (
              <button key={l} type="button" className={c.className} data-level={l} aria-pressed={c['aria-pressed']}
                onClick={() => app.updateFilters('levels', (f: any) => (f.levels.has(l) ? f.levels.delete(l) : f.levels.add(l)))}>
                {levelName(l)}{c.count}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="filter-grid">
        <div className="field">
          <label htmlFor="entry">{t('entryGrade')}</label>
          <select id="entry" value={filters.entry} onChange={(e) => app.updateFilters('entry', (f: any) => (f.entry = e.target.value))}>
            <option value="">{t('anyEntryGrade')}</option>
            {entries.map((g: string) => (
              <option key={g} value={g}>{`${g === 'PK' || g === '0K' ? gradeName(g) : t('gradeN', { g: gradeName(g) })} (${counts.e[g] || 0})`}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="zip">{t('zipCode')}</label>
          <input
            id="zip" type="text" inputMode="numeric" autoComplete="postal-code" maxLength={5} pattern="[0-9]{5}" placeholder={t('zipPlaceholder')}
            aria-describedby="zip-error" aria-invalid={app.zipError ? 'true' : 'false'} value={app.zipText}
            onChange={(e) => { app.setZipText(e.target.value); handleZip(e.target.value); }}
            onBlur={(e) => handleZip(e.target.value, { final: true })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleZip((e.target as HTMLInputElement).value, { final: true }); } }}
          />
        </div>
        <div className="field field--wide">
          <span className="field__label" id="district-label">{t('district')}</span>
          <details className="multi" id="district-dd" ref={districtRef} open={app.districtOpen}
            onToggle={(e) => app.setDistrictOpen((e.target as HTMLDetailsElement).open)}>
            <summary aria-describedby="district-label">
              <span id="district-summary">{filters.districts.size ? [...filters.districts].sort((a: number, b: number) => a - b).map((d: number) => t('districtShort', { d })).join(', ') : t('anyDistrict')}</span>
            </summary>
            <div className="multi__list" id="district-list" role="group" aria-labelledby="district-label">
              {districts.map(({ d, borough }) => (
                <label className="multi__opt" key={d}>
                  <input type="checkbox" value={d} checked={filters.districts.has(d)}
                    onChange={(e) => app.updateFilters('districts', (f: any) => (e.target.checked ? f.districts.add(d) : f.districts.delete(d)), { fit: true })} />{' '}
                  <span>{t('districtN', { d })} <span className="muted">· {boroughName(borough)}</span></span>
                  <span className="chip__count">{counts.d[String(d)] || 0}</span>
                </label>
              ))}
            </div>
          </details>
        </div>
        <p className="field-error field--wide" id="zip-error" role="alert" hidden={!app.zipError}>{app.zipError}</p>
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
        <label className="switch">
          <input type="checkbox" id="in-view" checked={filters.inView}
            onChange={(e) => {
              app.updateFilters('inView', (f: any) => (f.inView = e.target.checked));
              if (e.target.checked && MOBILE.matches) app.toast(t('inViewHint'));
            }} />
          <span className="switch__track" aria-hidden="true"></span><span>{t('inView')}</span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
interface CardProps {
  s: SchoolSummary; saved: boolean; compared: boolean; selected: boolean; highlight: boolean; origin: Origin | null; lng: string;
  onOpen: (id: string) => void; onSave: (id: string) => void; onCompare: (id: string, on: boolean, el: HTMLInputElement) => void;
  onHover: (id: string, on: boolean) => void;
}

const SchoolCard = memo(function SchoolCard({ s, saved, compared, selected, highlight, origin, onOpen, onSave, onCompare, onHover }: CardProps) {
  const dist = distanceText(origin, s);
  const sub = [s.neighborhood, boroughName(s.borough)].filter(Boolean).join(' · ');
  return (
    <li className={`card${selected ? ' is-selected' : ''}${highlight ? ' is-highlight' : ''}`} data-id={s.id}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('label, a, button')) onOpen(s.id); }}
      onMouseEnter={() => onHover(s.id, true)} onMouseLeave={() => onHover(s.id, false)}>
      <span className={`card__bar card__bar--${BKEY[s.borough]}`} aria-hidden="true"></span>
      <button type="button" className="card__main" data-action="open" aria-describedby={`m-${s.id}`} onClick={() => onOpen(s.id)}>
        <span className="card__name">{s.name}</span>
      </button>
      <div className="card__body" id={`m-${s.id}`}>
        <span className="card__meta">{sub}</span>
        {s.network ? <span className="card__network">{s.network}</span> : null}
        <span className="card__tags">
          <span className="tag">{t('gradesX', { g: gradeLabel(s.grades) })}</span>
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
const CHUNK = 120;

function Results() {
  const app = useApp();
  const { filtered, saved, compare, selectedId, highlightId, origin } = app as { filtered: SchoolSummary[] } & any;
  const [limit, setLimit] = useState(FIRST);
  const listRef = useRef(filtered);
  if (listRef.current !== filtered) {
    listRef.current = filtered;
    if (limit !== FIRST) setLimit(FIRST);
  }
  useEffect(() => {
    if (limit >= filtered.length) return;
    const ric: any = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 16));
    const cic: any = (window as any).cancelIdleCallback || clearTimeout;
    const h = ric(() => setLimit((n: number) => n + CHUNK), { timeout: 60 });
    return () => cic(h);
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
  const extra = [selectedId, highlightId].filter((id: string | null) => id && !shown.some((s) => s.id === id) && filtered.some((s) => s.id === id));
  const list = extra.length ? filtered.filter((s) => shown.includes(s) || extra.includes(s.id)) : shown;
  return (
    <ul className="results" id="results" tabIndex={-1} aria-label={t('resultsLabel')}>
      {list.map((s) => (
        <SchoolCard key={s.id} s={s} saved={saved.has(s.id)} compared={compare.has(s.id)} selected={s.id === selectedId} highlight={s.id === highlightId}
          origin={origin} lng={app.lang} {...handlers} />
      ))}
    </ul>
  );
}

function Empty() {
  const app = useApp();
  if (app.loadError) {
    return (
      <div className="empty" id="empty">
        <p><strong>{t('loadFailed')}</strong></p><p className="muted">{app.loadError}</p>
        <button type="button" className="btn btn--primary btn--sm" id="retry-load" onClick={() => location.reload()}>{t('retry')}</button>
      </div>
    );
  }
  if (!app.loaded || app.filtered.length) return <div className="empty" id="empty" hidden></div>;
  const f = app.filters;
  const last = app.filterOrder[app.filterOrder.length - 1];
  const lastChip = chipList(f).filter((c) => c.key === last).pop();
  return (
    <div className="empty" id="empty">
      <p><strong>{t('emptyTitle')}</strong></p>
      <p className="muted">{t('emptyBody')}</p>
      <div className="empty__actions">
        {f.zip && core.isNycZip(f.zip) ? (
          <button type="button" className="btn btn--primary btn--sm" data-empty="near-zip"
            onClick={() => { const z = f.zip; app.removeFilter('zip'); app.searchAddress(z); }}>{t('showNearZip', { z: f.zip })}</button>
        ) : null}
        {lastChip ? (
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
                onClick={() => app.removeFilter(c.key, c.value)}>
                <span>{c.label}</span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="link-btn" id="clear-all" onClick={app.clearAll}>{t('clearAll')}</button>
      </div>
      <div className="results-bar">
        <p className="results-bar__count" id="result-count" role="status" aria-live="polite" aria-atomic="true">
          {!app.loaded ? (app.loadError ? '' : t('loadingSchools')) : (
            <>
              <CountText filtered={anyFilter(app.filters)} n={n} total={total} />
              {app.sort === 'distance' && !app.origin ? <> <span className="muted">{t('setLocationForDistance')}</span></> : null}
            </>
          )}
        </p>
        <div className="results-bar__actions">
          <label className="visually-hidden" htmlFor="sort">{t('sortBy')}</label>
          <select id="sort" value={app.sort}
            onChange={(e) => {
              app.setSort(e.target.value);
              if (e.target.value === 'distance' && !app.origin) {
                app.locateError(t('setLocationForDistance'));
                document.getElementById('address')?.focus();
              }
            }}>
            <option value="name">{t('sortName')}</option>
            <option value="distance">{t('sortDistance')}</option>
            <option value="deadline">{t('sortDeadline')}</option>
          </select>
          <button className="icon-btn" id="export-csv" type="button" title={t('exportCsv')} aria-label={t('exportCsv')} onClick={exportCsv}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <Results />
      <Empty />
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

void lang;
