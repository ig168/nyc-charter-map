import React, { useEffect, useRef } from 'react';
import { useApp } from './App';
import type { SchoolDetail, Verification } from './types';
import { BKEY, boroughName, core, distanceText, fmtDate, fmtNum, gradeLabel, hostOf, lang, levelName, MOBILE, safeUrl, statusName, t, track } from './lib';

const NA = () => <span className="na">{t('notAvailable')}</span>;

function Row({ label, children }: { label: string; children?: React.ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false;
  return (
    <div className="dl__row">
      <dt>{label}</dt>
      <dd>{empty ? NA() : children}</dd>
    </div>
  );
}

function Ext({ href, out, children, className }: { href: string; out: string; children: React.ReactNode; className?: string }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" data-out={out}>
      {children} <span aria-hidden="true">↗</span>
      <span className="visually-hidden">{t('opensNewTab')}</span>
    </a>
  );
}

/** Cross-source verification for one campus: which independent sources list it, license, location check, flags. */
function VerificationPanel({ v }: { v: Verification | null }) {
  if (!v) return null;
  const listings = v.confirmedBy.filter((x) => !/GeoSearch/.test(x));
  return (
    <div className="ver" id="verification">
      <p className="ver__head"><strong>{t('verTitle')}</strong> {t('verCount', { n: listings.length })}</p>
      <ul className="ver__list small">
        {listings.map((x) => <li key={x}>✓ {x}</li>)}
        {v.license ? <li>{t('verLicense', { name: v.license.name, auth: v.license.authorizer, year: v.license.opened })}</li> : null}
        {v.geocoded ? <li>{t('verLocation')}</li> : null}
        {v.flags.map((f) => <li key={f} className="ver__flag">{f}</li>)}
      </ul>
    </div>
  );
}

function Body({ d }: { d: SchoolDetail }) {
  const app = useApp();
  const s = app.byId.get(d.id) || d;
  const key = BKEY[s.borough];
  const saved = app.saved.has(s.id);
  const item = app.saved.get(s.id);
  const a = d.admissions;
  const apply = safeUrl(a.applyUrl);
  const website = safeUrl(d.contact.website);
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${d.address}, ${d.borough}, NY ${d.zip || ''}`)}`;
  const streetView = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${s.lat},${s.lng}`;
  const phoneHref = d.contact.phone ? `tel:+1${d.contact.phone.replace(/\D/g, '')}` : null;
  const dist = distanceText(app.origin, s);

  const zoom = () => {
    if (MOBILE.matches) app.setMobile('map');
    app.mapApi.current?.flyToSchool(s, 17);
    setTimeout(() => app.mapApi.current?.openPinCard(s.id), 600);
  };

  return (
    <>
      <header className={`detail__head detail__head--${key}`}>
        <button type="button" className="detail__close" data-action="close" onClick={app.closeDetail}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{t('backToResults')}</span>
        </button>
        <p className="detail__eyebrow">
          <i className={`swatch swatch--${key}`} aria-hidden="true"></i>
          {boroughName(s.borough)}{s.district ? ` · ${t('districtN', { d: s.district })}` : ''}{dist ? ` · ${dist}` : ''}
        </p>
        <h2 className="detail__title" id="detail-title">{d.name}</h2>
        {d.network ? <p className="detail__network">{d.network}</p> : null}
        <div className="detail__tags">
          <span className="tag">{t('gradesX', { g: gradeLabel(s.grades) })}</span>
          {core.levelsOf(s.grades).map((l: string) => <span key={l} className="tag tag--soft">{levelName(l)}</span>)}
        </div>
      </header>

      <div className="detail__actions">
        {apply ? <Ext className="btn btn--primary" href={apply} out="apply">{t('applyBtn')}</Ext> : null}
        <button type="button" className={`btn btn--ghost${saved ? ' is-saved' : ''}`} data-action="save" aria-pressed={saved} onClick={() => app.toggleSave(s.id, 'detail')}>
          {saved ? t('savedBtnStar') : t('saveBtnStar')}
        </button>
        <Ext className="btn btn--ghost" href={directions} out="directions">{t('directions')}</Ext>
        <Ext className="btn btn--ghost" href={streetView} out="streetview">{t('streetView')}</Ext>
        <button type="button" className="btn btn--ghost" data-action="zoom" onClick={zoom}>{t('showOnMap')}</button>
      </div>
      {item ? (
        <p className="detail__tracker">
          {t('inMySchools')} · {t('statusLabel')}: <strong>{statusName(item.status)}</strong> ·{' '}
          <button type="button" className="link-btn" data-action="my" onClick={app.showMy}>{t('openMySchools')}</button>
        </p>
      ) : null}

      <section className="detail__section" aria-labelledby="sec-overview">
        <h3 id="sec-overview">{t('secOverview')}</h3>
        <dl className="dl">
          <Row label={t('network')}>{d.network}</Row>
          <Row label={t('gradesServed')}>{gradeLabel(s.grades)}</Row>
          <Row label={t('entryGrades')}>{s.entryGrades.length ? s.entryGrades.map((g: string) => core.gradeName(g, lang())).join(', ') : null}</Row>
          <Row label={t('enrollment')}>{d.enrollment != null ? t('enrollmentN', { n: fmtNum(d.enrollment) }) : null}</Row>
          <Row label={t('yearFounded')}>{d.yearFounded ? String(d.yearFounded) : null}</Row>
          <Row label={t('mission')}>{d.mission ? <>{d.mission} <span className="muted small">{t('missionNote')}</span></> : null}</Row>
        </dl>
      </section>

      <section className="detail__section" aria-labelledby="sec-adm">
        <h3 id="sec-adm">{t('secAdmissions')}{a.cycle ? <> <span className="muted small">{a.cycle}</span></> : null}</h3>
        <dl className="dl">
          <Row label={t('howToApply')}>{a.howToApply}</Row>
          <Row label={t('eligibility')}>{a.eligibility}</Row>
          <Row label={t('lotteryPrefs')}>{a.lotteryPreferences}</Row>
          <Row label={t('applicationOpens')}>{a.applicationOpen ? fmtDate(a.applicationOpen) : null}</Row>
          <Row label={t('applicationDeadline')}>
            {a.applicationDeadline ? <><strong>{fmtDate(a.applicationDeadline)}</strong>{a.deadlineNote ? <><br /><span className="muted small">{a.deadlineNote}</span></> : null}</> : null}
          </Row>
          <Row label={t('lottery')}>{a.lotteryDate ? fmtDate(a.lotteryDate) : a.lotteryNote}</Row>
          <Row label={t('applyLink')}>{apply ? <Ext href={apply} out="apply">{a.applyUrlLabel || t('applyBtn')}</Ext> : null}</Row>
        </dl>
      </section>

      <section className="detail__section" aria-labelledby="sec-contact">
        <h3 id="sec-contact">{t('secContact')}</h3>
        <dl className="dl">
          <Row label={t('address')}>{`${d.address}, ${boroughName(d.borough)}, NY ${d.zip || ''}`.trim()}</Row>
          <Row label={t('phone')}>{phoneHref ? <a href={phoneHref} data-out="phone">{d.contact.phone}</a> : null}</Row>
          <Row label={t('email')}>{d.contact.email ? <a href={`mailto:${d.contact.email}`} data-out="email">{d.contact.email}</a> : null}</Row>
          <Row label={t('website')}>{website ? <Ext href={website} out="website">{hostOf(website)}</Ext> : null}</Row>
          <Row label={t('directions')}><Ext href={directions} out="directions">{t('openInMaps')}</Ext></Row>
        </dl>
        {s.sharedBuilding ? <p className="note">{t('sharedBuilding')}</p> : null}
      </section>

      <section className="detail__section" aria-labelledby="sec-costs">
        <h3 id="sec-costs">{t('secCosts')}</h3>
        <dl className="dl">
          <Row label={t('tuition')}>{d.costs.tuitionFree ? <strong>{t('tuitionFree')}</strong> : null}</Row>
          <Row label={t('uniform')}>{d.costs.uniform}</Row>
          <Row label={t('afterCare')}>{d.costs.afterCare}</Row>
          <Row label={t('meals')}>{d.costs.meals}</Row>
          <Row label={t('transportation')}>{d.costs.transportation}</Row>
        </dl>
      </section>

      <section className="detail__section detail__section--source" aria-labelledby="sec-source">
        <h3 id="sec-source">{t('secSource')}</h3>
        <p className="small"><strong>{t('lastVerified')}:</strong> {fmtDate(d.lastVerified)}</p>
        <VerificationPanel v={d.verification} />
        <ul className="sources small">{String(d.source).split('; ').map((x, i) => <li key={i}>{x}</li>)}</ul>
        <p className="small muted">{t('dataCaveat')}</p>
      </section>
    </>
  );
}

export function Detail() {
  const app = useApp();
  const ref = useRef<HTMLElement>(null);
  const id: string | null = app.selectedId;
  const d = id ? app.details.get(id) : undefined;
  const ready = d && d !== 'error';

  // Focus the back button and scroll to the top once a school's details arrive
  useEffect(() => {
    if (!ready || !ref.current) return;
    (ref.current.querySelector('.detail__close') as HTMLElement | null)?.focus({ preventScroll: true });
    ref.current.scrollTop = 0;
  }, [ready, id]);

  return (
    <article className="detail" id="detail" tabIndex={-1} hidden={!id} ref={ref}
      onClick={(e) => {
        const out = (e.target as HTMLElement).closest('a[data-out]') as HTMLElement | null;
        if (out && id) track('outbound_link_clicked', { school_id: id, type: out.dataset.out });
      }}>
      {!id ? null : d === 'error' ? (
        <div className="detail__error" role="alert">
          <p>{t('detailError')}</p>
          <button type="button" className="btn btn--ghost btn--sm" data-action="retry" onClick={() => app.retryDetail(id)}>{t('retry')}</button>
          <button type="button" className="link-btn" data-action="close" onClick={app.closeDetail}>{t('backToResults')}</button>
        </div>
      ) : ready ? (
        <Body d={d as SchoolDetail} />
      ) : (
        <div className="detail__loading" role="status">{t('loading')}</div>
      )}
    </article>
  );
}
