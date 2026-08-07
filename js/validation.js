/*
 * validation.js — client-side form validation for Shenasa.
 *
 * Pure functions, no DOM access. Validators return { ok, message } and the
 * form-level helpers return { ok, errors: { field: message } }.
 * Client-side validation is a UX aid only; the Kanidm server always
 * re-validates authoritatively.
 */
(function (global) {
  'use strict';

  // Kanidm account/group name (iname) rules, verified against the v1.10.5
  // source: INAME_RE = ^[a-z][a-z0-9-_\.]{0,63}$ (server/lib/src/value.rs)
  // — must START with a lowercase letter, then letters, digits, '-', '_'
  // and '.'. Dots ARE allowed (e.g. firstname.lastname). The server also
  // rejects UUID-shaped names and the reserved names "root"/"dn=token"
  // (DISALLOWED_NAMES). The server lowercases names; we reject uppercase
  // up-front so the user sees the actual name they will get.
  var USERNAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;
  // Pragmatic RFC-5322-ish email check (not exhaustive by design).
  var EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  var ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

  function res(ok, message) { return { ok: ok, message: message || '' }; }

  function username(v) {
    if (typeof v !== 'string' || v.length === 0) return res(false, 'Username is required.');
    if (v.length > 64) return res(false, 'Username must be at most 64 characters.');
    if (v !== v.toLowerCase()) return res(false, 'Username must be lowercase (the server lowercases names).');
    if (!USERNAME_RE.test(v)) {
      return res(false, 'Username must start with a lowercase letter; then lowercase letters, digits, dots (.), hyphens (-) and underscores (_) are allowed.');
    }
    if (v === 'root' || v === 'dn=token') return res(false, 'This name is reserved by the server.');
    return res(true);
  }

  function displayName(v) {
    if (typeof v !== 'string' || v.trim().length === 0) return res(false, 'Display name is required.');
    if (v.length > 128) return res(false, 'Display name must be at most 128 characters.');
    return res(true);
  }

  function email(v, required) {
    if (typeof v !== 'string' || v.trim() === '') {
      return required ? res(false, 'Email address is required.') : res(true);
    }
    if (v.length > 254) return res(false, 'Email address is too long.');
    if (!EMAIL_RE.test(v)) return res(false, 'Invalid email address format.');
    return res(true);
  }

  // Accepts empty (optional), "YYYY-MM-DD" or an RFC 3339 timestamp.
  function isoDate(v, label) {
    if (typeof v !== 'string' || v.trim() === '') return res(true);
    if (!ISO_DATE_RE.test(v.trim())) {
      return res(false, (label || 'Date') + ' must be a valid date (YYYY-MM-DD).');
    }
    var d = new Date(v.trim());
    if (isNaN(d.getTime())) return res(false, (label || 'Date') + ' is not a valid date.');
    return res(true);
  }

  function inviteDays(v) {
    var n = Number(v);
    if (v === '' || v == null || isNaN(n) || Math.floor(n) !== n) {
      return res(false, 'Validity must be a whole number of days.');
    }
    if (n < 1 || n > 365) return res(false, 'Validity must be between 1 and 365 days.');
    return res(true);
  }

  function run(data, rules) {
    var errors = {};
    var ok = true;
    for (var field in rules) {
      if (!Object.prototype.hasOwnProperty.call(rules, field)) continue;
      var r = rules[field](data == null ? undefined : data[field]);
      if (!r.ok) { errors[field] = r.message; ok = false; }
    }
    return { ok: ok, errors: errors };
  }

  var Validation = {
    username: username,
    displayName: displayName,
    email: email,
    isoDate: isoDate,
    inviteDays: inviteDays,

    personForm: function (data, opts) {
      opts = opts || {};
      var rules = {
        displayname: displayName,
        mail: function (v) { return email(v, !!opts.mailRequired); },
        validFrom: function (v) { return isoDate(v, 'Valid from'); },
        expire: function (v) { return isoDate(v, 'Expiry'); }
      };
      if (!opts.skipUsername) rules.name = username;
      return run(data, rules);
    },

    groupForm: function (data, opts) {
      opts = opts || {};
      var rules = {
        displayname: displayName,
        description: function (v) {
          // Optional free text (Kanidm Description attribute).
          if (v == null || v === '') return res(true);
          if (typeof v !== 'string' || v.length > 256) {
            return res(false, 'Description must be at most 256 characters.');
          }
          return res(true);
        },
        entryManagedBy: function (v) {
          // Optional; when present must be a valid group name.
          if (typeof v !== 'string' || v.trim() === '') return res(true);
          var r = username(v);
          return r.ok ? res(true) : res(false, 'Managed-by must be a valid group name.');
        }
      };
      if (!opts.skipUsername) rules.name = username;
      return run(data, rules);
    },

    // Absolute https URL — Kanidm requires https redirect/landing URLs for
    // OAuth2 clients (http is only ever allowed for localhost dev clients
    // with an explicit opt-in attribute, which Shenasa does not expose).
    httpsUrl: function (v, label) {
      label = label || 'URL';
      if (typeof v !== 'string' || v.trim() === '') return res(false, label + ' is required.');
      // Regex-only (no URL constructor dependency in tests/workers); the
      // SERVER re-validates authoritatively — this just catches typos.
      if (!/^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(\/[^\s]*)?$/.test(v.trim())) {
        return res(false, label + ' must be a valid absolute https:// URL (e.g. https://app.example.com/callback) — plain http is not accepted by Kanidm here.');
      }
      return res(true);
    },

    // Whitespace/comma separated OIDC-ish tokens (scopes / claim values).
    tokenList: function (v, label) {
      label = label || 'Value list';
      if (typeof v !== 'string' || v.trim() === '') return res(false, label + ' is required.');
      var parts = v.trim().split(/[\s,]+/);
      for (var i = 0; i < parts.length; i++) {
        if (!/^[a-zA-Z0-9_.:*-]{1,64}$/.test(parts[i])) {
          return res(false, label + ': "' + parts[i] + '" is not a valid token (letters, digits, _ . : * -).');
        }
      }
      return res(true);
    },

    // OAuth2 client create/edit form. Landing URL required (Kanidm builds
    // the origin list from it); managed-by optional group name.
    oauthClientForm: function (data, opts) {
      opts = opts || {};
      var rules = {
        displayname: displayName,
        originLanding: function (v) { return Validation.httpsUrl(v, 'Landing URL'); }
      };
      if (!opts.skipName) rules.name = username;
      return run(data, rules);
    },

    // Service account create form — the server REQUIRES entry_managed_by.
    serviceAccountForm: function (data, opts) {
      opts = opts || {};
      var rules = {
        displayname: displayName,
        entryManagedBy: function (v) {
          if (typeof v !== 'string' || v.trim() === '') {
            return res(false, 'Managed-by group is required — Kanidm rejects service accounts without one.');
          }
          var r = username(v.trim());
          return r.ok ? res(true) : res(false, 'Managed-by must be a valid group name.');
        }
      };
      if (!opts.skipName) rules.name = username;
      return run(data, rules);
    },

    // API token issue form: label required; expiry optional ISO date/datetime.
    apiTokenForm: function (data) {
      var rules = {
        label: function (v) {
          if (typeof v !== 'string' || v.trim() === '') return res(false, 'Label is required (e.g. "ci-deploy").');
          if (v.length > 64) return res(false, 'Label must be at most 64 characters.');
          return res(true);
        },
        expiry: function (v) { return isoDate(v, 'Expiry'); }
      };
      return run(data, rules);
    }
  };

  // Small standalone helpers (also used by list pages).
  Validation.parseTokenList = function (v) {
    return String(v == null ? '' : v).trim().split(/[\s,]+/).filter(Boolean);
  };

  global.Validation = Validation;
})(typeof window !== 'undefined' ? window : globalThis);
