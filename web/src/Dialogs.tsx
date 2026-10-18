import React, { useEffect, useRef, useState } from 'react';
import { useApp } from './App';
import type { SchoolDetail } from './types';
import { api, boroughName, core, esc, fmtDate, fmtNum, gradeLabel, hostOf, lang, safeUrl, t } from './lib';

declare global {
  interface Window {
    google?: any;
  }
}

// ---------------------------------------------------------------------------------------------
// Sign in with Google (AUTH-01..03)
// ---------------------------------------------------------------------------------------------
let gsiLoaded: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiLoaded) return gsiLoaded;
  gsiLoaded = new Promise<void>((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    sc.onload = () => resolve();
    sc.onerror = () => {
      gsiLoaded = null;
      reject(new Error(t('gsiFailed')));
    };
    document.head.appendChild(sc);
  });
  return gsiLoaded;
}

export function SignInDialog() {
  const app = useApp();
  const { open, trigger } = app.signin as { open: boolean; trigger: string };
  const dlg = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null); // Google renders its own button in here, so React leaves it empty
  const [error, setError] = useState('');
  const [devLogin, setDevLogin] = useState(false);
  const [setup, setSetup] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const A = useRef(app);
  A.current = app;

  useEffect(() => {
    const d = dlg.current!;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // Each opening (and each retry) gets a fresh nonce from the server
  useEffect(() => {
    if (!open || !host.current) return;
    let cancelled = false;
    const h = host.current;
    h.innerHTML = `<span class="muted">${esc(t('loading'))}</span>`;
    (async () => {
      let cfg: { googleClientId: string | null; nonce: string; devLogin: boolean };
      try {
        cfg = await api('/auth/config');
      } catch (e: any) {
        if (cancelled) return;
        h.innerHTML = '';
        setError(e.message);
        return;
      }
      if (cancelled) return;
      setDevLogin(!!cfg.devLogin);
      setSetup(!cfg.googleClientId);
      if (!cfg.googleClientId) {
        h.innerHTML = '';
        return;
      }
      try {
        await loadGsi();
        if (cancelled) return;
        window.google.accounts.id.initialize({
          client_id: cfg.googleClientId,
          callback: async (resp: { credential: string }) => {
            try {
              const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential, trigger: triggerRef.current } });
              await A.current.afterSignIn(r.user);
            } catch (e: any) {
              setError(e.message);
              setAttempt((n) => n + 1); // fresh nonce for a retry
            }
          },
          nonce: cfg.nonce, ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, itp_support: true,
        });
        h.innerHTML = '';
        window.google.accounts.id.renderButton(h, { type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', locale: lang(), width: 300 });
      } catch (e: any) {
        if (cancelled) return;
        h.innerHTML = '';
        setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  useEffect(() => {
    if (open) setError('');
  }, [open]);

  const doDevLogin = async () => {
    try {
      const r = await api('/auth/dev', { method: 'POST', body: { trigger } });
      await app.afterSignIn(r.user);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <dialog className="dialog" id="signin-dialog" aria-labelledby="signin-title" ref={dlg} onClose={app.onSigninClosed}>
      <form method="dialog" className="dialog__close-form"><button className="dialog__close" value="cancel" aria-label={t('close')}>×</button></form>
      <h2 id="signin-title">{t('signInTitle')}</h2>
      <p className="muted" id="signin-why">{t(trigger === 'save' ? 'signInWhySave' : trigger === 'my_schools' ? 'signInWhyMy' : 'signInWhy')}</p>
      <div className="signin__google" id="google-btn" ref={host}></div>
      <button type="button" className="btn btn--ghost btn--block" id="dev-login" hidden={!devLogin} onClick={doDevLogin}>{t('devLogin')}</button>
      <p className="alert alert--error" id="signin-error" role="alert" hidden={!error}>{error}</p>
      <p className="alert alert--info" id="signin-setup" hidden={!setup}>{t('signInSetup')}</p>
      <p className="fine">{t('signInPrivacy')} <a href="/privacy" target="_blank" rel="noopener">{t('privacyLink')}</a></p>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Compare (CMP-01)
// ---------------------------------------------------------------------------------------------
export function CompareBar() {
  const app = useApp();
  const n = app.compare.size;
  return (
    <div className="compare-bar" id="compare-bar" role="region" aria-label={t('compareTray')} hidden={n === 0}>
      <span id="compare-label">{n < 2 ? t('compareHint', { n }) : t('compareSelected', { n })}</span>
      <button type="button" className="btn btn--primary btn--sm" id="compare-open" disabled={n < 2} onClick={() => app.setCompareOpen(true)}>{t('compareNow')}</button>
      <button type="button" className="link-btn link-btn--light" id="compare-clear" onClick={() => app.setCompare(new Set())}>{t('clear')}</button>
    </div>
  );
}

const NA = () => <span className="na">{t('notAvailable')}</span>;
const val = (v: unknown) => (v === null || v === undefined || v === '' ? NA() : String(v));

export function CompareDialog() {
  const app = useApp();
  const dlg = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ ds?: SchoolDetail[]; error?: string }>({});
  const ids: string[] = [...app.compare];
  const key = ids.join('|');

  useEffect(() => {
    const d = dlg.current!;
    if (app.compareOpen && !d.open) {
      if (ids.length < 2) {
        app.setCompareOpen(false);
        app.toast(t('compareNeedTwo'));
        return;
      }
      d.showModal();
    } else if (!app.compareOpen && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.compareOpen]);

  useEffect(() => {
    if (!app.compareOpen) return;
    if (ids.length < 2) {
      app.setCompareOpen(false);
      return;
    }
    let cancelled = false;
    setState({});
    Promise.all(ids.map((id) => app.getDetail(id)))
      .then((ds) => !cancelled && setState({ ds }))
      .catch((e) => !cancelled && setState({ error: e.message }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.compareOpen, key]);

  const rows: [string, (d: SchoolDetail) => React.ReactNode][] = [
    [t('borough'), (d) => boroughName(d.borough)],
    [t('district'), (d) => (d.district ? t('districtN', { d: d.district }) : NA())],
    [t('network'), (d) => val(d.network)],
    [t('gradesServed'), (d) => gradeLabel(d.grades)],
    [t('entryGrades'), (d) => d.entryGrades.map((g) => core.gradeName(g, lang())).join(', ')],
    [t('enrollment'), (d) => (d.enrollment != null ? fmtNum(d.enrollment) : NA())],
    [t('yearFounded'), (d) => val(d.yearFounded)],
    [t('applicationDeadline'), (d) => (d.admissions.applicationDeadline ? fmtDate(d.admissions.applicationDeadline) : NA())],
    [t('lotteryPrefs'), (d) => val(d.admissions.lotteryPreferences)],
    [t('tuition'), (d) => (d.costs.tuitionFree ? t('tuitionFree') : NA())],
    [t('uniform'), (d) => val(d.costs.uniform)],
    [t('afterCare'), (d) => val(d.costs.afterCare)],
    [t('transportation'), (d) => val(d.costs.transportation)],
    [t('phone'), (d) => val(d.contact.phone)],
    [t('website'), (d) => {
      const u = safeUrl(d.contact.website);
      return u ? <a href={u} target="_blank" rel="noopener noreferrer">{hostOf(u)}</a> : NA();
    }],
  ];
  if (app.origin) rows.splice(2, 0, [t('distance'), (d) => core.formatMiles(core.distanceKm(app.origin, d), lang())]);

  return (
    <dialog className="dialog dialog--wide" id="compare-dialog" aria-labelledby="compare-title" ref={dlg} onClose={() => app.setCompareOpen(false)}>
      <form method="dialog" className="dialog__close-form"><button className="dialog__close" value="cancel" aria-label={t('close')}>×</button></form>
      <h2 id="compare-title">{t('compareTitle')}</h2>
      <div className="compare-table-wrap" id="compare-body">
        {state.error ? (
          <p className="alert alert--error" role="alert">{state.error}</p>
        ) : !state.ds ? (
          <p className="muted" role="status">{t('loading')}</p>
        ) : (
          <table className="compare-table">
            <caption className="visually-hidden">{t('compareTitle')}</caption>
            <thead>
              <tr>
                <td></td>
                {state.ds.map((d) => (
                  <th scope="col" key={d.id}>
                    <span className="compare-name">{d.name}</span>
                    <button type="button" className="link-btn small" data-cmp-remove={d.id} aria-label={t('removeFromCompareX', { n: d.name })}
                      onClick={() => app.toggleCompare(d.id, false)}>{t('remove')}</button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, fn]) => (
                <tr key={label}><th scope="row">{label}</th>{state.ds!.map((d) => <td key={d.id}>{fn(d)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </dialog>
  );
}
