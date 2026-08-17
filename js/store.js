/*
 * store.js — global session state and RBAC helpers for Shenasa.
 *
 * Store.user = { name, display_name, mail, roles: [], token, authMethod }.
 * Store.writeExpiry = epoch seconds until which writes are allowed by the
 * Kanidm server session (0/undefined = read-only session).
 *
 * The role getters ONLY gate the UI (enable/disable buttons and pages).
 * The Kanidm SERVER always remains the authority that enforces real
 * authorisation — a forged token or edited client cannot bypass it.
 */
(function (global) {
  'use strict';

  var SESSION_KEY = 'shenasa.session';

  function stripDomain(spn) {
    // Kanidm group claims are SPNs like "idm_admins@idm.example.com".
    var s = String(spn == null ? '' : spn);
    var at = s.indexOf('@');
    return at >= 0 ? s.slice(0, at) : s;
  }

  var Store = {
    user: null,

    // ---- session lifecycle -------------------------------------------
    setUser: function (user) {
      Store.user = user;
      try {
        global.sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
      } catch (e) { /* storage unavailable; session is memory-only */ }
    },
    clear: function () {
      Store.user = null;
      try { global.sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    },
    restore: function () {
      if (Store.user) return Store.user;
      try {
        var raw = global.sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        var u = JSON.parse(raw);
        if (u && typeof u === 'object' && (u.token || u.authMethod)) {
          // Shape-validate before trusting anything from storage. roles
          // MUST be an array of strings and scalars real strings: a
          // tampered blob with roles as a STRING would substring-match
          // inside hasRole() and forge UI-level privileges.
          var roles = [];
          if (u.roles && typeof u.roles !== 'string' && typeof u.roles.length === 'number') {
            for (var i = 0; i < u.roles.length; i++) {
              if (typeof u.roles[i] === 'string') roles.push(u.roles[i]);
            }
          }
          Store.user = {
            name: typeof u.name === 'string' ? u.name : '',
            display_name: typeof u.display_name === 'string' ? u.display_name : '',
            mail: typeof u.mail === 'string' ? u.mail : '',
            roles: roles,
            token: typeof u.token === 'string' ? u.token : '',
            authMethod: u.authMethod === 'passkey' ? 'passkey' : 'sso'
          };
          // Server-side write scope is NOT persisted across a page reload:
          // it is refreshed from /v1/self/_uat after sign-in/restore.
          Store.writeExpiry = 0;
          // Same for the detected server version: re-read from the next
          // response's X-KANIDM-VERSION header.
          Store.serverVersion = null;
          return Store.user;
        }
      } catch (e) {}
      return null;
    },
    isSignedIn: function () {
      return !!(Store.user && (Store.user.token || Store.user.authMethod));
    },

    // ---- server-side write scope -------------------------------------
    // Kanidm's access layer denies EVERY write whose identity scope is
    // ReadOnly — before roles are even looked at (server/access/delete.rs
    // and modify.rs in 1.10). Interactive logins mint a PrivilegeCapable
    // session whose UAT purpose is ReadWrite{expiry: None}, and
    // process_uat_to_identity maps expiry:None to AccessScope::ReadOnly;
    // only a reauth (/v1/reauth) issues ReadWrite{expiry: Some(+600s)}.
    // So: expiry seconds in the future = writable window; anything else =
    // read-only session.
    writeExpiry: 0,
    setWriteExpiry: function (epochSeconds) {
      Store.writeExpiry = Number(epochSeconds) > 0 ? Number(epochSeconds) : 0;
    },
    canWriteNow: function (nowMs) {
      var now = nowMs == null ? Date.now() : nowMs;
      return Store.writeExpiry > 0 && Store.writeExpiry * 1000 > now;
    },
    // Parse the `purpose` field of GET /v1/self/_uat (UatPurpose, serde
    // lowercase: "readonly" or {"readwrite": {"expiry": null|secs}}).
    parseUatPurpose: function (purpose) {
      if (purpose && typeof purpose === 'object' && purpose.readwrite) {
        var exp = purpose.readwrite.expiry;
        return typeof exp === 'number' && exp > 0 ? exp : 0;
      }
      return 0; // "readonly" or unknown
    },

    // ---- server version / compatibility -------------------------------
    // Detected from the X-KANIDM-VERSION response header, which the
    // server's global version middleware injects into EVERY response in
    // both 1.10 and 1.11 (server/core/src/https/middleware/mod.rs).
    // Memory-only: re-detected from the first API call after each load.
    // Absent (stripped by a proxy / mid-deploy / not exposed over CORS)
    // must degrade to 'unknown', never to an error.
    serverVersion: null,
    setServerVersion: function (v) {
      if (typeof v !== 'string') return;
      v = v.trim();
      if (!/^[\w.+-]{1,32}$/.test(v)) return; // header garbage guard
      Store.serverVersion = v;
    },
    serverVersionParsed: function () {
      var m = Store.serverVersion &&
        /^(\d+)\.(\d+)\.(\d+)/.exec(Store.serverVersion);
      return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
    },
    // Compatibility contract (evidence in README "Compatibility"):
    //   - /v1 route sets of 1.10.5 and 1.11.0 are IDENTICAL (verified diff
    //     of server/core/src/https/v1.rs).
    //   - dl15 builtin ACPs are additive-only vs dl14 (self-read attr
    //     widening, OAuth2 introspection attrs) — role mapping unchanged.
    //   - Auth scope semantics + privilege/session + recycle constants
    //     unchanged (process_uat_to_identity, constants/mod.rs).
    SUPPORTED_KANIDM: [[1, 10], [1, 11]],
    serverCompat: function () {
      var v = Store.serverVersionParsed();
      if (!v) return 'unknown';
      for (var i = 0; i < Store.SUPPORTED_KANIDM.length; i++) {
        if (v.major === Store.SUPPORTED_KANIDM[i][0] &&
            v.minor === Store.SUPPORTED_KANIDM[i][1]) return 'supported';
      }
      return 'unsupported';
    },
    SUPPORTED_KANIDM_LABEL: '1.10.x / 1.11.x',

    // ---- role mapping -------------------------------------------------
    // Map group claims (SPNs) to bare role names: "idm_admins@domain" ->
    // "idm_admins".
    rolesFromGroups: function (groups) {
      var roles = [];
      if (!groups || typeof groups.length !== 'number') return roles;
      for (var i = 0; i < groups.length; i++) {
        var r = stripDomain(groups[i]);
        if (r && roles.indexOf(r) < 0) roles.push(r);
      }
      return roles;
    },

    hasRole: function (role) {
      return !!(Store.user && Store.user.roles && Store.user.roles.indexOf(role) >= 0);
    },
    hasAnyRole: function (roles) {
      for (var i = 0; i < roles.length; i++) {
        if (Store.hasRole(roles[i])) return true;
      }
      return false;
    },

    // ---- RBAC gates (UI only; server enforces the real authZ) --------
    // Map EXACTLY what the Kanidm 1.10 builtin ACPs grant (verified in
    // server/lib/src/migration_data/dl14/access.rs) — idm_admins receives
    // NO builtin ACP of its own; its only builtin power is being
    // entry_manager of the idm_* role groups, so it is deliberately NOT
    // listed in people/group/PII gates.
    canManagePeople: function () {
      return Store.hasAnyRole(['idm_people_admins']);
    },
    // Creating/editing/deleting ordinary groups.
    canManageGroups: function () {
      return Store.hasAnyRole(['idm_group_admins']);
    },
    // Member add/remove: idm_group_admins for ordinary groups
    // (idm_acp_group_manage), idm_admins for the built-in idm_* role
    // groups it entry-manages (idm_acp_group_entry_manager).
    canEditGroupMembers: function () {
      return Store.hasAnyRole(['idm_group_admins', 'idm_admins']);
    },
    canReadPii: function () {
      return Store.hasAnyRole(['idm_people_pii_read', 'idm_people_admins']);
    },
    canSetManagedBy: function () {
      return Store.hasAnyRole(['idm_access_control_admins']);
    },
    canSelfEditMail: function () {
      return Store.hasAnyRole(['idm_people_self_mail_write', 'idm_people_admins']);
    },
    canResetAnyPassword: function () {
      return Store.hasAnyRole(['idm_service_desk', 'idm_people_admins']);
    },
    canImpersonate: function () {
      return Store.hasAnyRole(['idm_service_desk']);
    },
    // The recycle bin has its OWN builtin role — neither idm_admins nor
    // idm_people_admins can see it (idm_acp_recycle_bin_search/_revive).
    canRecycleBin: function () {
      return Store.hasAnyRole(['idm_recycle_bin_admins']);
    },
    // OAuth2/OIDC clients: managed by idm_oauth2_admins (builtin ACPs
    // idm_acp_oauth2_manage{,_basic} — receiver UUID_IDM_OAUTH2_ADMINS in
    // dl14/dl15 access.rs). NOT idm_admins.
    canManageOauth2: function () {
      return Store.hasAnyRole(['idm_oauth2_admins']);
    },
    // Service accounts + their API tokens: idm_service_account_admins
    // (builtin ACPs idm_acp_service_account_{create,manage,delete}).
    canManageServiceAccounts: function () {
      return Store.hasAnyRole(['idm_service_account_admins']);
    },
    // Domain settings (display name, recovery toggle, …): domain_admins.
    // idm_acp_domain_admin receiver = UUID_DOMAIN_ADMINS; the group's
    // members are UUID_SYSTEM_ADMINS — idm_admins is NOT included
    // (dl14/dl15 access.rs + groups.rs).
    canDomainAdmin: function () {
      return Store.hasAnyRole(['domain_admins']);
    }
  };

  Store.SESSION_KEY = SESSION_KEY;
  Store.stripDomain = stripDomain;
  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
