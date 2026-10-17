import React, { useEffect, useRef, useState } from 'react';
import { useApp } from './App';
import type { Origin, SchoolSummary } from './types';
import { BKEY, BOROUGHS, boroughName, clusterLib, core, debounce, esc, fmtNum, gradeLabel, lang, NYC_CENTER, t } from './lib';

declare global {
  interface Window {
    L?: any;
    NCS_BASEMAP?: unknown;
    NCS_STREETS?: unknown;
    NCSStreets?: { createLayer: (L: any, data: unknown) => any };
  }
}

/** What the rest of the app can ask of the map. */
export interface MapApi {
  map: any;
  baseLayer: 'streets' | 'outline' | 'tiles';
  streetLayer: any;
  inBounds(s: { lat: number; lng: number }): boolean;
  flyToSchool(s: SchoolSummary, zoom?: number): void;
  openPinCard(id: string): void;
  invalidate(): void;
  setOrigin(o: Origin | null): void;
  hover(id: string, on: boolean): void;
  visibleMarkers(): { id: string; lat: number; lng: number }[];
  clusterSizes(): number[];
}

// Free, keyless map sources: OpenStreetMap's standard tiles, and Esri imagery + reference labels for satellite.
const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const ESRI_REF = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference';
const THUMB: Record<string, string> = {
  map: 'https://tile.openstreetmap.org/12/1206/1538.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1538/1206',
};
const PIN_SVG =
  '<svg viewBox="0 0 26 38" width="26" height="38" aria-hidden="true"><path class="pin__body" d="M13 1C6.4 1 1 6.3 1 12.9c0 8.6 10.2 22.3 11.2 23.6a1 1 0 0 0 1.6 0C14.8 35.2 25 21.5 25 12.9 25 6.3 19.6 1 13 1z"/><circle class="pin__dot" cx="13" cy="13" r="4.6"/></svg>';

export function MapView() {
  const app = useApp();
  const el = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<{ text: string; kind: string }>({ text: '', kind: '' });
  // Leaflet lives outside React; this ref always holds the latest app state for its callbacks.
  const A = useRef(app);
  A.current = app;
  const M = useRef<any>(null); // { map, markerLayer, markers, ... }

  // ---- Create the map once -------------------------------------------------------------------
  useEffect(() => {
    const L = window.L;
    if (!L || !el.current) {
      document.body.classList.add('no-map');
      setNotice({ text: t('mapUnavailable'), kind: 'nomap' });
      return;
    }
    const map = L.map(el.current, { zoomControl: false, minZoom: 9, maxBounds: [[40.3, -74.6], [41.1, -73.4]] }).setView(NYC_CENTER, 11);
    const st: any = { map, markers: new Map(), openPopupId: null, originMarker: null, streetLayer: null, baseLayer: 'tiles', paintType: null, tilesOk: false };
    M.current = st;

    // Bottom-corner controls stack upward in the order added: scale, zoom, then locate on top
    L.control.scale({ position: 'bottomright', imperial: true, metric: false, maxWidth: 90 }).addTo(map);
    st.zoomCtl = L.control.zoom({ position: 'bottomright', zoomInTitle: t('zoomIn'), zoomOutTitle: t('zoomOut') }).addTo(map);
    const Locate = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const b = L.DomUtil.create('button', 'gm-ctl gm-locate');
        b.type = 'button';
        b.id = 'map-locate';
        b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="3.6" fill="currentColor"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v3.2M12 19.3v3.2M1.5 12h3.2M19.3 12h3.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => A.current.nearMe());
        return b;
      },
    });
    new Locate().addTo(map);

    if (window.NCS_BASEMAP) {
      // Hosts that block map tiles (the hosted demo) get a base map drawn in the browser from NYC Open Data.
      map.getContainer().classList.add('map--vector');
      if (window.NCSStreets && window.NCS_STREETS) {
        st.streetLayer = window.NCSStreets.createLayer(L, window.NCS_STREETS).addTo(map);
        st.baseLayer = 'streets';
      } else {
        L.geoJSON(window.NCS_BASEMAP, { interactive: false, style: () => ({ color: '#c3c8cf', weight: 1.2, fillColor: '#f8f7f3', fillOpacity: 1 }) }).addTo(map);
        map.attributionControl.addAttribution('Borough outlines: <a href="https://github.com/codeforgermany/click_that_hood" target="_blank" rel="noopener">click_that_hood</a>');
        st.baseLayer = 'outline';
      }
    } else {
      const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM });
      // Satellite = Esri World Imagery with street and place labels on top (like Google's hybrid view)
      const satellite = L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
        }),
        L.tileLayer(`${ESRI_REF}/World_Transportation/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 18 }),
        L.tileLayer(`${ESRI_REF}/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, maxNativeZoom: 18 }),
      ]);
      let tileErrors = 0;
      const watch = (layer: any) => {
        layer.on('tileload', () => {
          st.tilesOk = true;
          setNotice((n) => (n.kind === 'tiles' ? { text: '', kind: '' } : n));
        });
        layer.on('tileerror', () => {
          tileErrors += 1;
          if (!st.tilesOk && tileErrors >= 3) setNotice({ text: t('tilesFailed'), kind: 'tiles' });
        });
      };
      watch(streets);
      satellite.eachLayer(watch);

      let mapType = 'map';
      try {
        if (localStorage.getItem('ncs_maptype') === 'satellite') mapType = 'satellite';
      } catch {
        /* storage blocked */
      }
      (mapType === 'satellite' ? satellite : streets).addTo(map);

      // Google-style map type switch: a thumbnail of the other view, bottom left
      const MapType = L.Control.extend({
        options: { position: 'bottomleft' },
        onAdd() {
          const b = L.DomUtil.create('button', 'gm-ctl gm-maptype');
          b.type = 'button';
          b.id = 'map-type';
          const paint = () => {
            const other = mapType === 'map' ? 'satellite' : 'map';
            const label = t(other === 'map' ? 'mapTypeMap' : 'mapTypeSatellite');
            b.style.backgroundImage = `url("${THUMB[other]}")`;
            b.dataset.view = other;
            b.setAttribute('aria-label', label);
            b.title = label;
            b.innerHTML = `<span>${esc(label)}</span>`;
          };
          paint();
          st.paintType = paint;
          L.DomEvent.disableClickPropagation(b);
          L.DomEvent.on(b, 'click', () => {
            map.removeLayer(mapType === 'map' ? streets : satellite);
            mapType = mapType === 'map' ? 'satellite' : 'map';
            (mapType === 'map' ? streets : satellite).addTo(map);
            map.getContainer().classList.toggle('map--satellite', mapType === 'satellite');
            try {
              localStorage.setItem('ncs_maptype', mapType);
            } catch {
              /* storage blocked */
            }
            paint();
          });
          return b;
        },
      });
      new MapType().addTo(map);
      map.getContainer().classList.toggle('map--satellite', mapType === 'satellite');
    }

    const Legend = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd() {
        const div = L.DomUtil.create('div', 'legend');
        div.id = 'legend';
        L.DomEvent.disableClickPropagation(div);
        return div;
      },
    });
    new Legend().addTo(map);
    const Count = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const div = L.DomUtil.create('div', 'map-count');
        div.id = 'map-count';
        div.setAttribute('aria-hidden', 'true');
        return div;
      },
    });
    new Count().addTo(map);

    st.markerLayer = L.layerGroup().addTo(map);
    map.on('zoomend moveend', debounce(() => renderMarkers(), 40));
    map.on('moveend', debounce(() => A.current.onMapMoved(), 120));
    map.on('popupclose', () => (st.openPopupId = null));

    // Buttons inside pin cards (popups are plain HTML, so one delegated listener handles them)
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement).closest('.pin-card [data-action]') as HTMLElement | null;
      if (!b) return;
      e.preventDefault();
      const id = b.dataset.id!;
      if (b.dataset.action === 'detail') {
        map.closePopup();
        A.current.openDetail(id, { source: 'pin' });
      } else if (b.dataset.action === 'save') A.current.toggleSave(id, 'pin');
    };
    map.getContainer().addEventListener('click', onClick);

    // ---- Pins and clusters ----------------------------------------------------------------------
    const pinState = (s: SchoolSummary) => `${A.current.saved.has(s.id) ? 1 : 0}${s.id === A.current.selectedId ? 1 : 0}`;
    const pinIcon = (s: SchoolSummary) => {
      const cls = ['pin', `pin--${BKEY[s.borough]}`];
      if (A.current.saved.has(s.id)) cls.push('pin--saved');
      if (s.id === A.current.selectedId) cls.push('is-selected');
      return L.divIcon({ className: 'pin-wrap', html: `<span class="${cls.join(' ')}">${PIN_SVG}</span>`, iconSize: [26, 38], iconAnchor: [13, 37], popupAnchor: [0, -34] });
    };
    const markerFor = (s: SchoolSummary) => {
      let m = st.markers.get(s.id);
      if (!m) {
        m = L.marker([s.lat, s.lng], { icon: pinIcon(s), title: s.name, keyboard: true, riseOnHover: true });
        m.on('click', () => openPinCard(s.id));
        m._ncsState = pinState(s);
        st.markers.set(s.id, m);
      } else if (m._ncsState !== pinState(s)) {
        m._ncsState = pinState(s);
        m.setIcon(pinIcon(s));
      }
      return m;
    };
    const pinCardHtml = (s: SchoolSummary) => {
      const { saved, origin } = A.current;
      const isSaved = saved.has(s.id);
      const dist = origin ? ` · ${core.formatMiles(core.distanceKm(origin, s), lang())}` : '';
      return `<div class="pin-card">
        <p class="pin-card__eyebrow"><i class="swatch swatch--${BKEY[s.borough]}" aria-hidden="true"></i>${esc(boroughName(s.borough))}${esc(dist)}</p>
        <h3 class="pin-card__title">${esc(s.name)}</h3>
        <p class="pin-card__meta">${esc(t('gradesX', { g: gradeLabel(s.grades) }))}${s.network ? ` · ${esc(s.network)}` : ''}</p>
        <div class="pin-card__actions">
          <a class="btn btn--primary btn--sm" href="#school=${esc(s.id)}" data-action="detail" data-id="${esc(s.id)}">${esc(t('viewDetails'))}</a>
          <button type="button" class="btn btn--ghost btn--sm${isSaved ? ' is-saved' : ''}" data-action="save" data-id="${esc(s.id)}" aria-pressed="${isSaved}">${esc(isSaved ? t('savedBtn') : t('saveBtn'))}</button>
        </div></div>`;
    };
    const buildingCardHtml = (list: SchoolSummary[]) =>
      `<div class="pin-card"><p class="pin-card__eyebrow">${esc(t('sameBuilding', { n: list.length }))}</p><ul class="pin-card__list">${list
        .map((s) => `<li><a href="#school=${esc(s.id)}" data-action="detail" data-id="${esc(s.id)}">${esc(s.name)}</a> <span class="muted">${esc(gradeLabel(s.grades))}</span></li>`)
        .join('')}</ul></div>`;

    const openPinCard = (id: string) => {
      const s = A.current.byId.get(id);
      if (!s) return;
      const m = markerFor(s);
      if (!st.markerLayer.hasLayer(m)) st.markerLayer.addLayer(m);
      st.openPopupId = id;
      m.bindPopup(pinCardHtml(s), { maxWidth: 280, minWidth: 220, autoPanPadding: [40, 40], className: 'ncs-popup' }).openPopup();
      A.current.setHighlightId(id);
    };
    st.refreshPopup = () => {
      if (!st.openPopupId) return;
      const m = st.markers.get(st.openPopupId);
      const s = A.current.byId.get(st.openPopupId);
      if (m && s && m.getPopup()) m.setPopupContent(pinCardHtml(s));
    };

    const renderMarkers = () => {
      const { filtered, selectedId, byId } = A.current;
      const zoom = map.getZoom();
      const keep = new Set<string>();
      st.markerLayer.eachLayer((l: any) => {
        if (l.options.isCluster) st.markerLayer.removeLayer(l);
      });
      const items = (filtered as SchoolSummary[]).filter((s) => s.id !== selectedId);
      let groups: { items: SchoolSummary[] }[];
      if (zoom >= 15) {
        // Only schools sharing an address stay grouped.
        const byLoc = new Map<string, SchoolSummary[]>();
        for (const s of items) {
          const k = `${s.lat},${s.lng}`;
          if (!byLoc.has(k)) byLoc.set(k, []);
          byLoc.get(k)!.push(s);
        }
        groups = [...byLoc.values()].map((g) => ({ items: g }));
      } else {
        groups = clusterLib.cluster(items, (s: SchoolSummary) => map.project([s.lat, s.lng], zoom), 56);
      }
      for (const g of groups) {
        if (g.items.length === 1) {
          const m = markerFor(g.items[0]);
          keep.add(g.items[0].id);
          if (!st.markerLayer.hasLayer(m)) st.markerLayer.addLayer(m);
          continue;
        }
        const n = g.items.length;
        const lat = g.items.reduce((a, s) => a + s.lat, 0) / n;
        const lng = g.items.reduce((a, s) => a + s.lng, 0) / n;
        const size = n < 10 ? 34 : n < 50 ? 40 : 48;
        const sameSpot = g.items.every((s) => s.lat === g.items[0].lat && s.lng === g.items[0].lng);
        const cm = L.marker([lat, lng], {
          isCluster: true, keyboard: true, title: sameSpot ? t('sameBuilding', { n }) : t('clusterTitle', { n }),
          icon: L.divIcon({ className: 'pin-wrap', html: `<span class="cluster${sameSpot ? ' cluster--building' : ''}"><b>${n}</b></span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        });
        cm.on('click', () => {
          if (sameSpot || zoom >= 17) {
            cm.bindPopup(buildingCardHtml(g.items), { maxWidth: 300, className: 'ncs-popup' }).openPopup();
            A.current.setHighlightId(g.items[0].id);
          } else map.flyToBounds(L.latLngBounds(g.items.map((s) => [s.lat, s.lng])).pad(0.25), { duration: 0.5, maxZoom: 16 });
        });
        st.markerLayer.addLayer(cm);
      }
      const sel = selectedId && byId.get(selectedId);
      if (sel) {
        const m = markerFor(sel);
        keep.add(sel.id);
        if (!st.markerLayer.hasLayer(m)) st.markerLayer.addLayer(m);
        m.setZIndexOffset(1000);
      }
      for (const [id, m] of st.markers) if (!keep.has(id) && st.markerLayer.hasLayer(m) && id !== st.openPopupId) st.markerLayer.removeLayer(m);
      const countEl = document.getElementById('map-count');
      if (countEl) countEl.textContent = t('countShort', { n: fmtNum(filtered.length) });
    };
    st.renderMarkers = renderMarkers;

    const mapApi: MapApi = {
      map,
      baseLayer: st.baseLayer,
      streetLayer: st.streetLayer,
      inBounds: (s) => map.getBounds().contains([s.lat, s.lng]),
      flyToSchool: (s, zoom) => map.flyTo([s.lat, s.lng], zoom ?? Math.max(map.getZoom(), 15), { duration: 0.5 }),
      openPinCard,
      invalidate: () => map.invalidateSize(),
      setOrigin: (o) => {
        if (st.originMarker) st.originMarker.remove();
        st.originMarker = null;
        if (!o) return;
        st.originMarker = L.marker([o.lat, o.lng], {
          icon: L.divIcon({ className: 'pin-wrap', html: '<span class="origin-dot"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
          keyboard: false, interactive: false, zIndexOffset: 2000,
        }).addTo(map);
        map.flyTo([o.lat, o.lng], 14, { duration: 0.6 });
      },
      hover: (id, on) => {
        const m = st.markers.get(id);
        if (m && st.markerLayer.hasLayer(m)) m.getElement()?.classList.toggle('is-hover', on);
      },
      visibleMarkers: () =>
        [...st.markers.entries()].filter(([, m]: any) => st.markerLayer.hasLayer(m)).map(([id, m]: any) => ({ id, lat: m.getLatLng().lat, lng: m.getLatLng().lng })),
      clusterSizes: () => {
        const c: number[] = [];
        st.markerLayer.eachLayer((l: any) => {
          if (l.options.isCluster) c.push(Number(l.getElement()?.textContent || 0));
        });
        return c;
      },
    };
    A.current.mapApi.current = mapApi;

    return () => {
      map.getContainer().removeEventListener('click', onClick);
      map.remove();
      A.current.mapApi.current = null;
      M.current = null;
    };
  }, []);

  // ---- Keep pins in step with the list ----------------------------------------------------------
  // Drawn just after the browser paints the list, so a filter click shows its result on the next frame (PERF-01).
  useEffect(() => {
    const st = M.current;
    if (!st) return;
    const h = setTimeout(() => {
      st.renderMarkers();
      st.refreshPopup();
    }, 0);
    return () => clearTimeout(h);
  }, [app.filtered, app.saved, app.selectedId, app.origin, app.lang]);

  // Fit the map to the results when a filter asks for it (borough, district, zip, clear all, first load)
  useEffect(() => {
    const st = M.current;
    if (!st || !app.fitToken) return;
    const L = window.L;
    const h = setTimeout(() => {
      const { map } = st;
      if (A.current.filters.inView) return;
      const size = map.getSize();
      if (!size.x || !size.y) return;
      const pts = (A.current.filtered as SchoolSummary[]).map((s) => [s.lat, s.lng]);
      if (!pts.length) return;
      if (pts.length === 1) map.flyTo(pts[0], 15, { duration: 0.5 });
      else map.flyToBounds(L.latLngBounds(pts).pad(0.08), { duration: 0.5, maxZoom: 15 });
    }, 16);
    return () => clearTimeout(h);
  }, [app.fitToken]);

  // Translated control labels and legend
  useEffect(() => {
    const st = M.current;
    const legend = document.getElementById('legend');
    if (legend) {
      legend.innerHTML =
        `<strong>${esc(t('borough'))}</strong>` +
        BOROUGHS.map((b) => `<span><i class="swatch swatch--${b.key}" aria-hidden="true"></i>${esc(boroughName(b.id))}</span>`).join('') +
        `<span><i class="swatch swatch--saved" aria-hidden="true"></i>${esc(t('legendSaved'))}</span>`;
    }
    const loc = document.getElementById('map-locate');
    if (loc) {
      loc.title = t('myLocation');
      loc.setAttribute('aria-label', t('myLocation'));
    }
    st?.paintType?.();
    if (notice.kind === 'tiles') setNotice({ text: t('tilesFailed'), kind: 'tiles' });
    else if (notice.kind === 'nomap') setNotice({ text: t('mapUnavailable'), kind: 'nomap' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lang]);

  return (
    <>
      <div id="map" ref={el}></div>
      <div className="map-notice" id="map-notice" role="status" hidden={!notice.text} data-kind={notice.kind}>{notice.text}</div>
    </>
  );
}
