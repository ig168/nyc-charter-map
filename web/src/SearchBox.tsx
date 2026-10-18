import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './App';
import type { SchoolSummary } from './types';
import { addRecent, boroughName, clearRecent, core, debounce, fmtNum, getRecent, gradeLabel, gradeName, levelName, MOBILE, Recent, t } from './lib';

// One smart box (search upgrade SX-06, SX-09, SX-14): names, networks, neighborhoods, zip codes and
// addresses, with a short grouped suggestion list built on the W3C APG combobox pattern.

type Option =
  | { kind: 'location' }
  | { kind: 'zip'; zip: string; count: number }
  | { kind: 'address'; query: string }
  | { kind: 'phrase'; label: string }
  | { kind: 'school'; s: SchoolSummary }
  | { kind: 'network'; name: string; count: number }
  | { kind: 'place'; name: string; count: number }
  | { kind: 'zipOnly'; zip: string; count: number }
  | { kind: 'recent'; r: Recent }
  | { kind: 'shortcut'; label: string; apply: () => void };

interface Group { id: string; label: string; options: Option[] }

const Icon = ({ k }: { k: string }) => {
  const paths: Record<string, React.ReactNode> = {
    location: <><circle cx="12" cy="12" r="3.4" fill="currentColor" /><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" /></>,
    pin: <path d="M12 2.5c-3.6 0-6.5 2.8-6.5 6.4 0 4.8 6.5 12.6 6.5 12.6s6.5-7.8 6.5-12.6c0-3.6-2.9-6.4-6.5-6.4zm0 8.9a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor" />,
    school: <path d="M12 3 2 8l10 5 8-4v6h2V8L12 3zm-6 9.2V16c0 1.9 2.7 3.5 6 3.5s6-1.6 6-3.5v-3.8l-6 3-6-3z" fill="currentColor" />,
    network: <path d="M5 4h6v6H5V4zm8 0h6v6h-6V4zM5 14h6v6H5v-6zm8 0h6v6h-6v-6z" fill="currentColor" />,
    recent: <><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
    spark: <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" fill="currentColor" />,
  };
  return <svg className="sugg__icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">{paths[k]}</svg>;
};

/** Name with the matched words marked (SX-04). */
export function Marked({ name, q }: { name: string; q: string }) {
  const app = useApp();
  if (!q) return <>{name}</>;
  const segs = app.search.highlight(name, q) as { text: string; mark: boolean }[];
  return <>{segs.map((x, i) => (x.mark ? <mark key={i}>{x.text}</mark> : <React.Fragment key={i}>{x.text}</React.Fragment>))}</>;
}

export function SearchBox() {
  const app = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recentVer, setRecentVer] = useState(0);
  const text: string = app.searchText;
  const limit = MOBILE.matches ? 6 : 8;

  const applySearch = useMemo(
    () => debounce((v: string) => app.updateFilters('q', (f: any) => (f.q = v.trim().slice(0, 100))), 120),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app.updateFilters],
  );

  const setText = (v: string, { apply = true } = {}) => {
    app.setSearchText(v);
    if (apply) applySearch(v);
  };
  const clearText = () => {
    app.setSearchText('');
    app.updateFilters('q', (f: any) => (f.q = ''));
  };

  // ---- Build the suggestion groups ------------------------------------------------------------
  const sugg = useMemo(() => (text.trim() ? app.search.suggest(text, { limit }) : null), [text, app.search, limit]);
  const groups: Group[] = useMemo(() => {
    const g: Group[] = [];
    if (!text.trim()) {
      const recents = getRecent().slice(0, 3);
      g.push({ id: 'g-loc', label: t('suggLocation'), options: [{ kind: 'location' }] });
      if (recents.length) g.push({ id: 'g-recent', label: t('suggRecent'), options: recents.map((r) => ({ kind: 'recent', r })) });
      g.push({
        id: 'g-short', label: t('suggTry'), options: [
          { kind: 'shortcut', label: t('shortcutK'), apply: () => app.updateFilters('entry', (f: any) => (f.entry = '0K')) },
          { kind: 'shortcut', label: t('shortcutMiddle'), apply: () => app.updateFilters('levels', (f: any) => f.levels.add('middle')) },
          { kind: 'shortcut', label: t('shortcutHigh'), apply: () => app.updateFilters('levels', (f: any) => f.levels.add('high')) },
        ],
      });
      return g;
    }
    if (!sugg) return g;
    const p = sugg.parsed;
    const loc: Option[] = [];
    for (const l of sugg.location) {
      if (l.type === 'zip') loc.push({ kind: 'zip', zip: l.query, count: l.count });
      if (l.type === 'address') loc.push({ kind: 'address', query: l.query });
    }
    // "kindergarten in Bushwick" → offer it as filters (SX-14)
    const structure = [p.entry ? t('entryChip', { g: gradeName(p.entry) }) : null, ...[...p.levels].map((l: string) => levelName(l)), ...p.places.map((x: any) => x.label)].filter(Boolean);
    if ((p.entry || p.levels.size) && structure.length && !p.address) loc.unshift({ kind: 'phrase', label: structure.join(' · ') });
    if (loc.length) g.push({ id: 'g-loc', label: t('suggSearchFor'), options: loc });
    if (sugg.schools.length) g.push({ id: 'g-schools', label: t('suggSchools'), options: sugg.schools.map((s: SchoolSummary) => ({ kind: 'school', s })) });
    if (sugg.networks.length) g.push({ id: 'g-networks', label: t('suggNetworks'), options: sugg.networks.map((n: any) => ({ kind: 'network', name: n.name, count: n.count })) });
    const places: Option[] = sugg.places.map((x: any) => (x.type === 'zipOnly' ? { kind: 'zipOnly', zip: x.name, count: x.count } : { kind: 'place', name: x.name, count: x.count }));
    if (places.length) g.push({ id: 'g-places', label: t('suggPlaces'), options: places });
    // keep within the row limit (location rows first)
    let room = limit;
    for (const grp of g) {
      grp.options = grp.options.slice(0, Math.max(0, room));
      room -= grp.options.length;
    }
    return g.filter((grp) => grp.options.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sugg, text, limit, recentVer, app.lang]);
  const flat = groups.flatMap((g) => g.options);
  const note = sugg?.note === 'psNumber' ? t('psNote') : sugg?.note === 'notNycZip' ? t('zipNotNyc', { z: sugg.parsed.zip }) : '';

  useEffect(() => setActive(-1), [text]);

  // ---- Choosing an option ---------------------------------------------------------------------
  const done = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (o: Option) => {
    switch (o.kind) {
      case 'location':
        app.nearMe();
        break;
      case 'zip':
        clearText();
        app.searchAddress(o.zip);
        break;
      case 'address':
        clearText();
        app.searchAddress(o.query);
        break;
      case 'phrase': {
        const p = app.search.parse(text);
        const rest = p.groups.filter((g: any) => !p.places.some((pl: any) => pl.key === g.typed)).map((g: any) => g.typed).join(' ');
        app.updateFilters('entry', (f: any) => {
          if (p.entry) f.entry = p.entry;
          for (const l of p.levels) f.levels.add(l);
          for (const pl of p.places) f.places.add(pl.label);
          f.q = rest;
        }, { fit: true });
        app.setSearchText(rest);
        break;
      }
      case 'school':
        addRecent({ type: 'school', label: o.s.name, value: o.s.id });
        app.openDetail(o.s.id, { source: 'search' });
        break;
      case 'network':
        addRecent({ type: 'network', label: o.name, value: o.name });
        app.updateFilters('networks', (f: any) => {
          f.networks.add(o.name);
          f.q = '';
        }, { fit: true });
        app.setSearchText('');
        break;
      case 'place':
        addRecent({ type: 'place', label: o.name, value: o.name });
        app.updateFilters('places', (f: any) => {
          f.places.add(o.name);
          f.q = '';
        }, { fit: true });
        app.setSearchText('');
        break;
      case 'zipOnly':
        app.updateFilters('zip', (f: any) => {
          f.zip = o.zip;
          f.q = '';
        }, { fit: true });
        app.setSearchText('');
        break;
      case 'recent': {
        const r = o.r;
        if (r.type === 'school') {
          if (app.byId.has(r.value)) app.openDetail(r.value, { source: 'search' });
        } else if (r.type === 'network') app.updateFilters('networks', (f: any) => f.networks.add(r.value), { fit: true });
        else if (r.type === 'place') app.updateFilters('places', (f: any) => f.places.add(r.value), { fit: true });
        else setText(r.value);
        break;
      }
      case 'shortcut':
        o.apply();
        break;
    }
    done();
  };

  const remember = () => {
    const v = text.trim();
    if (v.length >= 2 && app.filtered.length) addRecent({ type: 'text', label: v, value: v });
    setRecentVer((n) => n + 1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) setOpen(true);
      if (!flat.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i < 0 ? (d > 0 ? 0 : flat.length - 1) : (i + d + flat.length) % flat.length)); // wraps
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && active >= 0 && flat[active]) return choose(flat[active]);
      // Enter on a zip/address = search that location; on a phrase = keep it as filters
      const loc = flat.find((o) => o.kind === 'zip' || o.kind === 'address' || o.kind === 'phrase');
      if (loc) return choose(loc);
      remember();
      done();
      if (app.filtered.length) (document.querySelector('#results .card__main') as HTMLElement | null)?.focus();
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        done();
      } else if (text) {
        e.preventDefault();
        clearText();
      }
    } else if (e.key === 'Tab') done();
  };

  // close when focus/click leaves the box
  useEffect(() => {
    if (!open) return;
    const close = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement).closest('.searchbox')) done();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const optId = (i: number) => `sugg-${i}`;
  const expanded = open && (flat.length > 0 || !!note);
  const parsedStructure = useMemo(() => {
    if (!app.rank) return '';
    const p = app.rank.parsed;
    const bits = [p.entry ? t('entryChip', { g: gradeName(p.entry) }) : '', ...[...p.levels].map((l: string) => levelName(l))].filter(Boolean);
    return bits.length ? bits.join(' · ') : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.rank, app.lang]);

  let idx = -1;
  const row = (o: Option) => {
    idx += 1;
    const i = idx;
    let icon = 'school', main: React.ReactNode = '', sub: React.ReactNode = '', type: string = o.kind;
    switch (o.kind) {
      case 'location': icon = 'location'; main = t('useMyLocation'); sub = t('useMyLocationSub'); break;
      case 'zip': icon = 'pin'; main = t('schoolsNearX', { p: o.zip }); sub = t('sortedByDistanceShort'); break;
      case 'address': icon = 'pin'; main = t('searchThisAddress'); sub = o.query; break;
      case 'phrase': icon = 'spark'; main = t('applyAsFilters'); sub = o.label; break;
      case 'school':
        main = <Marked name={o.s.name} q={text} />;
        sub = [o.s.neighborhood, boroughName(o.s.borough), gradeLabel(o.s.grades)].filter(Boolean).join(' · ');
        break;
      case 'network': icon = 'network'; main = <Marked name={o.name} q={text} />; sub = t('nCampuses', { n: fmtNum(o.count) }); break;
      case 'place': icon = 'pin'; main = <Marked name={o.name} q={text} />; sub = t('nSchoolsInPlace', { n: fmtNum(o.count) }); break;
      case 'zipOnly': icon = 'pin'; main = t('onlyZipX', { z: o.zip }); sub = t('nSchoolsInPlace', { n: fmtNum(o.count) }); break;
      case 'recent': icon = 'recent'; main = o.r.label; sub = t(`recent_${o.r.type}`); break;
      case 'shortcut': icon = 'spark'; main = o.label; break;
    }
    return (
      <li key={i} id={optId(i)} role="option" aria-selected={active === i} className={`sugg${active === i ? ' is-active' : ''}`} data-type={type}
        onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)} onMouseMove={() => active !== i && setActive(i)}>
        <Icon k={icon} />
        <span className="sugg__text"><span className="sugg__main">{main}</span>{sub ? <span className="sugg__sub">{sub}</span> : null}</span>
      </li>
    );
  };

  return (
    <div className="searchbox">
      <div className={`search${expanded ? ' is-open' : ''}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <label className="visually-hidden" htmlFor="search" id="search-label">{t('searchLabel')}</label>
        <input
          id="search" ref={inputRef} type="text" inputMode="search" enterKeyHint="search" autoComplete="off" autoCapitalize="off" spellCheck={false}
          maxLength={100} placeholder={t('searchPlaceholder')} value={text}
          role="combobox" aria-expanded={expanded} aria-controls="search-listbox" aria-autocomplete="list" aria-haspopup="listbox"
          aria-activedescendant={expanded && active >= 0 ? optId(active) : undefined} aria-describedby="search-hint"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setTimeout(() => {
            if (!document.activeElement?.closest('.searchbox')) {
              remember();
              setOpen(false);
            }
          }, 120)}
          onKeyDown={onKey}
        />
        {text ? (
          <button type="button" className="search__clear" aria-label={t('clearSearch')} onClick={() => { clearText(); inputRef.current?.focus(); }}>
            <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        ) : null}
        <button type="button" className="search__loc" id="near-me" title={t('useMyLocation')} aria-label={t('useMyLocation')} onClick={() => { done(); app.nearMe(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor" /><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 1v3m0 16v3M1 12h3m16 0h3" stroke="currentColor" strokeWidth="2" /></svg>
        </button>
      </div>
      <p className="visually-hidden" id="search-hint">{t('searchHint')}</p>
      <div className="sugg-pop" hidden={!expanded}>
        {note ? <p className="sugg-note" role="note">{note}</p> : null}
        <ul className="sugg-list" id="search-listbox" role="listbox" aria-label={t('suggestions')}>
          {groups.map((g) => (
            <li key={g.id} role="presentation" className="sugg-group">
              <span className="sugg-group__label" id={g.id} aria-hidden="true">{g.label}</span>
              <ul role="group" aria-labelledby={g.id}>{g.options.map(row)}</ul>
            </li>
          ))}
        </ul>
        {!text.trim() && getRecent().length ? (
          <button type="button" className="link-btn sugg-clear-recent" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearRecent(); setRecentVer((n) => n + 1); }}>{t('clearRecent')}</button>
        ) : null}
      </div>
      <p className="visually-hidden" aria-live="polite" id="sugg-status">{expanded && text.trim() ? t('nSuggestions', { n: flat.length }) : ''}</p>
      {parsedStructure ? (
        <p className="search-parsed" id="search-parsed">
          {t('searchingFor')} <strong>{parsedStructure}</strong>{' '}
          <button type="button" className="link-btn" onClick={() => choose({ kind: 'phrase', label: parsedStructure })}>{t('keepAsFilters')}</button>
        </p>
      ) : null}
    </div>
  );
}

void core;
