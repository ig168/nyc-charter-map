'use strict';

/**
 * Address search for "Near me / address" (MAP-04). Zip codes resolve locally from the seed;
 * everything else goes to NYC Planning's GeoSearch (free, no key, NYC-only).
 */

const { isNycZip, inNyc } = require('./nyc');

class GeocodeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createGeocoder({ store, fetchImpl = globalThis.fetch, baseUrl = 'https://geosearch.planninglabs.nyc/v2/search', offline = false } = {}) {
  const cache = new Map();

  function zipCentroid(zip) {
    const pts = store.schoolSummaries().schools.filter((s) => s.zip === zip);
    if (!pts.length) return null;
    const lat = pts.reduce((a, s) => a + s.lat, 0) / pts.length;
    const lng = pts.reduce((a, s) => a + s.lng, 0) / pts.length;
    return { label: `ZIP ${zip}`, lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, kind: 'zip' };
  }

  return async function geocode(raw) {
    const q = String(raw || '').trim().replace(/\s+/g, ' ');
    if (q.length < 3 || q.length > 120) throw new GeocodeError(400, 'Enter an address, place or 5-digit zip code.');
    if (/^\d{5}$/.test(q)) {
      if (!isNycZip(q)) throw new GeocodeError(400, `${q} isn't a New York City zip code.`);
      const local = zipCentroid(q);
      if (local) return local;
    }
    const key = q.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    if (offline) throw new GeocodeError(503, 'Address search is unavailable right now. Try a zip code or "Near me".');

    let body;
    try {
      const res = await fetchImpl(`${baseUrl}?${new URLSearchParams({ text: q, size: '1' })}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } catch {
      throw new GeocodeError(503, 'Address search is unavailable right now. Try a zip code or "Near me".');
    }
    const f = body && Array.isArray(body.features) ? body.features[0] : null;
    const [lng, lat] = (f && f.geometry && f.geometry.coordinates) || [];
    if (!f || !inNyc(lat, lng)) throw new GeocodeError(404, `We couldn't find "${q}" in New York City.`);
    const p = f.properties || {};
    const result = { label: String(p.label || q).replace(/, USA$/, '').slice(0, 120), lat, lng, kind: 'address' };
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  };
}

module.exports = { createGeocoder, GeocodeError };
