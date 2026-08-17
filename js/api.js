/*
 * api.js — real Kanidm REST client for Shenasa.
 *
 * baseUrl = Config.apiUrl() (ends in /v1). Calls carry
 * "Authorization: Bearer <Store.user.token>" when available and use cookie
 * credentials so a cookie-based session (passkey sign-in) also works on
 * single-origin deployments.
 *
 * Errors are normalised to ApiError { status, message, code }:
 *   - 401            -> ApiError(401, "session expired", "401")
 *   - other non-2xx  -> ApiError(status, json.message || statusText)
 *   - network error  -> ApiError(0, ...)
 *
 * Only endpoints that exist in Kanidm 1.10/1.11 are called (the /v1 route
 * sets of v1.10.5 and v1.11.0 are identical — verified by diffing
 * server/core/src/https/v1.rs): features with NO REST surface — audit log
 * reading, invitations, listing/revoking other sessions, SCIM import —
 * are not exposed in this client at all.
 */
(function (global) {
  'use strict';

  function ApiError(status, message, code) {
    this.status = status;
    this.message = message;
    this.code = code != null ? String(code) : String(status);
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;
  ApiError.prototype.name = 'ApiError';

  function enc(s) { return encodeURIComponent(s); }

  function getConfig() { return global.ShenaConfig; }

  // In-flight de-duplication for idempotent GETs: rapid navigation (or two
  // widgets needing the same list) must not fan out duplicate requests —
  // the SECOND caller simply awaits the promise already in flight. The map
  // is cleared as soon as the request settles, so nothing is ever cached
  // beyond the flight window (no stale reads, no invalidation burden).
  var _inflightGets = Object.create(null);

  var Api = {
    ApiError: ApiError,

    _url: function (path) {
      return getConfig().apiUrl() + path;
    },

    _request: function (method, path, body, bearer) {
      var dedup = method === 'GET' && bearer === undefined;
      if (dedup) {
        var key = this._url(path);
        var pending = _inflightGets[key];
        if (pending) return pending;
        var p = this._doRequest(method, path, body, bearer);
        _inflightGets[key] = p;
        var clear = function () { if (_inflightGets[key] === p) delete _inflightGets[key]; };
        p.then(clear, clear);
        return p;
      }
      return this._doRequest(method, path, body, bearer);
    },

    _doRequest: async function (method, path, body, bearer) {
      var headers = { 'Accept': 'application/json' };
      var u = global.Store && global.Store.user;
      var token = bearer || (u && u.token);
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var init = {
        method: method,
        headers: headers,
        credentials: 'include'
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      var res;
      try {
        res = await global.fetch(this._url(path), init);
      } catch (e) {
        throw new ApiError(0, 'Network error contacting ' + this._url(path) +
          ': ' + (e && e.message ? e.message : e), '0');
      }
      // X-KANIDM-VERSION is injected into every response by the server's
      // global version middleware (1.10 and 1.11) — feed it to the Store
      // so Settings can show live compatibility. Absent/stripped headers
      // degrade to 'unknown' (see Store.serverCompat); never fatal.
      try {
        var kv = res.headers && typeof res.headers.get === 'function' ?
          res.headers.get('x-kanidm-version') : null;
        if (kv && global.Store && global.Store.setServerVersion) {
          global.Store.setServerVersion(kv);
        }
      } catch (e) { /* header not readable (CORS expose) — fine */ }
      if (res.status === 401) throw new ApiError(401, 'session expired', '401');
      if (res.status === 204) return null;
      var text = '';
      try { text = await res.text(); } catch (e) { /* ignore */ }
      var json = null;
      if (text) { try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ } }
      if (!res.ok) {
        var msg = (json && (json.message || json.error || json.detail)) ||
          res.statusText || ('HTTP ' + res.status);
        throw new ApiError(res.status, msg, String(res.status));
      }
      return json;
    },

    // ---- Kanidm entry helpers ({ attrs: { name: [values...] } }) -------
    attr: function (entry, name) {
      if (!entry || !entry.attrs) return undefined;
      var v = entry.attrs[name];
      if (v == null) return undefined;
      if (typeof v.length === 'number' && typeof v !== 'string') return v[0];
      return v;
    },
    attrs: function (entry, name) {
      if (!entry || !entry.attrs) return [];
      var v = entry.attrs[name];
      if (v == null) return [];
      if (typeof v === 'string') return [v];
      return v;
    },
    personName: function (entry) { return Api.attr(entry, 'name') || Api.attr(entry, 'uuid') || ''; },

    _entry: function (attrs) {
      // Values as arrays, as Kanidm entries are multi-valued.
      var out = {};
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === undefined || v === null || v === '') continue;
        // Empty arrays are kept (attribute purge). Non-empty strings wrap.
        out[k] = (typeof v.length === 'number' && typeof v !== 'string') ? v : [v];
      }
      return { attrs: out };
    },

    // ---- People --------------------------------------------------------
    listPeople: function () { return Api._request('GET', '/person'); },
    getPerson: function (name) { return Api._request('GET', '/person/' + enc(name)); },
    createPerson: function (data) {
      var attrs = { name: data.name, displayname: data.displayname };
      if (data.mail) attrs.mail = data.mail;
      if (data.validFrom) attrs.account_valid_from = data.validFrom;
      if (data.expire) attrs.account_expire = data.expire;
      return Api._request('POST', '/person', Api._entry(attrs));
    },
    updatePerson: function (name, data) {
      var attrs = {};
      if (data.displayname !== undefined) attrs.displayname = data.displayname;
      // Empty string → empty array, which is Kanidm's attribute-purge form
      // (same as bulk expiry clear). Skipping '' used to make "clear mail"
      // a silent no-op.
      if (data.mail !== undefined) attrs.mail = data.mail === '' ? [] : data.mail;
      if (data.validFrom !== undefined) attrs.account_valid_from = data.validFrom;
      if (data.expire !== undefined) attrs.account_expire = data.expire;
      return Api._request('PATCH', '/person/' + enc(name), Api._entry(attrs));
    },
    deletePerson: function (name) { return Api._request('DELETE', '/person/' + enc(name)); },

    // ---- Groups --------------------------------------------------------
    listGroups: function () { return Api._request('GET', '/group'); },
    getGroup: function (name) { return Api._request('GET', '/group/' + enc(name)); },
    createGroup: function (data) {
      // Groups have NO writable displayname in Kanidm: dl14/dl15
      // idm_acp_group_manage create_attrs = Class/Name/Uuid/Description/
      // Mail/Member/EntryManagedBy (no DisplayName), the delegation ACP
      // idm_acp_group_entry_manager allows Description/Member only.
      // Sending displayname is a guaranteed 403 on a real server.
      var attrs = { name: data.name };
      if (data.description) attrs.description = data.description;
      if (data.entryManagedBy) attrs.entry_managed_by = data.entryManagedBy;
      return Api._request('POST', '/group', Api._entry(attrs));
    },
    updateGroup: function (name, data) {
      var attrs = {};
      if (data.description !== undefined) attrs.description = data.description;
      if (data.entryManagedBy !== undefined) attrs.entry_managed_by = data.entryManagedBy;
      return Api._request('PATCH', '/group/' + enc(name), Api._entry(attrs));
    },
    deleteGroup: function (name) { return Api._request('DELETE', '/group/' + enc(name)); },
    // Kanidm attribute operations: POST extends an attribute's values,
    // DELETE removes the listed values (see docs/openapi.yaml).
    // The _attr/member endpoints accept Vec<String>, so bulk membership
    // changes are ONE request per group — not one request per user.
    // (Routes: group_id_attr_post/delete, server/core/src/https/v1.rs; the
    // POST appends values, the DELETE removes the given values.)
    addGroupMember: function (group, member) {
      return Api._request('POST', '/group/' + enc(group) + '/_attr/member', [member]);
    },
    addGroupMembers: function (group, members) {
      return Api._request('POST', '/group/' + enc(group) + '/_attr/member', members.slice());
    },
    removeGroupMember: function (group, member) {
      return Api._request('DELETE', '/group/' + enc(group) + '/_attr/member', [member]);
    },
    removeGroupMembers: function (group, members) {
      return Api._request('DELETE', '/group/' + enc(group) + '/_attr/member', members.slice());
    },

    // ---- Membership helpers --------------------------------------------
    addPersonToGroup: function (person, group) { return Api.addGroupMember(group, person); },
    removePersonFromGroup: function (person, group) { return Api.removeGroupMember(group, person); },

    // ---- Account operations --------------------------------------------
    // Begins a credential-reset intent for a user (service-desk flow).
    // Kanidm >= 1.1 exposes POST /v1/person/:id/_credential/_update_intent/:ttl;
    // the returned token authorises the holder to update credentials at the
    // server's own UI. Endpoint shape is version-dependent.
    // Kanidm 1.10 exposes the intent as a GET (the upstream route carries a
    // "TODO: this shouldn't be a get" remark); the returned CUIntentToken
    // { token, expiry_time } authorises the holder at <origin>/ui/reset.
    resetPassword: function (name, ttlSeconds) {
      var ttl = ttlSeconds || 3600;
      return Api._request('GET', '/person/' + enc(name) + '/_credential/_update_intent/' + encodeURIComponent(String(ttl)), undefined);
    },
    // Account-policy minimum credential type toggles passkey-only sign-in.
    // The attribute is "credential_type_minimum" (Kanidm 1.10); some
    // deployments additionally govern it via group account policy — the UI
    // shows guidance if the server rejects the change.
    setUserPasskeyOnly: function (name, enabled) {
      return Api._request('PATCH', '/person/' + enc(name),
        Api._entry({ credential_type_minimum: enabled ? 'passkey' : 'any' }));
    },

    // ---- Derived statistics (computed client-side from real data) ------
    stats: async function () {
      var results = await Promise.all([Api.listPeople(), Api.listGroups()]);
      var people = results[0] || [];
      var groups = results[1] || [];
      var now = Date.now();
      var active = 0;
      var passkeyOnly = 0;
      for (var i = 0; i < people.length; i++) {
        var p = people[i];
        if (Api.accountActive(p, now)) active++;
        if (String(Api.attr(p, 'credential_type_minimum') || '').toLowerCase() === 'passkey') passkeyOnly++;
      }
      return {
        totalUsers: people.length,
        totalGroups: groups.length,
        activeUsers: active,
        passkeyOnlyUsers: passkeyOnly,
        people: people,
        groups: groups
      };
    },

    analytics: async function () {
      var results = await Promise.all([Api.listPeople(), Api.listGroups()]);
      var people = results[0] || [];
      var groups = results[1] || [];
      var perGroup = [];
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var members = Api.attrs(g, 'member');
        perGroup.push({
          name: Api.attr(g, 'name') || Api.attr(g, 'uuid') || '?',
          count: members.length
        });
      }
      perGroup.sort(function (a, b) { return b.count - a.count; });
      var withPasskey = 0;
      for (var j = 0; j < people.length; j++) {
        if (Api.attrs(people[j], 'passkeys').length > 0) withPasskey++;
      }
      return {
        membersPerGroup: perGroup,
        passkeyUsers: withPasskey,
        totalUsers: people.length,
        passkeyAdoption: people.length ? Math.round((withPasskey / people.length) * 100) : 0
      };
    },

    // Returns true if the account is inside its validity window.
    accountActive: function (person, nowMs) {
      var now = nowMs == null ? Date.now() : nowMs;
      var from = Api.attr(person, 'account_valid_from');
      var exp = Api.attr(person, 'account_expire');
      var fromMs = from ? Date.parse(from) : NaN;
      var expMs = exp ? Date.parse(exp) : NaN;
      if (!isNaN(fromMs) && now < fromMs) return false;
      if (!isNaN(expMs) && now > expMs) return false;
      return true;
    },
    accountStatus: function (person, nowMs) {
      var now = nowMs == null ? Date.now() : nowMs;
      var from = Api.attr(person, 'account_valid_from');
      var exp = Api.attr(person, 'account_expire');
      if (exp && !isNaN(Date.parse(exp)) && now > Date.parse(exp)) return 'expired';
      if (from && !isNaN(Date.parse(from)) && now < Date.parse(from)) return 'notYetValid';
      return 'active';
    },

    // ---- Self -----------------------------------------------------------
    // Pass an explicit bearer token right after a stepped /v1/auth login,
    // before Store.user exists.
    getSelf: function (token) { return Api._request('GET', '/self', undefined, token); },

    // GET /v1/self returns WhoamiResponse { youare: Entry } (verified in
    // proto/src/v1/mod.rs of Kanidm 1.10) — NOT a bare entry. Reading
    // .attrs directly yields undefined and silently empties the caller's
    // roles/groups. Unwrap `youare` (a bare Entry is tolerated for
    // resilience). The reduced entry contains `memberof` because the
    // builtin idm_acp_self_read ACP grants MemberOf on one's own entry.
    selfEntry: function (self) {
      if (self && typeof self === 'object' && self.youare && self.youare.attrs) {
        return self.youare;
      }
      return self;
    },

    // GET /v1/self/_uat -> UserAuthToken of the CURRENT session
    // (session_id, issued_at, expiry, purpose, spn, ...). Kanidm 1.10 has no
    // REST endpoint to list or revoke other sessions.
    getSelfUat: function () { return Api._request('GET', '/self/_uat'); },

    // ---- Recycle bin (real Kanidm 1.10 endpoints) ----------------------
    // GET  /v1/recycle_bin              -> Vec<Entry> (class/name/uuid/…)
    // POST /v1/recycle_bin/{uuid}/_revive -> restores the entry (no body).
    // Both require the idm_recycle_bin_admins role (builtin ACPs
    // idm_acp_recycle_bin_search / idm_acp_recycle_bin_revive); there is no
    // purge endpoint — the server purges on its own schedule.
    listRecycled: function () { return Api._request('GET', '/recycle_bin'); },
    reviveRecycled: function (uuid) {
      return Api._request('POST', '/recycle_bin/' + enc(uuid) + '/_revive');
    },

    // ---- OAuth2 / OIDC clients -----------------------------------------
    // Route/method table verified against server/core/src/https/v1.rs and
    // the payload shapes against libs/client/src/oauth.rs — identical in
    // v1.10.5 and v1.11.0. Role gate: idm_oauth2_admins
    // (idm_acp_oauth2_manage{,_basic}).
    listOauth2Clients: function () { return Api._request('GET', '/oauth2'); },
    getOauth2Client: function (name) { return Api._request('GET', '/oauth2/' + enc(name)); },
    // Create entries use the Entry {"attrs":{...}} envelope, exactly like
    // deploy/bootstrap.sh (which is field-verified against real servers).
    createOauth2PublicClient: function (data) {
      var attrs = {
        name: data.name,
        displayname: data.displayname,
        oauth2_rs_origin_landing: data.originLanding,
        oauth2_strict_redirect_uri: 'true'
      };
      return Api._request('POST', '/oauth2/_public', Api._entry(attrs));
    },
    createOauth2BasicClient: function (data) {
      var attrs = {
        name: data.name,
        displayname: data.displayname,
        oauth2_rs_origin_landing: data.originLanding,
        oauth2_strict_redirect_uri: 'true'
      };
      return Api._request('POST', '/oauth2/_basic', Api._entry(attrs));
    },
    // PATCH replaces ONLY the listed attribute values (attrs envelope);
    // unlisted attributes are preserved (bootstrap.sh relies on this).
    updateOauth2Client: function (name, attrs) {
      return Api._request('PATCH', '/oauth2/' + enc(name), Api._entry(attrs));
    },
    deleteOauth2Client: function (name) { return Api._request('DELETE', '/oauth2/' + enc(name)); },
    // GET returns the CURRENT basic secret as a plain string (only basic /
    // confidential clients have one; public clients 404/403).
    getOauth2BasicSecret: function (name) {
      return Api._request('GET', '/oauth2/' + enc(name) + '/_basic_secret');
    },
    // Scope maps: POST body is a bare JSON array of scope strings; DELETE
    // has no body. The server resolves the group segment by name or SPN
    // (bootstrap.sh passes bare group names on production servers).
    setOauth2ScopeMap: function (name, group, scopes) {
      return Api._request('POST', '/oauth2/' + enc(name) + '/_scopemap/' + enc(group), scopes);
    },
    deleteOauth2ScopeMap: function (name, group) {
      return Api._request('DELETE', '/oauth2/' + enc(name) + '/_scopemap/' + enc(group));
    },
    setOauth2SupScopeMap: function (name, group, scopes) {
      return Api._request('POST', '/oauth2/' + enc(name) + '/_sup_scopemap/' + enc(group), scopes);
    },
    deleteOauth2SupScopeMap: function (name, group) {
      return Api._request('DELETE', '/oauth2/' + enc(name) + '/_sup_scopemap/' + enc(group));
    },
    setOauth2ClaimMap: function (name, claim, group, values) {
      return Api._request('POST', '/oauth2/' + enc(name) + '/_claimmap/' + enc(claim) + '/' + enc(group), values);
    },
    deleteOauth2ClaimMap: function (name, claim, group) {
      return Api._request('DELETE', '/oauth2/' + enc(name) + '/_claimmap/' + enc(claim) + '/' + enc(group));
    },

    // ---- Service accounts ----------------------------------------------
    // Verified against server/core/src/https/v1.rs and
    // libs/client/src/service_account.rs (identical 1.10.5 / 1.11.0).
    // Role gate: idm_service_account_admins.
    listServiceAccounts: function () { return Api._request('GET', '/service_account'); },
    getServiceAccount: function (id) { return Api._request('GET', '/service_account/' + enc(id)); },
    // entry_managed_by is REQUIRED by the server for service-account
    // creation and must be a group that manages the lifecycle of the
    // account (libs/client idm_service_account_create sends it always).
    createServiceAccount: function (data) {
      var attrs = {
        name: data.name,
        displayname: data.displayname,
        entry_managed_by: data.entryManagedBy
      };
      return Api._request('POST', '/service_account', Api._entry(attrs));
    },
    updateServiceAccount: function (id, attrs) {
      return Api._request('PATCH', '/service_account/' + enc(id), Api._entry(attrs));
    },
    deleteServiceAccount: function (id) { return Api._request('DELETE', '/service_account/' + enc(id)); },
    // GET lists ApiToken { token_id, label, expiry(optional epoch secs),
    // issued_at(epoch secs), purpose } — proto/src/internal/token.rs.
    listApiTokens: function (id) {
      return Api._request('GET', '/service_account/' + enc(id) + '/_api_token');
    },
    // POST body ApiTokenGenerate { label, expiry: nulable epoch secs,
    // read_write, compact } — the full token string is returned ONCE in
    // the response and can never be read again afterwards.
    generateApiToken: function (id, data) {
      return Api._request('POST', '/service_account/' + enc(id) + '/_api_token', {
        label: data.label,
        expiry: data.expiry || null,
        read_write: !!data.readWrite,
        compact: !!data.compact
      });
    },
    deleteApiToken: function (id, tokenId) {
      return Api._request('DELETE', '/service_account/' + enc(id) + '/_api_token/' + enc(tokenId));
    },

    // ---- Domain ---------------------------------------------------------
    getDomain: function () { return Api._request('GET', '/domain'); },

    // ---- v1.3: credential status & domain attributes -----------------------
    // Per-user credential TYPE status (never the secrets themselves):
    // GET /v1/person/{id}/_credential/_status → { creds: [{ uuid, type_ }] }.
    // The server returns an EMPTY list when nothing is set (v1.rs maps
    // NoMatchingAttributes → 200); type_ serde: "Password" |
    // "GeneratedPassword" | { "Passkey": [labels] } |
    // { "PasswordMfa": [[totpLabels], [securityKeyLabels], backupCodeCount] }
    // (proto/src/internal/credupdate.rs). Read requires the credential-reset
    // ACPs — calls may 403 for plain people readers and the UI tolerates it.
    getCredentialStatus: function (name) {
      return Api._request('GET', '/person/' + enc(name) + '/_credential/_status');
    },
    // Domain attribute read/write (domain_admins; idm_acp_domain_admin).
    // GET → Option<Vec<String>>; PUT body is a BARE array of strings
    // (booleans as "true"/"false" — libs/client/src/domain.rs).
    getDomainAttr: function (attr) {
      return Api._request('GET', '/domain/_attr/' + enc(attr));
    },
    putDomainAttr: function (attr, values) {
      return Api._request('PUT', '/domain/_attr/' + enc(attr), values);
    }
  };

  global.Api = Api;
})(typeof window !== 'undefined' ? window : globalThis);
