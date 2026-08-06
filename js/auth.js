/*
 * auth.js — authentication for Shenasa.
 *
 * Two sign-in methods:
 *   1. SSO — OIDC Authorization Code + PKCE (S256), public client.
 *   2. Passkey — FIDO2/WebAuthn via Kanidm's stepped /v1/auth flow
 *      (init -> begin "passkey" -> cred) — verified against Kanidm 1.10.
 *
 * CRITICAL: OIDC endpoints live at the ORIGIN ROOT, NOT under /v1. The
 * browser-facing authorise page is <origin>/ui/oauth2 — exactly what the
 * discovery document publishes as authorization_endpoint (the protocol
 * endpoint /oauth2/authorise — British spelling — answers JSON/401, not a
 * login UI). The token endpoint is <origin>/oauth2/token.
 * The OAuth base is computed by stripping a trailing "/v1" from apiUrl
 * (see config.js ShenaConfig.oauthBase). /v1/* is only the REST API —
 * including /v1/auth, which passkey sign-in steps through.
 */
(function (global) {
  'use strict';

  var PKCE_KEY = 'shenasa.pkce';

  // ---- base64url utilities ----------------------------------------------
  function b64urlEncode(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = (typeof btoa === 'function')
      ? btoa(bin)
      : global.Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    var b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    var bin = (typeof atob === 'function')
      ? atob(b64)
      : global.Buffer.from(b64, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomB64Url(len) {
    var bytes = new Uint8Array(len);
    global.crypto.getRandomValues(bytes);
    return b64urlEncode(bytes);
  }

  async function sha256B64Url(text) {
    var data = new TextEncoder().encode(text);
    var digest = await global.crypto.subtle.digest('SHA-256', data);
    return b64urlEncode(digest);
  }

  function enc(s) { return encodeURIComponent(s); }

  // ---- JWT claims --------------------------------------------------------
  function decodeJwt(token) {
    if (!token || typeof token !== 'string') return null;
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      var bytes = b64urlDecode(parts[1]);
      var json = '';
      for (var i = 0; i < bytes.length; i++) json += String.fromCharCode(bytes[i]);
      json = decodeURIComponent(escape(json)); // UTF-8 safe
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  var Auth = {
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    decodeJwt: decodeJwt,

    pkceSupported: function () {
      return !!(global.crypto && global.crypto.getRandomValues && global.crypto.subtle);
    },

    webauthnSupported: function () {
      // Requires PublicKeyCredential and a secure context (HTTPS/localhost).
      return !!global.PublicKeyCredential && global.isSecureContext !== false;
    },

    // Kanidm's per-client issuer (matches .well-known/openid-configuration).
    expectedIssuer: function () {
      return global.ShenaConfig.oauthBase() + '/oauth2/openid/' + global.ShenaConfig.clientId();
    },

    // Validate the claims that bind an id_token to THIS client and THIS
    // flow: issuer, audience, expiry and the nonce we sent. A
    // dependency-free browser client cannot verify the JWS signature — but
    // the token arrives over TLS from the token endpoint directly in answer
    // to our own code+PKCE exchange, so enforcing iss/aud/exp/nonce closes
    // the remaining token-substitution (confused deputy) vectors that claim
    // checks can close. Throws on any mismatch; the caller aborts sign-in.
    validateClaims: function (claims, expected) {
      if (!claims || typeof claims !== 'object') {
        throw new Error('Invalid ID token: no claims.');
      }
      if (expected.issuer && claims.iss !== expected.issuer) {
        throw new Error('Invalid ID token issuer (' + String(claims.iss) + '). Sign-in aborted.');
      }
      var aud = claims.aud;
      var audOk = aud === expected.audience ||
        (aud && typeof aud !== 'string' && typeof aud.length === 'number' &&
          aud.indexOf(expected.audience) >= 0);
      if (!audOk) {
        throw new Error('ID token was not issued for this client (aud mismatch). Sign-in aborted.');
      }
      var now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= now) {
        throw new Error('ID token is expired or carries no expiry. Sign-in aborted.');
      }
      // Kanidm echoes the nonce into the id_token (verified in the 1.10
      // source), so strict equality is enforceable.
      if (expected.nonce && claims.nonce !== expected.nonce) {
        throw new Error('OIDC nonce mismatch. Sign-in aborted.');
      }
      return true;
    },

    // ---- SSO: OIDC Authorization Code + PKCE ----------------------------

    // Builds the authorise URL on the ORIGIN ROOT (never under /v1).
    // The browser entry point is /ui/oauth2 — identical to the
    // authorization_endpoint in Kanidm's own discovery document (the
    // /oauth2/authorise variant answers API-style JSON/401, not the login
    // and consent UI a user needs). Pure function for testability.
    buildAuthorizeUrl: function (oauthBase, params) {
      return oauthBase + '/ui/oauth2' +
        '?client_id=' + enc(params.clientId) +
        '&redirect_uri=' + enc(params.redirectUri) +
        '&response_type=code' +
        '&scope=' + enc(params.scope) +
        '&state=' + enc(params.state) +
        '&nonce=' + enc(params.nonce) +
        '&code_challenge=' + enc(params.challenge) +
        '&code_challenge_method=S256';
    },

    startSsoLogin: async function () {
      if (!Auth.pkceSupported()) {
        throw new Error('PKCE requires Web Crypto (crypto.subtle) — use a modern browser over HTTPS.');
      }
      var cfg = global.ShenaConfig;
      var verifier = randomB64Url(64);
      var challenge = await sha256B64Url(verifier);
      var state = randomB64Url(24);
      var nonce = randomB64Url(24);
      try {
        global.sessionStorage.setItem(PKCE_KEY,
          JSON.stringify({ verifier: verifier, state: state, nonce: nonce }));
      } catch (e) { /* sessionStorage unavailable; the callback will fail clearly */ }
      var url = Auth.buildAuthorizeUrl(cfg.oauthBase(), {
        clientId: cfg.clientId(),
        redirectUri: cfg.redirectUri(),
        scope: cfg.scope(),
        state: state,
        nonce: nonce,
        challenge: challenge
      });
      global.location.assign(url);
    },

    // Handles the redirect back to the SPA: ?code=..&state=..
    handleRedirectCallback: async function (search) {
      var q = global.ShenaConfig.parseQuery(search || (global.location && global.location.search));
      if (!q.code) return false;
      var stored = null;
      try { stored = JSON.parse(global.sessionStorage.getItem(PKCE_KEY) || 'null'); } catch (e) {}
      if (!stored || !stored.verifier) {
        throw new Error('Missing PKCE verifier. Start the sign-in again.');
      }
      if (!q.state || q.state !== stored.state) {
        throw new Error('Invalid OAuth state (possible CSRF). Sign-in aborted.');
      }
      try { global.sessionStorage.removeItem(PKCE_KEY); } catch (e) {}

      var cfg = global.ShenaConfig;
      var body = 'grant_type=authorization_code' +
        '&code=' + enc(q.code) +
        '&redirect_uri=' + enc(cfg.redirectUri()) +
        '&client_id=' + enc(cfg.clientId()) +
        '&code_verifier=' + enc(stored.verifier);
      var res = await global.fetch(cfg.oauthBase() + '/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: body,
        credentials: 'include'
      });
      if (!res.ok) {
        var detail = '';
        try { detail = await res.text(); } catch (e) {}
        throw new Error('Token exchange failed (' + res.status + '). ' + detail.slice(0, 200));
      }
      var tokens = await res.json();
      var claims = decodeJwt(tokens.id_token) || {};
      // Claims binding checks (issuer, audience, expiry, nonce) — see
      // Auth.validateClaims. Anything that was not minted by our server,
      // for this client, unexpired, replaying our nonce is rejected.
      Auth.validateClaims(claims, {
        issuer: Auth.expectedIssuer(),
        audience: cfg.clientId(),
        nonce: stored.nonce
      });
      // CRITICAL (verified against the Kanidm 1.10 source): the OIDC
      // access_token is signed by the client's key and MUST NOT be sent to
      // /v1 — the management API only accepts tokens verifiable with the
      // DOMAIN key, i.e. a UserAuthToken (from /v1/auth or the web session)
      // or a service-account API token. Anything else is a guaranteed 401.
      // In SSO mode the Kanidm web-session cookie — created during the
      // authorise/login/consent journey, the same mechanism Kanidm's own UI
      // uses — authenticates REST calls; fetch carries it with
      // credentials:'include'. Store the user with an empty token so the
      // client never sends the OAuth2 bearer.
      var fallback = {
        name: claims.preferred_username || claims.sub || '',
        display_name: claims.displayname || claims.name || claims.preferred_username || '',
        mail: claims.email || '',
        roles: global.Store.rolesFromGroups(claims.groups || []),
        token: '',
        authMethod: 'sso'
      };
      global.Store.setUser(fallback);
      // Canonical identity + roles from the server via the session cookie.
      // /v1/self answers WhoamiResponse { youare: Entry } (Kanidm 1.10); the
      // entry includes memberof (idm_acp_self_read), giving us the server's
      // own live role set — preferred over the id_token claims.
      try {
        var self = global.Api.selfEntry(await global.Api.getSelf());
        if (self && self.attrs) {
          var selfRoles = global.Store.rolesFromGroups(global.Api.attrs(self, 'memberof'));
          global.Store.setUser({
            name: global.Api.attr(self, 'name') || fallback.name,
            display_name: global.Api.attr(self, 'displayname') || fallback.display_name,
            mail: global.Api.attr(self, 'mail') || fallback.mail,
            roles: selfRoles.length ? selfRoles : fallback.roles,
            token: '',
            authMethod: 'sso'
          });
        }
      } catch (cookieErr) {
        // Session cookie not usable here (e.g. two-domain topology without a
        // same-origin API proxy, or the Kanidm web session ended). REST
        // calls will surface "session expired" and ask for a fresh sign-in;
        // keep the id_token-derived identity until then.
      }
      // SSO sessions are privilege-capable too — surface the write window
      // state to the UI (usually read-only until a reauth step-up).
      try { await Auth.refreshWriteScope(); } catch (e) { /* read-only badge */ }
      return true;
    },

    // Exchanges are kept: after the callback the query string is cleaned by
    // app.js via history.replaceState.

    // ---- Passkey (FIDO2/WebAuthn) ----------------------------------------

    // Convert WebAuthn ceremony JSON into PublicKeyCredential*Options with
    // proper ArrayBuffers. Tolerates { publicKey: {...} } wrappers and the
    // base64url string encodings servers commonly use.
    _decodeCredentialOptions: function (json) {
      var opts = json && json.publicKey ? json.publicKey : json;
      var out = {};
      var k, i;
      for (k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
      }
      if (typeof out.challenge === 'string') out.challenge = b64urlDecode(out.challenge).buffer;
      if (out.user && typeof out.user.id === 'string') out.user.id = b64urlDecode(out.user.id).buffer;
      var lists = ['allowCredentials', 'excludeCredentials'];
      for (i = 0; i < lists.length; i++) {
        var list = out[lists[i]];
        if (list && list.length) {
          for (var j = 0; j < list.length; j++) {
            if (typeof list[j].id === 'string') list[j].id = b64urlDecode(list[j].id).buffer;
          }
        }
      }
      return out;
    },

    // Serialise a PublicKeyCredential for JSON transport.
    _credentialToJSON: function (cred) {
      function buf(b) { return b ? b64urlEncode(b) : null; }
      var resp = cred.response || {};
      var out = {
        id: cred.id,
        rawId: buf(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: buf(resp.clientDataJSON)
        }
      };
      if (resp.attestationObject !== undefined) out.response.attestationObject = buf(resp.attestationObject);
      if (resp.authenticatorData !== undefined) out.response.authenticatorData = buf(resp.authenticatorData);
      if (resp.signature !== undefined) out.response.signature = buf(resp.signature);
      if (resp.userHandle !== undefined) out.response.userHandle = buf(resp.userHandle);
      return out;
    },

    _post: async function (url, body) {
      var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      var u = global.Store && global.Store.user;
      if (u && u.token) headers['Authorization'] = 'Bearer ' + u.token;
      var res;
      try {
        res = await global.fetch(url, {
          method: 'POST',
          headers: headers,
          credentials: 'include',
          body: JSON.stringify(body == null ? {} : body)
        });
      } catch (e) {
        throw new Error('Network error: ' + (e && e.message ? e.message : e));
      }
      if (!res.ok) {
        var msg = res.statusText;
        try {
          var j = await res.json();
          if (j && (j.message || j.error)) msg = j.message || j.error;
        } catch (e2) {}
        throw new Error('Request failed (' + res.status + '): ' + msg);
      }
      var text = await res.text();
      try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; }
    },

    // Passkey sign-in via Kanidm's stepped /v1/auth protocol:
    //   {"step":{"init":"<user>"}}            -> {"state":{"choose":["passkey",...]}}
    //   {"step":{"begin":"passkey"}}          -> {"state":{"continue":[{"passkey": <challenge>}]}}
    //   navigator.credentials.get(challenge)
    //   {"step":{"cred":{"passkey":<assert>}} -> {"state":{"success":"<bearer token>"}}
    // The cookie jar between steps is the auth session; the returned bearer
    // token is a normal Kanidm session token usable against /v1.
    // (Verified against Kanidm 1.10 — there is no /_session/passkey API;
    // that guess previously produced 404s.)
    passkeyLogin: async function (username) {
      if (!Auth.webauthnSupported()) {
        throw new Error('Passkey sign-in is not supported in this browser context.');
      }
      var name = String(username == null ? '' : username).trim();
      if (!name) throw new Error('Enter your account name first.');
      var cfg = global.ShenaConfig;
      var step = function (payload) { return Auth._post(cfg.apiUrl() + '/auth', payload); };

      function deniedReason(json) {
        var s = json && json.state;
        return s && typeof s.denied === 'string' ? s.denied : null;
      }

      // 1. init — which mechanisms does this account have?
      var r1 = await step({ step: { init: name } });
      var denied = deniedReason(r1);
      if (denied) throw new Error('Sign-in denied: ' + denied);
      var choices = (r1 && r1.state && r1.state.choose) || [];
      if (choices.indexOf('passkey') < 0) {
        throw new Error('Account "' + name + '" has no passkey enrolled, or passkey ' +
          'sign-in is disabled for it. Use SSO (or another method) instead.');
      }

      // 2. begin passkey — server returns a WebAuthn request challenge.
      var r2 = await step({ step: { begin: 'passkey' } });
      denied = deniedReason(r2);
      if (denied) throw new Error('Sign-in denied: ' + denied);
      var cont = (r2 && r2.state && r2.state['continue']) || [];
      var challenge = null;
      for (var i = 0; i < cont.length; i++) {
        if (cont[i] && cont[i].passkey) { challenge = cont[i].passkey; break; }
      }
      if (!challenge) throw new Error('The server did not return a WebAuthn challenge.');

      // 3. browser ceremony
      var options = Auth._decodeCredentialOptions(challenge);
      var assertion = await global.navigator.credentials.get({ publicKey: options });
      if (!assertion) throw new Error('Passkey sign-in was cancelled.');

      // 4. answer the challenge -> session token
      var r3 = await step({ step: { cred: { passkey: Auth._credentialToJSON(assertion) } } });
      denied = deniedReason(r3);
      if (denied) throw new Error('Sign-in denied: ' + denied);
      var token = (r3 && r3.state && r3.state.success) || '';
      if (!token) throw new Error('The server did not return a session token.');

      // 5. identity + roles from /v1/self using the fresh token.
      // /v1/self returns WhoamiResponse { youare: Entry } — unwrap it;
      // reading .attrs on the wrapper yields undefined and zeroes roles.
      var self = global.Api.selfEntry(await global.Api.getSelf(token));
      var roles = [];
      if (self && self.attrs) {
        roles = global.Store.rolesFromGroups(global.Api.attrs(self, 'memberof'));
      }
      global.Store.setUser({
        name: global.Api.attr(self, 'name') || name,
        display_name: global.Api.attr(self, 'displayname') || global.Api.attr(self, 'name') || name,
        mail: global.Api.attr(self, 'mail') || '',
        roles: roles,
        token: token,
        authMethod: 'passkey'
      });
      // Interactive sign-ins are read-only scoped (PrivilegeCapable); the
      // top-bar badge/step-up needs the real write window from the server.
      try { await Auth.refreshWriteScope(); } catch (e) { /* read-only badge */ }
      return true;
    },

    // Passkeys/credentials are managed inside Kanidm's own credential
    // manager (a dedicated, audited session protocol — /v1/credential/_*
    // — rather than plain webauthn endpoints, which do not exist in
    // Kanidm 1.10). Shenasa deep-links the signed-in user there.
    credentialSelfServiceUrl: function () {
      return global.ShenaConfig.oauthBase() + '/ui/update_credentials';
    },

    // ---- Step-up (re-authentication) ---------------------------------
    // Read the server's verdict about THIS session's write window from
    // GET /v1/self/_uat and mirror it into Store.writeExpiry.
    refreshWriteScope: async function () {
      var exp = 0;
      try {
        var uat = await global.Api.getSelfUat();
        if (uat && uat.purpose) exp = global.Store.parseUatPurpose(uat.purpose);
      } catch (e) { exp = 0; }
      global.Store.setWriteExpiry(exp);
      return exp;
    },

    // Interactive logins (the Kanidm web login AND our stepped passkey
    // flow, both with `privileged: false`) yield a PRIVILEGE-CAPABLE
    // session. process_uat_to_identity maps such UATs
    // (ReadWrite{expiry: None}) to AccessScope::ReadOnly, and the access
    // layer denies EVERY write with HTTP 403 before roles are even
    // evaluated (server/lib/src/server/access/{delete,modify}.rs in
    // Kanidm 1.10). The sanctioned escape hatch is POST /v1/reauth:
    // prove the passkey again -> the UAT is reissued as
    // ReadWrite{expiry: now + privilege_expiry (default 600s)}.
    // This mirrors exactly what the Kanidm UI (/ui/reauth) and the
    // `kanidm reauth` CLI subcommand do.
    stepUp: async function () {
      if (!global.Store.isSignedIn()) throw new Error('Sign in first.');
      if (!Auth.webauthnSupported()) {
        throw new Error('Passkey verification is not available in this browser context.');
      }
      var cfg = global.ShenaConfig;
      var deniedOf = function (json) {
        var s = json && json.state;
        return s && typeof s.denied === 'string' ? s.denied : null;
      };
      // 1. Begin reauth — AuthIssueSession::Token -> a bare JSON string.
      //    Auth._post attaches the current bearer automatically and
      //    carries cookies ('include'), so cookie SSO sessions work too.
      var r1 = await Auth._post(cfg.apiUrl() + '/reauth', 'token');
      var denied = deniedOf(r1);
      if (denied) throw new Error('Re-authentication denied: ' + denied);
      // The reauth session mirrors the credential type of the ORIGINAL
      // session; passkey sessions continue directly with a WebAuthn
      // challenge (AuthAllowed::Passkey), while some flows first answer
      // choose([...]) and need an explicit begin. Handle both.
      var cont = (r1 && r1.state && r1.state['continue']) || [];
      var challenge = null;
      var i;
      for (i = 0; i < cont.length; i++) {
        if (cont[i] && cont[i].passkey) { challenge = cont[i].passkey; break; }
      }
      if (!challenge) {
        var choose = (r1 && r1.state && r1.state.choose) || [];
        if (choose.indexOf('passkey') >= 0) {
          var r1b = await Auth._post(cfg.apiUrl() + '/auth', { step: { begin: 'passkey' } });
          denied = deniedOf(r1b);
          if (denied) throw new Error('Re-authentication denied: ' + denied);
          cont = (r1b && r1b.state && r1b.state['continue']) || [];
          for (i = 0; i < cont.length; i++) {
            if (cont[i] && cont[i].passkey) { challenge = cont[i].passkey; break; }
          }
        }
      }
      if (!challenge) {
        throw new Error('This session cannot step up with a passkey. Sign out and sign in again.');
      }
      // 2. Passkey ceremony + answer.
      var options = Auth._decodeCredentialOptions(challenge);
      var assertion = await global.navigator.credentials.get({ publicKey: options });
      if (!assertion) throw new Error('Passkey verification was cancelled.');
      var r2 = await Auth._post(cfg.apiUrl() + '/auth',
        { step: { cred: { passkey: Auth._credentialToJSON(assertion) } } });
      denied = deniedOf(r2);
      if (denied) throw new Error('Re-authentication denied: ' + denied);
      var token = (r2 && r2.state && r2.state.success) || '';
      if (!token) throw new Error('The server did not issue an elevated session token.');
      // Swap the session token: the reissued UAT carries the r/w window
      // (the SSO web-session cookie stays as-is; Api requests prefer the
      // bearer header, so writes now succeed there too).
      var u = global.Store.user || {};
      global.Store.setUser({
        name: u.name || '',
        display_name: u.display_name || '',
        mail: u.mail || '',
        roles: u.roles || [],
        token: token,
        authMethod: u.authMethod || 'sso'
      });
      await Auth.refreshWriteScope();
      return global.Store.canWriteNow();
    },

    // Signs out LOCALLY and on the SERVER. The local session alone is not
    // enough: Kanidm sets a web-session cookie during SSO (and the stepped
    // passkey flow), so "signing out" by only clearing sessionStorage left
    // the SSO session alive — the next "Sign in with SSO" click silently
    // re-logged the same user. Kanidm 1.10's GET /ui/logout (see
    // https/views/login.rs view_logout_get) calls handle_logout AND always
    // destroys the bearer/auth-session/oauth2-req/cu-session cookies.
    //
    // Returns { serverLogout, logoutUrl }:
    //   - same-origin API: we fetch /ui/logout ourselves (cookies cleared),
    //     serverLogout=true and the caller can re-render the login page.
    //   - cross-origin API: fetch would be blocked by CORS, so the caller
    //     must top-level navigate to logoutUrl; the user lands on Kanidm's
    //     own login page, fully signed out.
    // Note: a passkey-mode bearer token is also still valid until its
    // expiry — Kanidm 1.10 exposes no token-revocation endpoint.
    signOut: async function () {
      global.Store.clear();
      var base = global.ShenaConfig.oauthBase();
      if (!base) return { serverLogout: false, logoutUrl: null };
      var logoutUrl = base + '/ui/logout';
      // Origin comparison without the URL constructor (simple parse of
      // scheme://authority) — robust in any JS environment.
      var sameOrigin = false;
      try {
        var m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(base);
        sameOrigin = !!(m && global.location && global.location.origin &&
          String(m[1]).toLowerCase() === String(global.location.origin).toLowerCase());
      } catch (e) { sameOrigin = false; }
      if (sameOrigin) {
        try {
          await global.fetch(logoutUrl, { credentials: 'include' });
          return { serverLogout: true, logoutUrl: logoutUrl };
        } catch (e) {
          // Fall through to a navigation-based logout.
        }
      }
      return { serverLogout: false, logoutUrl: logoutUrl };
    }
  };

  global.Auth = Auth;
})(typeof window !== 'undefined' ? window : globalThis);
