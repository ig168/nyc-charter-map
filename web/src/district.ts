// Community school district lookup (search upgrade SX-08). The boundary file is NYC Open Data's
// "School Districts" (8ugf-3d8u), simplified and served from this site, so a family's location is
// checked in their own browser and never sent anywhere.

type Ring = [number, number][]; // [lng, lat]
interface DistrictShape { d: number; polys: Ring[][]; bbox: [number, number, number, number] }

let shapes: Promise<DistrictShape[] | null> | null = null;

function load(): Promise<DistrictShape[] | null> {
  if (!shapes) {
    const pre = (window as any).NCS_CSD; // the hosted demo embeds the file
    shapes = (pre ? Promise.resolve(pre) : fetch('/data/csd.json', { credentials: 'omit' }).then((r) => (r.ok ? r.json() : null)))
      .then((data: { districts: { d: number; polys: Ring[][] }[] } | null) => {
        if (!data || !Array.isArray(data.districts)) return null;
        return data.districts.map((x) => {
          let a = Infinity, b = Infinity, c = -Infinity, e = -Infinity;
          for (const poly of x.polys) for (const [lng, lat] of poly[0]) {
            a = Math.min(a, lng); b = Math.min(b, lat); c = Math.max(c, lng); e = Math.max(e, lat);
          }
          return { d: x.d, polys: x.polys, bbox: [a, b, c, e] as [number, number, number, number] };
        });
      })
      .catch(() => {
        shapes = null; // try again next time
        return null;
      });
  }
  return shapes;
}

function inRing(lng: number, lat: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** District number containing the point, or null (outside NYC, or boundaries unavailable). */
export async function districtAt(lat: number, lng: number): Promise<number | null> {
  const list = await load();
  if (!list) return null;
  for (const s of list) {
    const [a, b, c, e] = s.bbox;
    if (lng < a || lng > c || lat < b || lat > e) continue;
    for (const poly of s.polys) {
      if (inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))) return s.d;
    }
  }
  return null;
}
