import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Filters, Origin, Pending, SavedItem, SchoolDetail, SchoolSummary, User, View } from './types';
import {
  anyFilter, api, chipList, cloneFilters, COMPARE_MAX, core, FilterKey, i18n, isActive, lang, localToday, MOBILE, ssGet, ssSet, t, track,
} from './lib';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { MapView, MapApi } from './MapView';
import { Detail } from './Detail';
import { MySchools } from './MySchools';
import { CompareBar, CompareDialog, SignInDialog } from './Dialogs';

export const AppCtx = createContext<any>(null);
export const useApp = () => useContext(AppCtx);

/** Keeps a ref pointing at the latest value, for callbacks used by Leaflet and timers. */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

export function App() {
  // ---- Data and session ------------------------------------------------------------------------
  const [schools, setSchools] = useState<SchoolSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [saved, setSavedMap] = useState<Map<string, SavedItem>>(new Map());
  const [share, setShare] = useState<string | null>(null);
  const [, setLangVersion] = useState(0);
  const byId = useMemo(() => new Map(schools.map((s) => [s.id, s])), [schools]);

  // ---- Explore state ---------------------------------------------------------------------------
  const [filters, setFilters] = useState<Filters>(core.emptyFilters());
  const [filterOrder, setFilterOrder] = useState<FilterKey[]>([]);
  const [sort, setSort] = useState<string>('name');
  const [origin, setOriginState] = useState<Origin | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setViewState] = useState<View>('explore');
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [compare, setCompare] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, SchoolDetail | 'error'>>(new Map());
  const [boundsVersion, setBoundsVersion] = useState(0);
  const [fitToken, setFitToken] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [locateMsg, setLocateMsg] = useState<{ text: string; kind: '' | 'error' | 'ok'; clearable?: boolean }>({ text: '', kind: '' });
  const [searchText, setSearchText] = useState('');
  const [zipText, setZipText] = useState('');
  const [zipError, setZipError] = useState('');
  const [toastState, setToastState] = useState<{ msg: string; kind: string } | null>(null);
  const [signin, setSignin] = useState<{ open: boolean; trigger: string }>({ open: false, trigger: 'header' });
  const [compareOpen, setCompareOpen] = useState(false);
  const pending = useRef<Pending>(null);
  const mapApi = useRef<MapApi | null>(null);
  const listScroll = useRef(0);

  const S = useLatest({ schools, byId, user, saved, filters, sort, origin, selectedId, view, compare, details, loaded, filterOrder });

  // ---- Toast ------------------------------------------------------------------------------------
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const toast = useCallback((msg: string, kind = 'info') => {
    setToastState({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), 3600);
  }, []);

  // ---- Filtering (SRCH-01..09, MAP-03) -----------------------------------------------------------
  const filterCtx = useMemo(
    () => ({ saved: new Set(saved.keys()), inBounds: mapApi.current ? (s: SchoolSummary) => mapApi.current!.inBounds(s) : null }),
    // boundsVersion changes when the map moves with "Only in map area" on
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved, boundsVersion, loaded],
  );
  const filterStart = useRef(performance.now());
  const filtered = useMemo(() => {
    filterStart.current = performance.now();
    const list = core.filterSchools(schools, filters, filterCtx);
    return core.sortSchools(list, sort === 'distance' && !origin ? 'name' : sort, { origin, today: localToday() }) as SchoolSummary[];
  }, [schools, filters, filterCtx, sort, origin]);
  useEffect(() => {
    (window as any).__lastFilterMs = performance.now() - filterStart.current;
  }, [filtered]);

  const noteFilter = useCallback((name: FilterKey, f: Filters) => {
    setFilterOrder((o) => {
      const next = o.filter((n) => n !== name);
      if (isActive(f, name)) next.push(name);
      return next;
    });
  }, []);

  /** Applies a change to the filters; `fit` re-frames the map on the results after the list paints. */
  const updateFilters = useCallback(
    (name: FilterKey, mutate: (f: Filters) => void, { fit = false } = {}) => {
      const f = cloneFilters(S.current.filters);
      mutate(f);
      setFilters(f);
      noteFilter(name, f);
      if (fit) setFitToken((n) => n + 1);
    },
    [noteFilter, S],
  );

  // search_performed: once the person pauses (not for map pans)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastFromMap = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (lastFromMap.current) {
      lastFromMap.current = false;
      return;
    }
    clearTimeout(searchTimer.current);
    if (!anyFilter(filters)) return;
    searchTimer.current = setTimeout(() => {
      const f = S.current.filters;
      const fx: Record<string, unknown> = {};
      if (f.boroughs.size) fx.borough = [...f.boroughs];
      if (f.levels.size) fx.level = [...f.levels];
      if (f.entry) fx.entry = f.entry;
      if (f.districts.size) fx.district = [...f.districts];
      if (f.zip) fx.zip = f.zip;
      if (f.savedOnly) fx.saved = true;
      if (f.inView) fx.inView = true;
      if (S.current.sort !== 'name') fx.sort = S.current.sort;
      track('search_performed', { query: f.q.slice(0, 100), filters: fx, result_count: filteredRef.current.length });
    }, 900);
  }, [filters, sort, loaded, S]);
  const filteredRef = useLatest(filtered);

  const onMapMoved = useCallback(() => {
    if (S.current.filters.inView) {
      lastFromMap.current = true;
      setBoundsVersion((v) => v + 1);
    }
  }, [S]);

  const removeFilter = useCallback(
    (key: FilterKey, value?: string) => {
      if (key === 'q') setSearchText('');
      if (key === 'zip') {
        setZipText('');
        setZipError('');
      }
      updateFilters(key, (f) => {
        if (key === 'q') f.q = '';
        else if (key === 'boroughs') f.boroughs.delete(value!);
        else if (key === 'levels') f.levels.delete(value!);
        else if (key === 'districts') f.districts.delete(Number(value));
        else if (key === 'entry') f.entry = '';
        else if (key === 'zip') f.zip = '';
        else if (key === 'savedOnly') f.savedOnly = false;
        else if (key === 'inView') f.inView = false;
      });
    },
    [updateFilters],
  );

  const clearAll = useCallback(() => {
    setFilters(core.emptyFilters());
    setFilterOrder([]);
    setSearchText('');
    setZipText('');
    setZipError('');
    setFitToken((n) => n + 1);
    toast(t('filtersCleared'));
  }, [toast]);

  // ---- URL state (SRCH-09); location is never written to the URL ---------------------------------
  const lastHash = useRef('');
  useEffect(() => {
    if (!loaded) return;
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.boroughs.size) p.set('borough', [...filters.boroughs].join(','));
    if (filters.levels.size) p.set('level', [...filters.levels].join(','));
    if (filters.entry) p.set('entry', filters.entry);
    if (filters.districts.size) p.set('district', [...filters.districts].sort((a, b) => a - b).join(','));
    if (filters.zip) p.set('zip', filters.zip);
    if (filters.savedOnly) p.set('saved', '1');
    if (sort !== 'name') p.set('sort', sort);
    if (selectedId) p.set('school', selectedId);
    if (view === 'my') p.set('view', 'my');
    const h = p.toString();
    lastHash.current = h;
    const target = h ? `#${h}` : `${location.pathname}${location.search}`;
    if (`#${h}` !== location.hash && !(h === '' && !location.hash)) history.replaceState(null, '', target);
  }, [filters, sort, selectedId, view, loaded]);

  const readUrl = useCallback((list: SchoolSummary[]) => {
    const raw = location.hash.slice(1);
    const p = new URLSearchParams(raw);
    const f: Filters = core.emptyFilters();
    f.q = (p.get('q') || '').slice(0, 100);
    for (const b of (p.get('borough') || '').split(',')) if (core.BOROUGHS.includes(b)) f.boroughs.add(b);
    for (const l of (p.get('level') || '').split(',')) if (core.LEVEL_IDS.includes(l)) f.levels.add(l);
    const e = p.get('entry');
    if (e && core.GRADES.includes(e)) f.entry = e;
    for (const d of (p.get('district') || '').split(',')) if (/^\d{1,2}$/.test(d) && list.some((s) => s.district === Number(d))) f.districts.add(Number(d));
    const z = p.get('zip');
    if (z && core.isNycZip(z)) f.zip = z;
    f.savedOnly = p.get('saved') === '1';
    setFilters(f);
    setFilterOrder((['q', 'boroughs', 'levels', 'entry', 'districts', 'zip', 'savedOnly'] as FilterKey[]).filter((k) => isActive(f, k)));
    const sortP = p.get('sort');
    setSort(core.SORTS.includes(sortP) ? (sortP as string) : 'name');
    setSearchText(f.q);
    setZipText(f.zip);
    return { school: p.get('school'), view: p.get('view'), signin: raw === 'signin' };
  }, []);

  // ---- Saved schools (FAV-01/02) ------------------------------------------------------------------
  const setSaved = useCallback((list: { schoolId: string; status: string; note: string; updatedAt?: string }[]) => {
    setSavedMap(new Map(list.map((r) => [r.schoolId, { status: r.status, note: r.note, updatedAt: r.updatedAt }])));
  }, []);

  const openSignIn = useCallback((trigger: string) => {
    track('login_prompted', { trigger });
    setSignin({ open: true, trigger });
  }, []);

  const toggleSave = useCallback(
    async (id: string, source: string) => {
      if (!S.current.user) {
        pending.current = { type: 'save', id, source };
        ssSet('ncs_pending', JSON.stringify(pending.current));
        openSignIn('save');
        return;
      }
      const was = S.current.saved.has(id);
      setSavedMap((m) => {
        const n = new Map(m);
        if (was) n.delete(id);
        else n.set(id, { status: 'researching', note: '' });
        return n;
      });
      try {
        const r = await api(`/api/saved/${encodeURIComponent(id)}`, { method: was ? 'DELETE' : 'PUT', body: { source } });
        setSaved(r.saved);
        toast(was ? t('removedToast') : t('savedToast'));
      } catch (e: any) {
        if (e.status === 401) {
          setUser(null);
          pending.current = { type: 'save', id, source };
          openSignIn('save');
        } else toast(e.message, 'error');
        setSavedMap((m) => {
          const n = new Map(m);
          if (was) n.set(id, { status: 'researching', note: '' });
          else n.delete(id);
          return n;
        });
      }
    },
    [S, openSignIn, setSaved, toast],
  );

  const updateTracker = useCallback(
    async (id: string, patch: { status?: string; note?: string }) => {
      const r = await api(`/api/saved/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
      setSaved(r.saved);
      toast(patch.status ? t('statusSaved', { s: t(`status_${patch.status}`) }) : t('noteSaved'));
      return r;
    },
    [setSaved, toast],
  );

  // ---- Detail (DET-01..05) ------------------------------------------------------------------------
  const getDetail = useCallback(async (id: string): Promise<SchoolDetail> => {
    const cached = S.current.details.get(id);
    if (cached && cached !== 'error') return cached;
    const { school } = await api<{ school: SchoolDetail }>(`/api/schools/${encodeURIComponent(id)}`);
    setDetails((m) => new Map(m).set(id, school));
    return school;
  }, [S]);

  const showExplore = useCallback(({ silent = false } = {}) => {
    setViewState('explore');
    setTimeout(() => mapApi.current?.invalidate(), 30);
    void silent;
  }, []);

  const openDetail = useCallback(
    async (id: string, { source = 'list', fly = true, track: doTrack = true } = {}) => {
      const s = S.current.byId.get(id);
      if (!s) return;
      if (S.current.view !== 'explore') showExplore({ silent: true });
      if (!S.current.selectedId) listScroll.current = document.getElementById('sidebar')?.scrollTop || 0;
      setSelectedId(id);
      if (fly) mapApi.current?.flyToSchool(s);
      if (doTrack) track('school_viewed', { school_id: id, source });
      try {
        await getDetail(id);
      } catch {
        setDetails((m) => new Map(m).set(id, 'error'));
      }
    },
    [S, getDetail, showExplore],
  );

  const closeDetail = useCallback(() => {
    const prev = S.current.selectedId;
    setSelectedId(null);
    requestAnimationFrame(() => {
      const sb = document.getElementById('sidebar');
      if (sb) sb.scrollTop = listScroll.current;
      if (prev) (document.querySelector(`#results .card[data-id="${CSS.escape(prev)}"] .card__main`) as HTMLElement | null)?.focus({ preventScroll: true });
    });
  }, [S]);

  const retryDetail = useCallback((id: string) => {
    setDetails((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    openDetail(id, { track: false, fly: false });
  }, [openDetail]);

  // ---- Views -----------------------------------------------------------------------------------
  const showMy = useCallback(() => {
    if (!S.current.user) {
      pending.current = { type: 'my' };
      ssSet('ncs_pending', JSON.stringify(pending.current));
      openSignIn('my_schools');
      return;
    }
    setViewState('my');
    window.scrollTo(0, 0);
    requestAnimationFrame(() => document.getElementById('my-view')?.focus({ preventScroll: true }));
    api('/api/share')
      .then((r) => setShare(r.token ? `${location.origin}${r.path}` : null))
      .catch(() => {});
  }, [S, openSignIn]);

  // ---- Sign-in (AUTH-01..03) ----------------------------------------------------------------------
  const afterSignIn = useCallback(
    async (u: User) => {
      setUser(u);
      setSignin((s) => ({ ...s, open: false }));
      let list: { schoolId: string; status: string; note: string }[] = [];
      try {
        list = (await api('/api/saved')).saved;
        setSaved(list);
      } catch {
        /* shown on next action */
      }
      const p: Pending = pending.current || JSON.parse(ssGet('ncs_pending') || 'null');
      pending.current = null;
      ssSet('ncs_pending', null);
      toast(t('signedInAs', { n: u.name }));
      S.current.user = u; // so the follow-up save below sees the signed-in user
      S.current.saved = new Map(list.map((r) => [r.schoolId, { status: r.status, note: r.note }]));
      if (p && p.type === 'save' && S.current.byId.has(p.id)) {
        // Back to the same school, then finish the save (AUTH-03)
        if (S.current.selectedId !== p.id && p.source !== 'list' && p.source !== 'pin') await openDetail(p.id, { source: 'link', fly: false, track: false });
        if (!S.current.saved.has(p.id)) await toggleSave(p.id, p.source || 'detail');
      } else if (p && p.type === 'my') {
        setTimeout(showMy, 0);
      }
    },
    [S, openDetail, setSaved, showMy, toast, toggleSave],
  );

  const onSigninClosed = useCallback(() => {
    setSignin((s) => ({ ...s, open: false }));
    if (!S.current.user) {
      pending.current = null;
      ssSet('ncs_pending', null);
    }
  }, [S]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* ignore */
    }
    setUser(null);
    setSavedMap(new Map());
    setShare(null);
    if (S.current.view === 'my') showExplore();
    toast(t('signedOut'));
  }, [S, showExplore, toast]);

  // ---- Account deletion (privacy policy) -----------------------------------------------------------
  const deleteAccount = useCallback(async () => {
    try {
      await api('/api/me', { method: 'DELETE', body: {} });
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
    setUser(null);
    setSavedMap(new Map());
    setShare(null);
    setCompare(new Set());
    showExplore();
    toast(t('accountDeleted'));
    return true;
  }, [showExplore, toast]);

  // ---- Compare (CMP-01) ----------------------------------------------------------------------------
  const toggleCompare = useCallback(
    (id: string, checked: boolean) => {
      const cur = S.current.compare;
      if (checked && !cur.has(id) && cur.size >= COMPARE_MAX) {
        toast(t('compareMax', { n: COMPARE_MAX }), 'error');
        return false;
      }
      const n = new Set(cur);
      if (checked) n.add(id);
      else n.delete(id);
      setCompare(n);
      return true;
    },
    [S, toast],
  );

  // ---- Location (MAP-04) ----------------------------------------------------------------------------
  const setOrigin = useCallback(
    (o: Origin | null, { announce = true } = {}) => {
      setOriginState(o);
      mapApi.current?.setOrigin(o);
      if (o) {
        setSort('distance');
        setLocateMsg({ text: t('distancesFrom', { p: o.label }), kind: 'ok', clearable: true });
        if (announce) toast(t('sortedByDistance'));
      } else {
        setLocateMsg({ text: '', kind: '' });
        setSort((s) => (s === 'distance' ? 'name' : s));
      }
    },
    [toast],
  );

  const locateError = useCallback((msg: string) => setLocateMsg({ text: msg, kind: 'error' }), []);

  const nearMe = useCallback(() => {
    if (!navigator.geolocation) return locateError(t('geoUnsupported'));
    setLocateMsg({ text: t('locating'), kind: '' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        if (lat < 40.3 || lat > 41.1 || lng < -74.6 || lng > -73.4) {
          locateError(t('outsideNyc'));
          document.getElementById('address')?.focus();
          return;
        }
        setOrigin({ lat, lng, label: t('yourLocation') });
      },
      (err) => {
        locateError(err.code === 1 ? t('geoDenied') : t('geoFailed'));
        document.getElementById('address')?.focus();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }, [locateError, setOrigin]);

  const searchAddress = useCallback(
    async (q: string) => {
      q = q.trim();
      if (q.length < 3) return locateError(t('addressTooShort'));
      if (/^\d{5}$/.test(q)) {
        const p = core.zipProblem(q);
        if (p) return locateError(t(p === 'not-nyc' ? 'zipNotNyc' : 'zipFormat', { z: q }));
      }
      setLocateMsg({ text: t('searching'), kind: '' });
      try {
        const { result } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        setOrigin({ lat: result.lat, lng: result.lng, label: result.kind === 'zip' ? t('zipChip', { z: q }) : result.label });
      } catch (e: any) {
        locateError(e.message);
      }
    },
    [locateError, setOrigin],
  );

  // ---- Language (I18N-01) ------------------------------------------------------------------------------
  const toggleLang = useCallback(() => {
    i18n.setLang(lang() === 'es' ? 'en' : 'es');
    document.documentElement.lang = lang();
    document.title = t('appName');
    setLangVersion((v) => v + 1);
    setLocateMsg((m) => (S.current.origin && m.clearable ? { ...m, text: t('distancesFrom', { p: S.current.origin.label }) } : m));
  }, [S]);

  // ---- Body classes the stylesheet keys on ----------------------------------------------------------------
  useLayoutEffect(() => {
    const b = document.body;
    b.classList.toggle('view-my', view === 'my');
    b.classList.toggle('view-map', mobileView === 'map');
    b.classList.toggle('view-list', mobileView !== 'map');
    b.classList.toggle('has-detail', !!selectedId);
  }, [view, mobileView, selectedId]);
  useEffect(() => {
    const onChange = () => setTimeout(() => mapApi.current?.invalidate(), 60);
    MOBILE.addEventListener('change', onChange);
    return () => MOBILE.removeEventListener('change', onChange);
  }, []);
  const setMobile = useCallback((v: 'list' | 'map') => {
    setMobileView(v);
    setTimeout(() => mapApi.current?.invalidate(), 60);
  }, []);

  // ---- Keyboard shortcuts, back/forward ---------------------------------------------------------------------
  const [menuOpen, setMenuOpen] = useState(false);
  const [districtOpen, setDistrictOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement as HTMLElement | null)?.tagName || '');
      if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
        e.preventDefault();
        if (S.current.view !== 'explore') showExplore();
        document.getElementById('search')?.focus();
      } else if (e.key === 'Escape') {
        if (document.querySelector('dialog[open]')) return;
        if (menuOpenRef.current) setMenuOpen(false);
        else if (districtOpenRef.current) setDistrictOpen(false);
        else if (S.current.selectedId && S.current.view === 'explore') closeDetail();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [S, closeDetail, showExplore]);
  const menuOpenRef = useLatest(menuOpen);
  const districtOpenRef = useLatest(districtOpen);

  useEffect(() => {
    const onHash = () => {
      if (location.hash.slice(1) === lastHash.current) return;
      const st = readUrl(S.current.schools);
      if (st.school && S.current.byId.has(st.school)) openDetail(st.school, { source: 'link' });
      else if (S.current.selectedId) closeDetail();
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [S, closeDetail, openDetail, readUrl]);

  // ---- Boot ---------------------------------------------------------------------------------------------
  useEffect(() => {
    document.documentElement.lang = lang();
    document.title = t('appName');
    (async () => {
      let data: { schools: SchoolSummary[] };
      let me: { user: User | null };
      try {
        [data, me] = await Promise.all([api('/api/schools'), api('/api/me').catch(() => ({ user: null }))]);
      } catch (e: any) {
        setLoadError(e.message);
        return;
      }
      const map = new Map(data.schools.map((s) => [s.id, s]));
      S.current.byId = map;
      S.current.schools = data.schools;
      setSchools(data.schools);
      setUser(me.user);
      S.current.user = me.user;
      if (me.user) {
        try {
          const list = (await api('/api/saved')).saved;
          setSaved(list);
        } catch {
          /* non-fatal */
        }
      }
      const st = readUrl(data.schools);
      setLoaded(true);
      bootRoute.current = st;
    })();
  }, [S, readUrl, setSaved]);
  const bootRoute = useRef<{ school: string | null; view: string | null; signin: boolean } | null>(null);
  useEffect(() => {
    if (!loaded || !bootRoute.current) return;
    const st = bootRoute.current;
    bootRoute.current = null;
    if (st.school && byId.has(st.school)) openDetail(st.school, { source: 'link' });
    else setFitToken((n) => n + 1);
    if (st.view === 'my') showMy();
    if (st.signin && !S.current.user) openSignIn('header');
    // Read-only hook used by the automated eval harness (no personal data).
    const w = window as any;
    w.NCS = w.NCS || {};
    w.NCS.inspect = () => {
      const m = mapApi.current;
      return {
        filtered: filteredRef.current.map((x) => x.id),
        selected: S.current.selectedId,
        origin: !!S.current.origin,
        zoom: m ? m.map.getZoom() : null,
        center: m ? m.map.getCenter() : null,
        markers: m ? m.visibleMarkers() : [],
        clusters: m ? m.clusterSizes() : [],
        lastFilterMs: w.__lastFilterMs,
        baseLayer: m ? m.baseLayer : null,
        streets: m && m.streetLayer ? m.streetLayer.ncsStats : null,
        ui: 'react',
      };
    };
    w.NCS.streetLayer = mapApi.current?.streetLayer || null;
    w.NCS.flyTo = (lat: number, lng: number, z: number) => {
      mapApi.current?.map.setView([lat, lng], z, { animate: false });
    };
    requestAnimationFrame(() => {
      w.__readyAt = performance.now();
      w.__ready = true;
      document.body.dataset.ready = 'true';
    });
  }, [loaded, byId, openDetail, showMy, openSignIn, S, filteredRef]);

  const app = {
    schools, byId, loaded, loadError, user, saved, share, setShare, filters, filterOrder, sort, setSort, origin, selectedId, view,
    compare, details, filtered, highlightId, setHighlightId, locateMsg, setLocateMsg, searchText, setSearchText, zipText, setZipText,
    zipError, setZipError, signin, compareOpen, setCompareOpen, mobileView, fitToken, menuOpen, setMenuOpen, districtOpen, setDistrictOpen,
    mapApi, filterCtx, toast, updateFilters, removeFilter, clearAll, toggleSave, updateTracker, openDetail, closeDetail, retryDetail,
    showMy, showExplore, openSignIn, afterSignIn, onSigninClosed, signOut, toggleCompare, setCompare, deleteAccount, setOrigin, nearMe, searchAddress,
    locateError, toggleLang, setMobile, getDetail, onMapMoved, chipList: () => chipList(filters), lang: lang(),
  };

  return (
    <AppCtx.Provider value={app}>
      <a className="skip-link" href="#results">{t('skipToResults')}</a>
      <TopBar />
      <div className="banner" id="banner" role="status" hidden></div>
      <main className="layout" id="explore" hidden={view !== 'explore'}>
        <Sidebar />
        <section className="map-wrap" aria-label={t('mapLabel')}>
          <MapView />
        </section>
        <Detail />
      </main>
      <MySchools />
      <CompareBar />
      <SignInDialog />
      <CompareDialog />
      <nav className="view-switch" aria-label={t('switchView')}>
        {(['list', 'map'] as const).map((v) => (
          <button key={v} type="button" data-view={v} className={mobileView === v ? 'is-active' : undefined} aria-pressed={mobileView === v} onClick={() => setMobile(v)}>
            {t(v)}
          </button>
        ))}
      </nav>
      <div className="toast" id="toast" role="status" aria-live="polite" hidden={!toastState} data-kind={toastState?.kind || 'info'}>
        {toastState?.msg}
      </div>
    </AppCtx.Provider>
  );
}
