'use strict';

/** Shared NYC reference data used by the seed validator, the API and the client. */

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island'];
// Campus ids start with the DOE borough letter: m-, k-, x-, q-, r- (e.g. k-kipp-amp-elementary-school)
const BOROUGH_LETTER = { m: 'Manhattan', k: 'Brooklyn', x: 'Bronx', q: 'Queens', r: 'Staten Island' };
const GRADES = ['PK', '0K', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const STATUSES = ['researching', 'applied', 'waitlisted', 'offered', 'accepted', 'declined'];

// Five-borough bounding box (generous by ~1 km).
const NYC_BOUNDS = { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 };

// USPS zip ranges that are inside the five boroughs.
const NYC_ZIP_RANGES = [
  [10001, 10282], // Manhattan
  [10301, 10314], // Staten Island
  [10451, 10475], // Bronx
  [11004, 11005], // Queens (Glen Oaks / Floral Park)
  [11101, 11109], // Queens (Long Island City)
  [11201, 11256], // Brooklyn
  [11351, 11436], // Queens
  [11691, 11697], // Queens (Rockaways)
];

const SCHOOL_ID = /^[mkxqr]-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isNycZip(zip) {
  if (typeof zip !== 'string' || !/^\d{5}$/.test(zip)) return false;
  const n = Number(zip);
  return NYC_ZIP_RANGES.some(([a, b]) => n >= a && n <= b);
}

function inNyc(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lng >= NYC_BOUNDS.minLng &&
    lng <= NYC_BOUNDS.maxLng
  );
}

module.exports = { BOROUGHS, BOROUGH_LETTER, GRADES, STATUSES, NYC_BOUNDS, NYC_ZIP_RANGES, SCHOOL_ID, isNycZip, inNyc };
