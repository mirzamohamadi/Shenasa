/*
 * app.js — router, authentication bootstrap, theming and app shell.
 *
 * Loads last; orchestrates config.js, store.js, auth.js and pages.js.
 */
(function (global) {
  'use strict';

  var doc = function () { return global.document; };
  function esc(s) { return global.Ui.esc(s); }
  function t(k, v) { return global.t(k, v); }

  var App = {};

  // ----------------------------------------------------------------------
  // Theming
  // ----------------------------------------------------------------------
  var autoThemeQuery = null;

  App.applyTheme = function (theme) {
    var mode = theme || global.ShenaConfig.theme();
    var applied = mode;
    if (mode === 'auto') {
      applied = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
      autoThemeQuery = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
      if (autoThemeQuery && !autoThemeQuery._shenasaBound) {
        autoThemeQuery._shenasaBound = true;
        var listener = function () {
          if (global.ShenaConfig.theme() === 'auto') App.applyTheme('auto');
        };
        if (autoThemeQuery.addEventListener) autoThemeQuery.addEventListener('change', listener);
        else if (autoThemeQuery.addListener) autoThemeQuery.addListener(listener);
      }
    }
    doc().documentElement.setAttribute('data-theme', applied);
  };

  // ----------------------------------------------------------------------
  // Navigation definition (RBAC-gated UI only; server enforces real authZ)
  // ----------------------------------------------------------------------
  function navItems() {
    // Only pages backed by REAL Kanidm 1.10 endpoints are listed. Kanidm
    // has no REST API for reading the audit log, invitations, or managing
    // other sessions — dead menu items for them were removed.
    var items = [
      { hash: '#/dashboard', label: t('nav.dashboard'), show: true },
      { hash: '#/users', label: t('nav.users'), show: global.Store.canManagePeople() || global.Store.canReadPii() },
      { hash: '#/groups', label: t('nav.groups'), show: global.Store.canManageGroups() || global.Store.canEditGroupMembers() || global.Store.canManagePeople() },
      { hash: '#/recycle', label: t('nav.recycle'), show: global.Store.canRecycleBin() },
      { hash: '#/sessions', label: t('nav.sessions'), show: true },
      { hash: '#/profile', label: t('nav.profile'), show: true },
      { hash: '#/settings', label: t('nav.settings'), show: true }
    ];
    return items;
  }

  // ----------------------------------------------------------------------
  // Views
  // ----------------------------------------------------------------------
  function show(id) {
    var login = doc().getElementById('login-root');
    var app = doc().getElementById('app-root');
    if (login) login.classList.toggle('hidden', id !== 'login');
    if (app) app.classList.toggle('hidden', id !== 'app');
  }

  function renderLogin(msg, passkeyStep) {
    stopIdleWatch();
    show('login');
    var root = doc().getElementById('login-root');
    if (!root) return;
    var cfg = global.SHENASA_CONFIG;
    var missingApi = !global.ShenaConfig.apiUrl();
    var passkeyOk = global.Auth.webauthnSupported();

    var actions;
    if (missingApi) {
      actions = '<div class="field"><label class="label" for="login-api-url">' + esc(t('settings.api')) + '</label>' +
        '<input class="input" id="login-api-url" name="apiUrl" placeholder="https://idm.example.com/v1"/>' +
        '<div class="help">' + esc(t('login.missing.api')) + '</div></div>' +
        '<button class="btn btn-primary btn-block" data-login-save-api>' + esc(t('common.save')) + '</button>';
    } else if (passkeyStep) {
      // Kanidm's stepped /v1/auth needs the account name to look up which
      // mechanisms are available, so passkey sign-in asks for it first.
      actions = '<form data-passkey-form novalidate>' +
        '<div class="field"><label class="label" for="login-pk-username">' + esc(t('login.passkey.username')) + '</label>' +
        '<input class="input" id="login-pk-username" name="pk-username" autocomplete="username webauthn" ' +
        'placeholder="' + esc(t('login.passkey.username.ph')) + '"/></div>' +
        '<button type="submit" class="btn btn-primary btn-block">' + esc(t('login.passkey.continue')) + '</button>' +
        '<button type="button" class="btn btn-block" data-passkey-back>' + esc(t('common.back')) + '</button></form>';
    } else {
      actions = '<button class="btn btn-primary btn-block" data-login-sso>' + esc(t('login.sso')) + '</button>' +
        '<button class="btn btn-block" data-login-passkey ' + (passkeyOk ? '' : 'disabled') + '>' + esc(t('login.passkey')) + '</button>' +
        (passkeyOk ? '' : '<p class="help">' + esc(t('login.passkey.unsupported')) + '</p>') +
        '<p class="login-issuer"><span class="muted">' + esc(t('login.issuer')) + ':</span> ' +
        '<code>' + esc(global.ShenaConfig.oauthBase()) + '</code></p>';
    }

    var html = '<main class="login-wrap">' +
      '<div class="login-card">' +
      '<div class="login-brand"><span class="brand-mark" aria-hidden="true">S</span>' +
      '<h1 class="brand-name">' + esc(t('app.title')) + '</h1>' +
      '<p class="brand-sub">' + esc(t('app.subtitle')) + '</p></div>' +
      (msg ? '<p class="login-msg">' + esc(msg) + '</p>' : '') +
      actions +
      '</div></main>';
    root.innerHTML = html;

    var sso = root.querySelector('[data-login-sso]');
    if (sso) {
      sso.addEventListener('click', async function () {
        sso.disabled = true;
        sso.textContent = t('login.connecting');
        try {
          await global.Auth.startSsoLogin();
        } catch (err) {
          sso.disabled = false;
          sso.textContent = t('login.sso');
          global.Ui.toast(err && err.message ? err.message : String(err), 'error');
        }
      });
    }
    var pk = root.querySelector('[data-login-passkey]');
    if (pk && passkeyOk) {
      pk.addEventListener('click', function () { renderLogin(msg, true); });
    }
    var pkForm = root.querySelector('[data-passkey-form]');
    if (pkForm) {
      var pkUser = pkForm.querySelector('#login-pk-username');
      var pkSubmit = pkForm.querySelector('button[type=submit]');
      if (pkUser && pkUser.focus) pkUser.focus();
      pkForm.addEventListener('submit', async function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        var username = pkUser && pkUser.value ? pkUser.value.trim() : '';
        if (!username) {
          global.Ui.toast(t('login.passkey.username.required'), 'error');
          return;
        }
        pkSubmit.disabled = true;
        pkSubmit.textContent = t('login.connecting');
        try {
          await global.Auth.passkeyLogin(username);
          successRoute();
        } catch (err) {
          pkSubmit.disabled = false;
          pkSubmit.textContent = t('login.passkey.continue');
          global.Ui.toast(err && err.message ? err.message : String(err), 'error');
        }
      });
      var pkBack = pkForm.querySelector('[data-passkey-back]');
      if (pkBack) pkBack.addEventListener('click', function () { renderLogin(msg, false); });
    }
    var saveApi = root.querySelector('[data-login-save-api]');
    if (saveApi) {
      saveApi.addEventListener('click', function () {
        var v = root.querySelector('#login-api-url').value.trim();
        if (!v) { global.Ui.toast('API URL is required.', 'error'); return; }
        global.ShenaConfig.save({ apiUrl: v });
        global.SHENASA_CONFIG.apiUrl = v;
        renderLogin();
      });
    }
  }

  // Read-only vs read-write session chip in the top bar. Interactive
  // Kanidm logins are privilege-capable (AccessScope::ReadOnly) until a
  // /v1/reauth step-up grant a ~10-minute write window — the chip makes
  // that state visible instead of letting writes fail with a bare 403.
  function scopeChipHtml() {
    var canW = global.Store.canWriteNow();
    if (canW) {
      var until = new Date(global.Store.writeExpiry * 1000);
      var hh = String(until.getHours()).padStart(2, '0');
      var mm = String(until.getMinutes()).padStart(2, '0');
      return '<span class="badge badge-ok topbar-scope" data-scope-chip title="' +
        esc(t('session.rw.hint')) + '">✍ ' + esc(t('session.rw.until') + ' ' + hh + ':' + mm) + '</span>';
    }
    return '<button class="badge badge-warn topbar-scope topbar-scope-btn" data-scope-chip data-stepup title="' +
      esc(t('session.ro.hint')) + '">🔒 ' + esc(t('session.ro.unlock')) + '</button>';
  }

  function bindStepUp(root) {
    var btn = root.querySelector('[data-stepup]');
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.textContent = esc(t('session.stepup.busy'));
      try {
        await global.Auth.stepUp();
        global.Ui.toast(t('session.stepup.ok'), 'success');
      } catch (err) {
        global.Ui.toast((err && err.message) || t('session.stepup.fail'), 'error');
      }
      // Re-render the shell so the chip and page reflect the new state.
      route();
    });
  }

  function renderShell() {
    // The app shell only exists post-sign-in, so rendering it must also
    // reveal it. index.html starts with BOTH roots hidden; show() had only
    // been called from the pre-login settings route, which left a fully
    // rendered but invisible app (blank white page with working 200s).
    show('app');
    var root = doc().getElementById('app-root');
    var user = global.Store.user || {};
    var items = navItems();
    var hash = global.location.hash || '#/dashboard';

    var nav = '<nav class="sidebar" aria-label="Primary"><ul class="nav-list">';
    for (var i = 0; i < items.length; i++) {
      if (!items[i].show) continue;
      var active = hash === items[i].hash || (items[i].hash !== '#/dashboard' && hash.indexOf(items[i].hash) === 0);
      nav += '<li><a class="nav-link' + (active ? ' active' : '') + '" href="' + items[i].hash + '"' +
        (active ? ' aria-current="page"' : '') + '>' + esc(items[i].label) + '</a></li>';
    }
    nav += '</ul>' +
      '<div class="sidebar-foot"><a class="nav-link" href="#/" data-signout>' + esc(t('nav.signout')) + '</a></div>' +
      '</nav>';

    var topbar = '<header class="topbar">' +
      '<button class="btn btn-ghost btn-icon nav-toggle" data-nav-toggle aria-label="Toggle navigation" aria-expanded="false">☰</button>' +
      '<span class="topbar-brand">' + esc(t('app.title')) + '</span>' +
      '<span class="toolbar-spacer"></span>' +
      scopeChipHtml() +
      '<span class="topbar-user">' + esc(user.display_name || user.name || '') + '</span>' +
      '</header>';

    root.innerHTML = topbar + '<div class="layout">' + nav + '<main class="content" id="view" tabindex="-1"></main></div>';

    var toggle = root.querySelector('[data-nav-toggle]');
    toggle.addEventListener('click', function () {
      var open = doc().body.classList.toggle('sidebar-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    bindStepUp(root);
    // Each route = user activity; (re)arm the idle watchdog here.
    bindIdleEvents();
    armIdleWatch();
    var signout = root.querySelector('[data-signout]');
    signout.addEventListener('click', async function (e) {
      e.preventDefault();
      var res;
      try {
        res = await global.Auth.signOut();
      } catch (err) {
        res = null;
      }
      // Cross-origin API (two-domain topology): only a top-level navigation
      // can carry the Kanidm web-session cookie to /ui/logout. The browser
      // lands on Kanidm's own login page, truly signed out.
      if (res && res.logoutUrl && !res.serverLogout) {
        global.location.assign(res.logoutUrl);
        return;
      }
      renderLogin(res && res.serverLogout ? t('login.signedout') : undefined);
    });
    var links = root.querySelectorAll('.nav-link');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', function () {
        doc().body.classList.remove('sidebar-open');
      });
    }
  }

  // ----------------------------------------------------------------------
  // Router
  // ----------------------------------------------------------------------
  function route() {
    var hash = global.location.hash || '#/dashboard';
    var path = hash.replace(/^#\/?/, '');
    var seg = path.split('/').map(decodeURIComponent);

    if (seg[0] === 'login') { renderLogin(); return; }
    // Every application page — Settings included — requires an
    // authenticated session. (Settings used to be reachable pre-login,
    // which let anyone with the URL view and change the connection
    // configuration without authenticating.) The chicken-and-egg case
    // "no API URL configured yet" is still handled by the inline apiUrl
    // rescue on the login page itself.
    if (!global.Store.isSignedIn()) { renderLogin(); return; }

    renderShell();
    var main = doc().getElementById('view');
    main.removeAttribute('data-page');

    switch (seg[0]) {
      case '':
      case 'dashboard': return void global.Pages.dashboard(main);
      case 'users':
        return void (seg[1] ? global.Pages.userDetail(main, seg[1]) : global.Pages.users(main));
      case 'groups':
        return void (seg[1] ? global.Pages.groupDetail(main, seg[1]) : global.Pages.groups(main));
      case 'recycle': return void global.Pages.recycle(main);
      case 'sessions': return void global.Pages.sessions(main);
      case 'profile': return void global.Pages.profile(main);
      case 'settings': return void global.Pages.settings(main);
      default:
        global.location.hash = '#/dashboard';
    }
  }

  function view() { return doc().getElementById('view'); }

  // ---- Idle sign-out ---------------------------------------------------
  // Settings page sets idleTimeoutMin (0 = disabled). The watchdog tracks
  // the last USER-GENERATED input event and, once the inactivity window
  // elapses, performs the full sign-out (local state + Kanidm server
  // session via Auth.signOut) — a lock screen that would silently keep
  // SSO able to re-authenticate is not acceptable for admin tooling.
  var IDLE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  var IDLE_THROTTLE_MS = 5000;
  var idleTimer = null;
  var idleLastAt = 0;
  var idleWatching = false;

  function idleMinutes() {
    return (global.ShenaConfig && global.ShenaConfig.idleTimeoutMin)
      ? global.ShenaConfig.idleTimeoutMin() : 0;
  }

  function stopIdleWatch() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function scheduleIdleCheck() {
    stopIdleWatch();
    var mins = idleMinutes();
    if (!mins || !global.Store.isSignedIn()) return;
    // Wake at most once a minute; the deadline itself comes from idleLastAt.
    var deadline = idleLastAt + mins * 60000;
    var wait = Math.max(1000, Math.min(deadline - Date.now(), 60000));
    idleTimer = setTimeout(onIdleTick, wait);
  }

  function onIdleTick() {
    idleTimer = null;
    var mins = idleMinutes();
    if (!mins || !global.Store.isSignedIn()) return;
    if (Date.now() - idleLastAt >= mins * 60000) {
      idleSignOut();
      return;
    }
    scheduleIdleCheck();
  }

  async function idleSignOut() {
    var res;
    try { res = await global.Auth.signOut(); } catch (e) { res = null; }
    // Cross-origin API (two-domain topology): only a top-level navigation
    // can carry the Kanidm session cookie to /ui/logout.
    if (res && res.logoutUrl && !res.serverLogout) {
      global.location.assign(res.logoutUrl);
      return;
    }
    stopIdleWatch();
    renderLogin(t('login.idleout'));
  }

  function armIdleWatch() {
    idleLastAt = Date.now();
    scheduleIdleCheck();
  }

  function onIdleActivity() {
    // Throttled timestamp update only — re-scheduling happens in onIdleTick.
    if (!idleLastAt || Date.now() - idleLastAt < IDLE_THROTTLE_MS) return;
    idleLastAt = Date.now();
  }

  function bindIdleEvents() {
    if (idleWatching) return;
    idleWatching = true;
    for (var i = 0; i < IDLE_EVENTS.length; i++) {
      doc().addEventListener(IDLE_EVENTS[i], onIdleActivity, { passive: true });
    }
  }

  function successRoute() {
    if (!global.location.hash || global.location.hash === '#/login' || global.location.hash === '#/') {
      global.location.hash = '#/dashboard';
    } else {
      route();
    }
  }

  // ----------------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------------
  async function boot() {
    App.applyTheme();
    global.Store.restore();
    // Re-hydrate the server-side write window after a page reload (not
    // persisted in sessionStorage — re-fetched from /v1/self/_uat).
    if (global.Store.isSignedIn()) {
      try { await global.Auth.refreshWriteScope(); } catch (e) { /* read-only */ }
    }

    var params = global.ShenaConfig.parseQuery(global.location ? global.location.search : '');
    if (params.code) {
      try {
        await global.Auth.handleRedirectCallback(global.location.search);
        // Clean the sensitive query parameters from the address bar.
        if (global.history && global.history.replaceState) {
          global.history.replaceState(null, '', global.location.pathname + (global.location.hash || '#/dashboard'));
        }
        global.Ui.toast('Signed in.', 'success');
      } catch (err) {
        if (global.history && global.history.replaceState) {
          global.history.replaceState(null, '', global.location.pathname + '#/login');
        }
        renderLogin(err && err.message ? err.message : String(err));
        global.addEventListener('hashchange', route);
        return;
      }
    }
    global.addEventListener('hashchange', route);
    route();
  }

  App.route = route;
  App.renderLogin = renderLogin;
  App.boot = boot;
  App.armIdleWatch = armIdleWatch;
  global.App = App;

  if (doc().readyState === 'loading') {
    doc().addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
