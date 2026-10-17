/* Grid-based marker clustering (MAP-01). Groups points whose screen positions fall in the same
   cell, so pins cluster at city zoom and separate as you zoom in. Pure function; no DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.NCS = root.NCS || {}).cluster = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {Array} items         points to group
   * @param {Function} project    item -> {x, y} in screen pixels at the current zoom
   * @param {number} cellPx       grid cell size in pixels
   * @returns {Array<{items, x, y}>} groups; a group with one item is drawn as a plain pin
   */
  function cluster(items, project, cellPx = 56) {
    const cells = new Map();
    for (const it of items) {
      const p = project(it);
      const key = `${Math.floor(p.x / cellPx)}:${Math.floor(p.y / cellPx)}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { items: [], sx: 0, sy: 0 }));
      c.items.push(it);
      c.sx += p.x;
      c.sy += p.y;
    }
    // Merge clusters whose centres are closer than half a cell (avoids two bubbles touching).
    const groups = [...cells.values()].map((c) => ({ items: c.items, x: c.sx / c.items.length, y: c.sy / c.items.length }));
    const merged = [];
    for (const g of groups.sort((a, b) => b.items.length - a.items.length)) {
      const near = merged.find((m) => Math.hypot(m.x - g.x, m.y - g.y) < cellPx / 2);
      if (near) {
        const n = near.items.length + g.items.length;
        near.x = (near.x * near.items.length + g.x * g.items.length) / n;
        near.y = (near.y * near.items.length + g.y * g.items.length) / n;
        near.items = near.items.concat(g.items);
      } else merged.push({ ...g });
    }
    return merged;
  }

  return { cluster };
});
