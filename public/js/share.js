/* Read-only shared shortlist (SHR-01). No edit controls, no owner name or email. */
(() => {
  'use strict';
  const { i18n, core } = window.NCS;
  const t = (k, v) => i18n.t(k, v);
  Object.assign(i18n.dict.en, {
    sharedTitle: 'Shared shortlist',
    sharedSub: 'A read-only list of charter schools someone saved.',
    sharedMissing: 'This shared list does not exist or was turned off.',
    sharedEmpty: 'This list is empty.',
    viewOnMap: 'View on map',
  });
  Object.assign(i18n.dict.es, {
    sharedTitle: 'Lista compartida',
    sharedSub: 'Una lista de solo lectura con escuelas chárter que alguien guardó.',
    sharedMissing: 'Esta lista compartida no existe o se dejó de compartir.',
    sharedEmpty: 'Esta lista está vacía.',
    viewOnMap: 'Ver en el mapa',
  });
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const body = document.getElementById('share-body');
  const token = location.pathname.split('/').pop();
  let data = null;

  function render() {
    i18n.apply(document);
    const btn = document.getElementById('lang-toggle');
    btn.textContent = i18n.lang() === 'es' ? 'EN' : 'ES';
    btn.setAttribute('aria-label', t('langToggleLabel'));
    if (!data) return;
    if (data.error) {
      body.innerHTML = `<p class="alert alert--error">${esc(t('sharedMissing'))}</p>`;
      return;
    }
    if (!data.schools.length) {
      body.innerHTML = `<p class="muted">${esc(t('sharedEmpty'))}</p>`;
      return;
    }
    const lang = i18n.lang();
    body.innerHTML = `<ul class="my-list">${data.schools
      .map(
        (s) => `<li class="my-card"><h2 class="my-card__title"><a class="link-btn--title" href="/#school=${esc(s.id)}">${esc(s.name)}</a></h2>
        <p class="my-card__meta">${[s.network, t(`boro_${{ Manhattan: 'manhattan', Brooklyn: 'brooklyn', Bronx: 'bronx', Queens: 'queens', 'Staten Island': 'staten' }[s.borough]}`), t('gradesX', { g: core.gradeLabel(s.grades, lang) })].filter(Boolean).map(esc).join(' · ')}</p>
        <p class="my-card__meta">${esc(s.address)}${s.deadline ? ` · ${esc(t('deadlineOn', { d: new Date(`${s.deadline}T12:00:00`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' }) }))}` : ''}</p>
        <p class="my-card__meta"><span class="tag tag--soft">${esc(t('statusLabel'))}: ${esc(t(`status_${s.status}`))}</span></p></li>`,
      )
      .join('')}</ul>`;
  }

  document.getElementById('lang-toggle').addEventListener('click', () => {
    i18n.setLang(i18n.lang() === 'es' ? 'en' : 'es');
    render();
  });

  fetch(`/api/share/${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : { error: true }))
    .catch(() => ({ error: true }))
    .then((d) => {
      data = d;
      render();
    });
  render();
})();
