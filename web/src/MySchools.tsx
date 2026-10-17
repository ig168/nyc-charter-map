import React, { useState } from 'react';
import { useApp } from './App';
import type { SavedItem, SchoolSummary } from './types';
import { api, boroughName, core, fmtDate, fmtNum, gradeLabel, localToday, nextDeadlineText, NOTE_MAX, statusName, STATUSES, t } from './lib';

function MyCard({ s, item }: { s: SchoolSummary; item: SavedItem }) {
  const app = useApp();
  const [note, setNote] = useState(item.note || '');
  const [err, setErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const len = [...note].length;
  const over = len > NOTE_MAX;

  const saveNote = async () => {
    setErr('');
    if (over) return setErr(t('noteTooLong', { max: fmtNum(NOTE_MAX) }));
    try {
      await app.updateTracker(s.id, { note });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const setStatus = async (status: string) => {
    try {
      await app.updateTracker(s.id, { status });
    } catch (e: any) {
      app.toast(e.message, 'error');
    }
  };

  return (
    <li className="my-card" data-id={s.id}>
      <div className="my-card__head">
        <div>
          <h3 className="my-card__title">
            <button type="button" className="link-btn link-btn--title" data-my="open" onClick={() => app.openDetail(s.id, { source: 'list' })}>{s.name}</button>
          </h3>
          <p className="my-card__meta">{[s.network, boroughName(s.borough), t('gradesX', { g: gradeLabel(s.grades) })].filter(Boolean).join(' · ')}</p>
          <p className="my-card__meta">
            {s.deadline ? nextDeadlineText(s) : t('noDeadline')}
            {s.phone ? <> · <a href={`tel:+1${s.phone.replace(/\D/g, '')}`}>{s.phone}</a></> : null}
          </p>
        </div>
        <div className="my-card__actions">
          <label className="cmp">
            <input type="checkbox" data-my="compare" checked={app.compare.has(s.id)} aria-label={t('compareX', { n: s.name })}
              onChange={(e) => { if (!app.toggleCompare(s.id, e.target.checked)) e.target.checked = false; }} />
            <span aria-hidden="true">{t('compareShort')}</span>
          </label>
          <button type="button" className="link-btn link-btn--danger" data-my="remove" aria-label={t('removeSchoolX', { n: s.name })} onClick={() => app.toggleSave(s.id, 'my_schools')}>
            {t('remove')}
          </button>
        </div>
      </div>
      <div className="my-card__track">
        <div className="field">
          <label htmlFor={`st-${s.id}`}>{t('statusLabel')}</label>
          <select id={`st-${s.id}`} data-my="status" value={item.status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((st) => <option key={st} value={st}>{statusName(st)}</option>)}
          </select>
        </div>
        <div className="field field--grow">
          <label htmlFor={`nt-${s.id}`}>{t('noteLabel')}</label>
          <textarea id={`nt-${s.id}`} data-my="note" rows={2} aria-describedby={`nc-${s.id}`} placeholder={t('notePlaceholder')} value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setErr([...e.target.value].length > NOTE_MAX ? t('noteTooLong', { max: fmtNum(NOTE_MAX) }) : '');
            }} />
          <div className="note-foot">
            <span className={`note-count${over ? ' is-over' : ''}`} id={`nc-${s.id}`}>{t('noteCount', { n: fmtNum(len), max: fmtNum(NOTE_MAX) })}</span>
            <button type="button" className="btn btn--ghost btn--sm" data-my="save-note" onClick={saveNote}>{savedFlash ? t('noteSavedShort') : t('saveNote')}</button>
          </div>
          <p className="field-error" data-note-error hidden={!err}>{err}</p>
        </div>
      </div>
    </li>
  );
}

function SharePanel() {
  const app = useApp();
  const create = async () => {
    try {
      const r = await api('/api/share', { method: 'POST', body: {} });
      app.setShare(`${location.origin}${r.path}`);
      requestAnimationFrame(() => (document.getElementById('share-url') as HTMLInputElement | null)?.select());
    } catch (e: any) {
      app.toast(e.message, 'error');
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(app.share);
      app.toast(t('copied'));
    } catch {
      (document.getElementById('share-url') as HTMLInputElement | null)?.select();
      app.toast(t('copyManually'));
    }
  };
  const stop = async () => {
    try {
      await api('/api/share', { method: 'DELETE', body: {} });
      app.setShare(null);
      app.toast(t('sharingOff'));
    } catch (e: any) {
      app.toast(e.message, 'error');
    }
  };
  return (
    <div id="share-panel">
      {app.share ? (
        <>
          <label htmlFor="share-url" className="small"><strong>{t('shareLinkLabel')}</strong></label>
          <div className="share-row">
            <input id="share-url" readOnly value={app.share} />
            <button type="button" className="btn btn--primary btn--sm" data-my="copy-share" onClick={copy}>{t('copy')}</button>
            <button type="button" className="link-btn" data-my="stop-share" onClick={stop}>{t('stopSharing')}</button>
          </div>
          <p className="small muted">{t('shareHelp')}</p>
        </>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" data-my="share" onClick={create}>{t('createShareLink')}</button>
      )}
    </div>
  );
}

export function MySchools() {
  const app = useApp();
  const show = app.view === 'my';
  const today = localToday();
  const list = show
    ? ([...app.saved.entries()] as [string, SavedItem][]).map(([id, item]) => ({ s: app.byId.get(id) as SchoolSummary, item })).filter((x) => x.s)
    : [];
  const { upcoming, past } = show ? core.deadlineList(list.map((x) => x.s), today) : { upcoming: [], past: [] };

  const deadlineItem = (d: any, i: number) => {
    const days = core.daysUntil(d.date, today);
    const when = d.past ? t('passed') : days === 0 ? t('today') : t('inNDays', { n: days });
    return (
      <li key={`${d.school.id}-${d.kind}-${i}`} className={`dl-item${d.past ? ' is-past' : ''}`}>
        <time dateTime={d.date}>{fmtDate(d.date)}</time>
        <span className="dl-item__what">
          {t(d.kind === 'lottery' ? 'lotteryFor' : 'deadlineFor')}{' '}
          <button type="button" className="link-btn" data-my="open-id" data-id={d.school.id} onClick={() => app.openDetail(d.school.id, { source: 'list' })}>{d.school.name}</button>
        </span>
        <span className={`tag ${d.past ? 'tag--muted' : 'tag--soft'}`}>{when}</span>
      </li>
    );
  };

  return (
    <section className="my" id="my-view" tabIndex={-1} hidden={!show} aria-label={t('navMySchools')}>
      {show ? (
        <div className="my__inner">
          <header className="my__head">
            <div>
              <h1 className="my__title">{t('navMySchools')}</h1>
              <p className="muted">{t('mySubtitle', { n: list.length })}</p>
            </div>
            <div className="my__actions">
              <a className={`btn btn--ghost btn--sm${list.length ? '' : ' is-disabled'}`} href="/api/saved.ics" download="charter-school-deadlines.ics"
                {...(list.length ? {} : { 'aria-disabled': 'true', tabIndex: -1 })}>{t('downloadIcs')}</a>
              <button type="button" className="btn btn--ghost btn--sm" data-my="compare-open" disabled={app.compare.size < 2} onClick={() => app.setCompareOpen(true)}>
                {t('compareN', { n: app.compare.size })}
              </button>
              <button type="button" className="btn btn--primary btn--sm" data-my="explore" onClick={() => app.showExplore()}>{t('findMore')}</button>
            </div>
          </header>
          {list.length ? (
            <>
              <div className="my__grid">
                <section className="panel" aria-labelledby="dl-title">
                  <h2 id="dl-title">{t('upcomingDeadlines')}</h2>
                  {upcoming.length ? <ol className="dl-list">{upcoming.map(deadlineItem)}</ol> : <p className="muted">{t('noUpcoming')}</p>}
                  {past.length ? (
                    <details className="past"><summary>{t('pastDeadlines', { n: past.length })}</summary><ol className="dl-list">{past.map(deadlineItem)}</ol></details>
                  ) : null}
                  <p className="small muted">{t('deadlineCaveat')}</p>
                </section>
                <section className="panel" aria-labelledby="share-title">
                  <h2 id="share-title">{t('shareTitle')}</h2>
                  <SharePanel />
                </section>
              </div>
              <ul className="my-list">{list.map((x) => <MyCard key={x.s.id} s={x.s} item={x.item} />)}</ul>
            </>
          ) : (
            <div className="empty empty--my">
              <p><strong>{t('myEmptyTitle')}</strong></p>
              <p className="muted">{t('myEmptyBody')}</p>
              <button type="button" className="btn btn--primary" data-my="explore" onClick={() => app.showExplore()}>{t('exploreSchools')}</button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
