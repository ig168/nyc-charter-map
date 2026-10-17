import React, { useEffect, useRef } from 'react';
import { useApp } from './App';
import { lang, t } from './lib';

export function TopBar() {
  const app = useApp();
  const { user, saved, view, menuOpen, setMenuOpen } = app;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    (menuRef.current?.querySelector('.menu__item') as HTMLElement | null)?.focus();
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('#user')) setMenuOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpen, setMenuOpen]);

  const avatar = user && user.picture && /^https:\/\/lh3\.googleusercontent\.com\//.test(user.picture)
    ? <img src={user.picture} alt="" referrerPolicy="no-referrer" />
    : (user?.name || '?').trim().charAt(0).toUpperCase();

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label={t('homeLabel')}>
        <img src="/favicon.svg" alt="" width={30} height={30} />
        <span className="brand__name">{t('appName')}</span>
      </a>
      <nav className="topnav" aria-label={t('mainNav')}>
        <button type="button" className={`topnav__btn${view === 'explore' ? ' is-active' : ''}`} id="nav-explore" aria-current={view === 'explore' ? 'page' : undefined} onClick={() => app.showExplore()}>
          {t('navExplore')}
        </button>
        <button type="button" className={`topnav__btn${view === 'my' ? ' is-active' : ''}`} id="nav-my" aria-current={view === 'my' ? 'page' : undefined} onClick={app.showMy}>
          <span>{t('navMySchools')}</span>
          <span className="badge" id="saved-count" hidden={!saved.size}>{saved.size}</span>
        </button>
      </nav>
      <div className="topbar__right">
        <button type="button" className="lang-btn" id="lang-toggle" lang={lang() === 'es' ? 'en' : 'es'} aria-label={t('langToggleLabel')} onClick={app.toggleLang}>
          {lang() === 'es' ? 'EN' : 'ES'}
        </button>
        <button type="button" className="btn btn--gold btn--sm" id="signin-btn" hidden={!!user} onClick={() => app.openSignIn('header')}>
          {t('signIn')}
        </button>
        <div className="user" id="user" hidden={!user}>
          <button
            className="user__button" id="user-button" type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t('accountMenu')}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
          >
            <span className="avatar" id="user-avatar" aria-hidden="true">{user ? avatar : null}</span>
            <span className="user__name" id="user-name">{user ? user.name.split(' ')[0] : ''}</span>
          </button>
          <div className="menu" id="user-menu" role="menu" hidden={!menuOpen} ref={menuRef}>
            <div className="menu__header"><strong id="menu-name">{user?.name}</strong><span className="muted" id="menu-email">{user?.email}</span></div>
            <button className="menu__item" role="menuitem" type="button" id="menu-my" onClick={() => { setMenuOpen(false); app.showMy(); }}>{t('navMySchools')}</button>
            <button className="menu__item" role="menuitem" type="button" id="logout" onClick={() => { setMenuOpen(false); app.signOut(); }}>{t('signOut')}</button>
          </div>
        </div>
      </div>
    </header>
  );
}
