/*
 * config.js — public runtime configuration for Shenasa.
 *
 * Everything here is PUBLIC (no secrets — the OAuth2 client is a public
 * client using PKCE). Defaults ship in this file; they can be overridden:
 *   1. at runtime via URL query parameters
 *      (?apiUrl=&oidcClientId=&oidcScope=&oidcRedirectUri=&theme=), or
 *   2. persistently from the Settings page (stored in localStorage).
 *
 * URL query parameters take precedence over localStorage, which takes
 * precedence over the shipped defaults.
 *
 * Attaches:
 *   window.SHENASA_CONFIG  — the effective merged configuration object
 *   window.ShenaConfig     — helpers (get/save/reset/oauthBase/resolve)
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    // Base URL of the Kanidm REST API. MUST end in /v1.
    apiUrl: 'https://idm.example.com/v1',
    // Public OIDC client (Authorization Code + PKCE, no secret).
    oidcClientId: 'shenasa_admin_ui',
    /* Request Kanidm's built-in "groups" scope too: group SPNs in the
       token are what Shenasa maps to UI roles (RBAC). */
    oidcScope: 'openid profile email groups',
    // Must be registered as an allowed redirect/landing URL on the client.
    // For single-origin deployments use the Shenasa origin, e.g.
    // https://idm.example.com/admin/ (or the value Kanidm expects, such as
    // https://idm.example.com/oauth2/redirect when proxied behind Kanidm).
    oidcRedirectUri: 'https://idm.example.com/oauth2/redirect',
    // 'light' | 'dark' | 'auto'
    theme: 'light',
    // Minutes of inactivity before an automatic sign-out. 0 = disabled
    // (the browser may keep the session until logout/server expiry).
    idleTimeoutMin: 0
  };

  var ALLOWED_KEYS = [
    'apiUrl', 'oidcClientId', 'oidcScope', 'oidcRedirectUri', 'theme', 'idleTimeoutMin'
  ];
  var STORAGE_KEY = 'shenasa.config';

  function parseQuery(search) {
    var out = {};
    if (!search) return out;
    var q = search.charAt(0) === '?' ? search.slice(1) : search;
    if (!q) return out;
    var pairs = q.split('&');
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var kv = pairs[i].split('=');
      var key = decodeURIComponent(kv[0] || '');
      var val = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      out[key] = val;
    }
    return out;
  }

  function pickAllowed(source) {
    var out = {};
    if (!source) return out;
    for (var i = 0; i < ALLOWED_KEYS.length; i++) {
      var k = ALLOWED_KEYS[i];
      if (typeof source[k] === 'string' && source[k] !== '') out[k] = source[k];
    }
    if (out.theme && out.theme !== 'light' && out.theme !== 'dark' && out.theme !== 'auto') {
      delete out.theme;
    }
    return out;
  }

  function readStorage(storage) {
    try {
      var raw = (storage || global.localStorage).getItem(STORAGE_KEY);
      if (!raw) return {};
      return pickAllowed(JSON.parse(raw));
    } catch (e) {
      return {};
    }
  }

  // Pure merge: defaults < localStorage overrides < URL query overrides.
  function resolve(storageOverrides, searchString) {
    var merged = {};
    var k;
    for (k in DEFAULTS) merged[k] = DEFAULTS[k];
    var fromStorage = pickAllowed(storageOverrides);
    for (k in fromStorage) merged[k] = fromStorage[k];
    var fromQuery = pickAllowed(parseQuery(searchString));
    for (k in fromQuery) merged[k] = fromQuery[k];
    return merged;
  }

  // Strip any trailing slashes from a URL.
  function stripTrailingSlashes(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  // The OAuth/OIDC and WebAuthn session endpoints live at the ORIGIN ROOT,
  // NOT under /v1. Compute that base by stripping a trailing "/v1" from the
  // configured API URL.
  function oauthBaseOf(apiUrl) {
    var base = stripTrailingSlashes(apiUrl);
    if (/\/v1$/i.test(base)) base = base.slice(0, -3);
    return stripTrailingSlashes(base);
  }

  var Config = {
    DEFAULTS: DEFAULTS,
    keys: ALLOWED_KEYS.slice(),
    storageKey: STORAGE_KEY,
    parseQuery: parseQuery,
    resolve: resolve,
    oauthBaseOf: oauthBaseOf,

    // Load the effective config for this page load.
    load: function (searchString) {
      return resolve(readStorage(), searchString != null
        ? searchString
        : (global.location ? global.location.search : ''));
    },

    // Persist overrides to localStorage (Settings page). Only allowed keys
    // are written; values remain public — never store secrets.
    save: function (map) {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(pickAllowed(map)));
    },
    reset: function () {
      global.localStorage.removeItem(STORAGE_KEY);
    },
    storedOverrides: function () {
      return readStorage();
    },

    // Effective-value helpers (read from window.SHENASA_CONFIG).
    get: function (key) { return global.SHENASA_CONFIG[key]; },
    apiUrl: function () { return stripTrailingSlashes(global.SHENASA_CONFIG.apiUrl || ''); },
    oauthBase: function () { return oauthBaseOf(global.SHENASA_CONFIG.apiUrl || ''); },
    clientId: function () { return global.SHENASA_CONFIG.oidcClientId; },
    scope: function () { return global.SHENASA_CONFIG.oidcScope; },
    redirectUri: function () { return global.SHENASA_CONFIG.oidcRedirectUri; },
    theme: function () { return global.SHENASA_CONFIG.theme || 'light'; },
    // Idle sign-out in whole minutes (0 = disabled). Clamped to sane bounds.
    idleTimeoutMin: function () {
      var v = parseFloat(global.SHENASA_CONFIG.idleTimeoutMin, 10);
      if (!isFinite(v) || v <= 0) return 0;
      return Math.min(1440, v);
    }
  };

  global.ShenaConfig = Config;
  global.SHENASA_CONFIG = Config.load();
})(typeof window !== 'undefined' ? window : globalThis);
