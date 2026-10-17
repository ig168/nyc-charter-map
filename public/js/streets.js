/* Street detail base map drawn in the browser from embedded NYC Open Data
   (street centerlines, parks, borough shoreline). Used where outside map tiles
   can't load, such as the hosted demo. Tiles are canvases styled like Google Maps. */
(function (root) {
  'use strict';

  const TILE = 256;
  const CELL_Z = 13; // spatial index cell = one zoom-13 tile
  const STYLE = {
    water: '#aadaff',
    land: '#f2f1ed',
    park: '#c5e8c0',
    cemetery: '#d6e6d1',
    minor: { fill: '#ffffff', casing: '#d9dbdf', minZ: 14 },
    major: { fill: '#ffffff', casing: '#c6cad0', minZ: 12 },
    ramp: { fill: '#fde9a8', casing: '#efc35a', minZ: 13 },
    highway: { fill: '#fdd96b', casing: '#e8a93a', minZ: 10 },
    label: '#4d5156',
    halo: 'rgba(255,255,255,0.92)',
  };
  // line width (px) per class by zoom, interpolated
  const WIDTH = {
    0: [[14, 1.1], [15, 2], [16, 4], [17, 7], [18, 12], [19, 20]],
    1: [[12, 1.2], [13, 2], [14, 3], [15, 4.5], [16, 7], [17, 10], [18, 16], [19, 26]],
    2: [[13, 1.2], [14, 2], [15, 3], [16, 4.5], [17, 7], [18, 10], [19, 16]],
    3: [[10, 1.4], [11, 1.8], [12, 2.4], [13, 3.2], [14, 4.4], [15, 6], [16, 8], [17, 12], [18, 18], [19, 28]],
  };
  const CLASS_STYLE = [STYLE.minor, STYLE.major, STYLE.ramp, STYLE.highway];
  const DRAW_ORDER = [0, 1, 2, 3];

  function width(cls, z) {
    const t = WIDTH[cls];
    if (z <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) {
      if (z <= t[i][0]) {
        const [z0, w0] = t[i - 1], [z1, w1] = t[i];
        return w0 + ((w1 - w0) * (z - z0)) / (z1 - z0);
      }
    }
    return t[t.length - 1][1];
  }

  // Google polyline decoding at 1e-5 → Web Mercator in [0,1]
  function decode(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (let k = 0; k < 2; k++) {
        let b, shift = 0, result = 0;
        do {
          b = str.charCodeAt(i++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (k === 0) lat += d;
        else lng += d;
      }
      out.push(merc(lat / 1e5, lng / 1e5));
    }
    return out;
  }
  function merc(lat, lng) {
    const s = Math.sin((lat * Math.PI) / 180);
    return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }
  function bboxOf(rings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  function prepare(data) {
    const t0 = performance.now();
    const lines = data.lines.map(([cls, name, enc]) => {
      const pts = decode(enc);
      return { cls, name: data.names[name], pts, bbox: bboxOf([pts]) };
    });
    const land = data.land.map((rings) => {
      const r = rings.map(decode);
      return { rings: r, bbox: bboxOf(r) };
    });
    const parks = data.parks.map(([kind, rings]) => {
      const r = rings.map(decode);
      return { kind, rings: r, bbox: bboxOf(r) };
    });
    // grid index for lines and parks at zoom-13 cells
    const n = 2 ** CELL_Z;
    const grid = new Map();
    const add = (f, i, kind) => {
      const cx0 = Math.floor(f.bbox[0] * n), cx1 = Math.floor(f.bbox[2] * n);
      const cy0 = Math.floor(f.bbox[1] * n), cy1 = Math.floor(f.bbox[3] * n);
      for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) {
        const k = x * n + y;
        let c = grid.get(k);
        if (!c) grid.set(k, (c = { lines: [], parks: [] }));
        c[kind].push(i);
      }
    };
    lines.forEach((f, i) => add(f, i, 'lines'));
    parks.forEach((f, i) => add(f, i, 'parks'));
    const highways = lines.map((f, i) => (f.cls >= 2 ? i : -1)).filter((i) => i >= 0);
    const majors = lines.map((f, i) => (f.cls >= 1 ? i : -1)).filter((i) => i >= 0);
    return { lines, land, parks, grid, highways, majors, prepMs: performance.now() - t0 };
  }

  function query(idx, z, bx0, by0, bx1, by1) {
    // bbox in mercator units; returns candidate line + park indexes
    if (z < CELL_Z - 1) {
      const pool = z >= 12 ? idx.majors : idx.highways;
      const lines = pool.filter((i) => intersects(idx.lines[i].bbox, bx0, by0, bx1, by1));
      const parks = [];
      idx.parks.forEach((p, i) => intersects(p.bbox, bx0, by0, bx1, by1) && parks.push(i));
      return { lines, parks };
    }
    const n = 2 ** CELL_Z;
    const seenL = new Set(), seenP = new Set();
    for (let x = Math.floor(bx0 * n); x <= Math.floor(bx1 * n); x++) {
      for (let y = Math.floor(by0 * n); y <= Math.floor(by1 * n); y++) {
        const c = idx.grid.get(x * n + y);
        if (!c) continue;
        for (const i of c.lines) seenL.add(i);
        for (const i of c.parks) seenP.add(i);
      }
    }
    const lines = [], parks = [];
    for (const i of seenL) if (intersects(idx.lines[i].bbox, bx0, by0, bx1, by1)) lines.push(i);
    for (const i of seenP) if (intersects(idx.parks[i].bbox, bx0, by0, bx1, by1)) parks.push(i);
    return { lines, parks };
  }
  function intersects(b, x0, y0, x1, y1) {
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  }

  function drawTile(idx, canvas, coords, dpr, stats) {
    const t0 = performance.now();
    const z = coords.z;
    const scale = TILE * 2 ** z;
    const ox = coords.x * TILE, oy = coords.y * TILE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = STYLE.water;
    ctx.fillRect(0, 0, TILE, TILE);
    // margin so wide lines crossing the edge draw identically in both tiles
    const m = (width(3, z) + 4) / scale;
    const bx0 = ox / scale - m, by0 = oy / scale - m, bx1 = (ox + TILE) / scale + m, by1 = (oy + TILE) / scale + m;
    const path = (pts) => {
      ctx.moveTo(pts[0][0] * scale - ox, pts[0][1] * scale - oy);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * scale - ox, pts[i][1] * scale - oy);
    };

    // land
    ctx.fillStyle = STYLE.land;
    ctx.beginPath();
    for (const f of idx.land) {
      if (!intersects(f.bbox, bx0, by0, bx1, by1)) continue;
      for (const r of f.rings) {
        path(r);
        ctx.closePath();
      }
    }
    ctx.fill('evenodd');

    const { lines, parks } = query(idx, z, bx0, by0, bx1, by1);
    // parks and cemeteries
    for (const kind of [0, 1]) {
      ctx.fillStyle = kind ? STYLE.cemetery : STYLE.park;
      ctx.beginPath();
      let any = false;
      for (const i of parks) {
        const p = idx.parks[i];
        if (p.kind !== kind) continue;
        // skip specks smaller than ~2px at this zoom
        if ((p.bbox[2] - p.bbox[0]) * scale < 2 && (p.bbox[3] - p.bbox[1]) * scale < 2) continue;
        for (const r of p.rings) {
          path(r);
          ctx.closePath();
        }
        any = true;
      }
      if (any) ctx.fill('evenodd');
    }

    // roads: casings for every visible class first, then fills, lowest class first
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const visible = DRAW_ORDER.filter((c) => z >= CLASS_STYLE[c].minZ);
    const byClass = { 0: [], 1: [], 2: [], 3: [] };
    for (const i of lines) {
      const f = idx.lines[i];
      if (z >= CLASS_STYLE[f.cls].minZ) byClass[f.cls].push(f);
    }
    for (const pass of ['casing', 'fill']) {
      for (const c of visible) {
        const list = byClass[c];
        if (!list.length) continue;
        const w = width(c, z);
        const casing = Math.max(0.8, w * 0.18 + 0.6);
        if (pass === 'casing' && w < 1.6) continue; // thin lines need no outline
        ctx.strokeStyle = CLASS_STYLE[c][pass];
        ctx.lineWidth = pass === 'casing' ? w + casing * 2 : w;
        ctx.beginPath();
        for (const f of list) path(f.pts);
        ctx.stroke();
      }
    }

    let labels = [];
    if (z >= 16) labels = drawLabels(ctx, byClass, z, scale, ox, oy);
    const ms = performance.now() - t0;
    if (stats) {
      stats.tiles += 1;
      stats.totalMs += ms;
      stats.byZoom[z] = stats.byZoom[z] || { tiles: 0, ms: 0 };
      stats.byZoom[z].tiles += 1;
      stats.byZoom[z].ms += ms;
      if (stats.keepLabels) stats.labels.push({ key: `${z}/${coords.x}/${coords.y}`, boxes: labels });
    }
  }

  // Street names along the longest straight piece inside the tile; kept fully inside the tile, no overlaps.
  function drawLabels(ctx, byClass, z, scale, ox, oy) {
    const size = z >= 17 ? 12 : 11;
    ctx.font = `500 ${size}px Roboto, "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const placed = [];
    const seen = new Set();
    const PAD = 3;
    const order = [3, 1, 0]; // highways and avenues first; ramps unlabeled, as on Google Maps
    for (const c of order) {
      for (const f of byClass[c]) {
        if (!f.name) continue;
        const key = f.name;
        if (seen.has(key) && z < 18) continue;
        const tw = ctx.measureText(f.name).width;
        // best spot: the longest visible (clipped-to-tile) piece of any segment, label centered on it
        let best = null;
        for (let i = 1; i < f.pts.length; i++) {
          const c = clip(f.pts[i - 1][0] * scale - ox, f.pts[i - 1][1] * scale - oy, f.pts[i][0] * scale - ox, f.pts[i][1] * scale - oy, PAD, TILE - PAD);
          if (!c) continue;
          const [ax, ay, bx, by] = c;
          const len = Math.hypot(bx - ax, by - ay);
          if (len < tw + 12) continue;
          if (!best || len > best.len) best = { ax, ay, bx, by, mx: (ax + bx) / 2, my: (ay + by) / 2, len };
        }
        if (!best) continue;
        let ang = Math.atan2(best.by - best.ay, best.bx - best.ax);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const hw = tw / 2 + 2, hh = size / 2 + 2;
        const cos = Math.abs(Math.cos(ang)), sin = Math.abs(Math.sin(ang));
        const ex = hw * cos + hh * sin, ey = hw * sin + hh * cos;
        const box = [best.mx - ex, best.my - ey, best.mx + ex, best.my + ey];
        if (box[0] < PAD || box[1] < PAD || box[2] > TILE - PAD || box[3] > TILE - PAD) continue;
        if (placed.some((p) => p[0] < box[2] && p[2] > box[0] && p[1] < box[3] && p[3] > box[1])) continue;
        placed.push(box);
        seen.add(key);
        ctx.save();
        ctx.translate(best.mx, best.my);
        ctx.rotate(ang);
        ctx.lineWidth = 3;
        ctx.strokeStyle = STYLE.halo;
        ctx.strokeText(f.name, 0, 0.5);
        ctx.fillStyle = STYLE.label;
        ctx.fillText(f.name, 0, 0.5);
        ctx.restore();
      }
    }
    return placed;
  }

  // Liang–Barsky: clip a segment to the square [lo, hi]², or null when it misses
  function clip(x0, y0, x1, y1, lo, hi) {
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    for (const [p, q] of [[-dx, x0 - lo], [dx, hi - x0], [-dy, y0 - lo], [dy, hi - y0]]) {
      if (p === 0) {
        if (q < 0) return null;
      } else {
        const r = q / p;
        if (p < 0) {
          if (r > t1) return null;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return null;
          if (r < t1) t1 = r;
        }
      }
    }
    return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
  }

  function createLayer(L, data, opts = {}) {
    const idx = prepare(data);
    const stats = { tiles: 0, totalMs: 0, byZoom: {}, labels: [], keepLabels: false, prepMs: idx.prepMs, lines: idx.lines.length };
    const Layer = L.GridLayer.extend({
      createTile(coords) {
        const tile = document.createElement('canvas');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        tile.width = tile.height = TILE * dpr;
        tile.style.width = tile.style.height = `${TILE}px`;
        drawTile(idx, tile, coords, dpr, stats);
        return tile;
      },
    });
    const layer = new Layer({
      maxZoom: 19,
      updateWhenZooming: false,
      keepBuffer: 2,
      attribution: 'Streets, parks &amp; shoreline: <a href="https://opendata.cityofnewyork.us/" target="_blank" rel="noopener">NYC Open Data</a>',
      ...opts,
    });
    layer.ncsStats = stats;
    layer.ncsIndex = idx;
    return layer;
  }

  const api = { createLayer, decode, merc, width, STYLE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NCSStreets = api;
})(typeof window !== 'undefined' ? window : globalThis);
