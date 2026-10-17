/* Hosted demo: answers the app's /api and /auth calls inside the page.
   School data is embedded; saved schools live in the viewer's private db subtree
   (data/users/<id>/…) through the claude.ai `db` + `user` capabilities. */
(() => {
  'use strict';
  const D = window.NCS_DATA;
  const STATUSES = ['researching', 'applied', 'waitlisted', 'offered', 'accepted', 'declined'];
  const realFetch = window.fetch.bind(window);
  const use = (name) => {
    try {
      return window.claude && typeof window.claude.use === 'function' ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const dbP = use('db');
  const userP = use('user');
  const dlP = use('downloads');
  let signedOut = false;
  try {
    signedOut = sessionStorage.getItem('ncs_demo_out') === '1';
  } catch {
    /* storage blocked */
  }

  // Demo wording for the sign-in dialog
  const { i18n } = window.NCS;
  Object.assign(i18n.dict.en, {
    devLogin: 'Continue with your claude.ai account',
    signInSetup: 'This demo saves schools with your claude.ai sign-in. The full app uses Google sign-in.',
    signInPrivacy: 'Your saved schools and notes are private to your account on this page.',
    demoNeedAccount: 'Sign in to claude.ai (with edit or contributor access to this page) to save schools.',
    demoNoAddress: 'Address search isn’t available in this demo. Enter a 5-digit NYC zip code instead.',
    demoNoShare: 'Share links are part of the full app, not this demo.',
    demoNoIcs: 'Calendar files can’t be downloaded from this demo page. The full app exports them.',
  });
  Object.assign(i18n.dict.es, {
    devLogin: 'Continuar con su cuenta de claude.ai',
    signInSetup: 'Esta demostración guarda escuelas con su sesión de claude.ai. La aplicación completa usa Google.',
    signInPrivacy: 'Sus escuelas guardadas y notas son privadas para su cuenta en esta página.',
    demoNeedAccount: 'Inicie sesión en claude.ai (con acceso de edición o colaboración a esta página) para guardar escuelas.',
    demoNoAddress: 'La búsqueda por dirección no está disponible en esta demostración. Escriba un código postal de NYC de 5 dígitos.',
    demoNoShare: 'Los enlaces para compartir son parte de la aplicación completa, no de esta demostración.',
    demoNoIcs: 'No se pueden descargar archivos de calendario desde esta página. La aplicación completa los exporta.',
  });
  const t = (k) => i18n.t(k);

  const json = (status, body) =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fail = (status, message) => json(status, { error: 'demo', message });

  async function viewer() {
    const user = await userP;
    if (!user) return null;
    const id = await user.id();
    if (!id) return null;
    const name = (await user.name()) || 'You';
    return { id, name, email: '', picture: null };
  }
  async function savedCol() {
    const db = await dbP;
    const v = await viewer();
    if (!db || !v || signedOut) return null;
    return db.collection(`data/users/${v.id}`);
  }
  async function listSaved(col) {
    const snap = await col.get();
    return snap.docs
      .filter((d) => d.exists && D.byId[d.id])
      .map((d) => ({ schoolId: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(({ schoolId, status, note, updatedAt }) => ({ schoolId, status: status || 'researching', note: note || '', updatedAt }));
  }
  function zipCentroid(z) {
    const pts = D.schools.filter((s) => s.zip === z);
    if (!pts.length) return null;
    return { label: `ZIP ${z}`, kind: 'zip', lat: pts.reduce((a, s) => a + s.lat, 0) / pts.length, lng: pts.reduce((a, s) => a + s.lng, 0) / pts.length };
  }

  async function route(url, init) {
    const u = new URL(url, location.href);
    const path = u.pathname;
    const method = (init && init.method) || 'GET';
    let body = {};
    try {
      body = init && init.body ? JSON.parse(init.body) : {};
    } catch {
      /* ignore */
    }

    if (path === '/api/events') return json(204);
    if (path === '/api/schools') return json(200, { meta: D.meta, schools: D.schools });
    const det = /^\/api\/schools\/([^/]+)$/.exec(path);
    if (det) {
      const s = D.details[decodeURIComponent(det[1]).toLowerCase()];
      return s ? json(200, { school: s }) : fail(404, 'School not found');
    }
    if (path === '/api/geocode') {
      const q = (u.searchParams.get('q') || '').trim();
      if (/^\d{5}$/.test(q)) {
        const z = zipCentroid(q);
        if (z) return json(200, { result: z });
        if (window.NCS.core.isNycZip(q)) return fail(404, `No charter schools are listed in ${q}. Try a nearby zip code.`);
        return fail(400, `${q} isn’t a New York City zip code.`);
      }
      return fail(404, t('demoNoAddress'));
    }
    if (path === '/auth/config') return json(200, { googleClientId: null, devLogin: true, nonce: 'demo' });
    if (path === '/auth/dev') {
      const v = await viewer();
      const db = await dbP;
      if (!v || !db) return fail(403, t('demoNeedAccount'));
      signedOut = false;
      try {
        sessionStorage.removeItem('ncs_demo_out');
      } catch {
        /* ignore */
      }
      return json(200, { user: { name: v.name, email: '', picture: null } });
    }
    if (path === '/auth/logout') {
      signedOut = true;
      try {
        sessionStorage.setItem('ncs_demo_out', '1');
      } catch {
        /* ignore */
      }
      return json(200, { ok: true });
    }
    if (path === '/api/me') {
      const v = signedOut ? null : await viewer();
      const db = await dbP;
      return json(200, { user: v && db ? { name: v.name, email: '', picture: null } : null });
    }
    if (path === '/api/share' && method === 'GET') return json(200, { token: null, path: null });
    if (path.startsWith('/api/share')) return fail(400, t('demoNoShare'));

    // Saved schools (private per viewer)
    const col = await savedCol();
    if (path === '/api/saved' || path.startsWith('/api/saved/')) {
      if (!col) return fail(401, t('demoNeedAccount'));
      try {
        if (path === '/api/saved') return json(200, { saved: await listSaved(col) });
        const id = decodeURIComponent(path.split('/').pop()).toLowerCase();
        if (!D.byId[id]) return fail(400, 'Invalid school id');
        const ref = col.doc(id);
        const now = new Date().toISOString();
        if (method === 'PUT') {
          const cur = await ref.get();
          if (!cur.exists) await ref.set({ status: 'researching', note: '', createdAt: now, updatedAt: now });
        } else if (method === 'DELETE') {
          await ref.delete();
        } else if (method === 'PATCH') {
          const cur = await ref.get();
          if (!cur.exists) return fail(404, 'Save this school first');
          const patch = { updatedAt: now };
          if (body.status !== undefined) {
            if (!STATUSES.includes(body.status)) return fail(400, 'Invalid status');
            patch.status = body.status;
          }
          if (body.note !== undefined) {
            if (typeof body.note !== 'string' || [...body.note].length > 2000) return fail(400, 'Notes can be up to 2,000 characters.');
            patch.note = body.note;
          }
          await ref.update(patch);
          const list = await listSaved(col);
          return json(200, { item: list.find((x) => x.schoolId === id), saved: list });
        }
        return json(200, { saved: await listSaved(col) });
      } catch (e) {
        if (e && e.code === 'invalid_argument') return fail(403, t('demoNeedAccount'));
        return fail(503, 'Saving is unavailable right now. Try again in a moment.');
      }
    }
    return fail(404, 'Not found');
  }

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/^\/(api|auth)\//.test(url)) return route(url, init);
    return realFetch(input, init);
  };

  // Downloads go through the viewer's confirmation (plain download links are inert on this host)
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = kind || 'info';
    el.hidden = false;
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (el.hidden = true), 4200);
  }
  document.addEventListener(
    'click',
    async (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (href === '/api/saved.ics') {
        e.preventDefault();
        toast(t('demoNoIcs'));
        return;
      }
      // No server here: site-relative links (logo → "/") would load a missing page in the frame
      if (href.startsWith('/') && !href.startsWith('//')) {
        e.preventDefault();
        if (href === '/') {
          const nav = document.getElementById('nav-explore');
          if (nav) nav.click();
          const back = document.querySelector('.detail__close');
          if (back && back.offsetParent) back.click();
          window.scrollTo(0, 0);
        }
        return;
      }
      if (a.hasAttribute('download') && href.startsWith('blob:')) {
        e.preventDefault();
        const text = await (await realFetch(href)).text();
        const dl = await dlP;
        if (!dl) return toast('Downloads aren’t available in this view.', 'error');
        try {
          await dl.save({ filename: a.getAttribute('download') || 'export.csv', data: text });
        } catch (err) {
          if (err && err.code !== 'declined') toast('The file couldn’t be saved here.', 'error');
        }
      }
    },
    true,
  );
})();
