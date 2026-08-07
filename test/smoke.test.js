#!/usr/bin/env node
/*
 * smoke.test.js — Shenasa smoke tests (no framework).
 *
 * Full DOM tests run under jsdom when it is installed (npm install).
 * The production app itself is real-only (no mock backend); tests inject a
 * fake API and an authenticated session purely for testing purposes.
 *
 * Without jsdom (e.g. offline installs) the pure-logic tests still run and
 * the DOM suite is reported as SKIPPED, so `npm run check` stays useful.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS_FILES = ['config.js', 'i18n.js', 'store.js', 'validation.js', 'qrcode.js',
  'api.js', 'ui.js', 'auth.js', 'pages.js', 'app.js'];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok    ${name}`); })
    .catch((err) => {
      failed++;
      failures.push({ name, err });
      console.error(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
    });
}
function skip(name, reason) {
  skipped++;
  console.log(`  skip  ${name} (${reason})`);
}
function assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`assertion failed: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
function assertIncludes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) < 0) {
    throw new Error(`assertion failed: ${msg} (${JSON.stringify(needle)} not found)`);
  }
}
function assertNotIncludes(haystack, needle, msg) {
  if (String(haystack).indexOf(needle) >= 0) {
    throw new Error(`assertion failed: ${msg} (${JSON.stringify(needle)} unexpectedly present)`);
  }
}
function readFile(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Evaluate the browser scripts inside a minimal window-like context.
function loadModules(extraWindow) {
  const win = Object.assign({
    console,
    setTimeout,
    clearTimeout,
    Promise,
    location: { search: '', hash: '', pathname: '/', href: 'http://localhost/' },
    // Standard window globals real browsers always provide.
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    addEventListener() {},
    removeEventListener() {},
    // Minimal document stub: app.js defers boot to DOMContentLoaded, which
    // never fires in this harness, so no DOM is touched during module load.
    document: {
      readyState: 'loading',
      addEventListener() {},
      removeEventListener() {},
      getElementById() { return null; },
      documentElement: { setAttribute() {} }
    }
  }, extraWindow || {});
  const context = vm.createContext(win);
  for (const f of JS_FILES) vm.runInContext(readFile(path.join('js', f)), context, { filename: f });
  return win;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

async function main() {
  console.log('smoke tests\n===========');

  // ------------------------------------------------------------------
  // Pure-logic tests (no DOM required)
  // ------------------------------------------------------------------
  const env = loadModules();

  await test('config: defaults present and public (no secrets)', () => {
    assertEq(env.SHENASA_CONFIG.apiUrl, 'https://idm.example.com/v1', 'default apiUrl');
    assertEq(env.SHENASA_CONFIG.oidcClientId, 'shenasa_admin_ui', 'default clientId');
    assert(/^(light|dark|auto)$/.test(env.SHENASA_CONFIG.theme), 'theme enum');
    assertNotIncludes(JSON.stringify(env.SHENASA_CONFIG), 'secret', 'no secret keys');
    assertNotIncludes(JSON.stringify(env.SHENASA_CONFIG), 'password', 'no passwords');
  });

  await test('config: URL overrides only allowed keys', () => {
    const merged = env.ShenaConfig.resolve({}, '?apiUrl=https://idm.test/v1&theme=dark&evil=%22%3Ebad');
    assertEq(merged.apiUrl, 'https://idm.test/v1', 'apiUrl override');
    assertEq(merged.theme, 'dark', 'theme override');
    assert(!('evil' in merged), 'unknown keys rejected');
    const badTheme = env.ShenaConfig.resolve({}, '?theme=gothic');
    assertEq(badTheme.theme, 'light', 'invalid theme rejected');
  });

  await test('config: OAuth base strips trailing /v1 (origin root)', () => {
    assertEq(env.ShenaConfig.oauthBaseOf('https://idm.test/v1'), 'https://idm.test', 'strip /v1');
    assertEq(env.ShenaConfig.oauthBaseOf('https://idm.test/v1/'), 'https://idm.test', 'strip /v1/');
    assertEq(env.ShenaConfig.oauthBaseOf('https://idm.test'), 'https://idm.test', 'leave bare origin');
  });

  await test('validation: create-user rules', () => {
    const bad = env.Validation.personForm({ name: 'BAD NAME!', displayname: '', mail: 'not-an-email', validFrom: 'nope' });
    assert(!bad.ok, 'invalid form rejected');
    assert(bad.errors.name, 'username error reported');
    assert(bad.errors.displayname, 'displayname error reported');
    assert(bad.errors.mail, 'email error reported');
    assert(bad.errors.validFrom, 'date error reported');
    const good = env.Validation.personForm({
      name: 'alice_d-1', displayname: 'Alice', mail: 'alice@example.test', validFrom: '2026-01-01', expire: '2027-01-01'
    });
    assert(good.ok, 'valid form accepted: ' + JSON.stringify(good.errors));
    assert(env.Validation.inviteDays('7').ok, 'valid day count accepted');
    assert(!env.Validation.inviteDays('900').ok, 'days out of range rejected');
    assert(!('inviteForm' in env.Validation), 'invitation form removed (Kanidm has no invitations API)');
  });

  await test('validation: usernames follow the server INAME_RE — dots allowed', () => {
    // Server rule (v1.10.5 value.rs): ^[a-z][a-z0-9-_\.]{0,63}$ + reserved
    // names {"root","dn=token"} — a previous client regex wrongly banned dots.
    assert(env.Validation.username('m.mirzamohammadi').ok, 'dotted username accepted (firstname.lastname)');
    assert(env.Validation.username('alice.smith_1-x').ok, 'mixed separators accepted');
    assert(env.Validation.username('a').ok, 'single letter accepted');
    assert(!env.Validation.username('1alice').ok, 'must start with a letter');
    assert(!env.Validation.username('-alice').ok, 'leading hyphen rejected');
    assert(!env.Validation.username('.alice').ok, 'leading dot rejected');
    assert(!env.Validation.username('_alice').ok, 'leading underscore rejected');
    assert(!env.Validation.username('Alice').ok, 'uppercase rejected (server lowercases)');
    assert(!env.Validation.username('root').ok, 'reserved name rejected');
    assert(!env.Validation.username('m.m ir').ok, 'spaces rejected');
    const g = env.Validation.groupForm({ name: 'team.one', displayname: 'Team One', description: 'ok' });
    assert(g.ok, 'dotted group name accepted');
    const tooLong = env.Validation.groupForm({ name: 'team', displayname: 'T', description: 'x'.repeat(300) });
    assert(!tooLong.ok && tooLong.errors.description, 'description length capped');
  });

  await test('RBAC: role mapping and gating helpers', () => {
    const roles = env.Store.rolesFromGroups(['idm_admins@idm.example.test', 'staff@idm.example.test']);
    assert(roles.indexOf('idm_admins') >= 0, 'SPN domain stripped');
    assert(roles.indexOf('staff') >= 0, 'non-role group kept');
    env.Store.user = { roles: ['idm_people_admins'] };
    assert(env.Store.canManagePeople(), 'people admin manages people');
    assert(!env.Store.canManageGroups(), 'people admin cannot manage groups');
    assert(env.Store.canReadPii(), 'people admin reads PII');
    assert(env.Store.canResetAnyPassword(), 'people admin resets passwords');
    env.Store.user = { roles: ['idm_service_desk'] };
    assert(env.Store.canImpersonate(), 'service desk can impersonate');
    assert(!env.Store.canManagePeople(), 'service desk cannot manage people');
    // idm_admins receives NO builtin people ACPs (dl14/access.rs): it can
    // change MEMBERSHIP of the built-in idm_* role groups only.
    env.Store.user = { roles: ['idm_admins'] };
    assert(!env.Store.canManagePeople(), 'idm_admins cannot manage persons (needs idm_people_admins)');
    assert(!env.Store.canManageGroups(), 'idm_admins cannot create/edit ordinary groups');
    assert(env.Store.canEditGroupMembers(), 'idm_admins edits members of the role groups it entry-manages');
    assert(!env.Store.canRecycleBin(), 'idm_admins cannot see the recycle bin');
    env.Store.user = { roles: ['idm_recycle_bin_admins'] };
    assert(env.Store.canRecycleBin(), 'recycle bin role grants recycle bin');
    env.Store.user = { roles: [] };
    assert(!env.Store.canManagePeople(), 'no roles: nothing allowed');
    assert(!env.Store.canSelfEditMail(), 'no roles: no self mail edit');
    env.Store.user = null;
  });

  await test('XSS: esc() neutralises markup', () => {
    const out = env.Ui.esc('<img src=x onerror=alert(1)>"');
    assertNotIncludes(out, '<img', 'no live tag survives esc()');
    assertIncludes(out, '&lt;img', 'angle brackets escaped');
    assertIncludes(out, '&quot;', 'quotes escaped');
  });

  await test('QR: square matrix within v1-10 and SVG output', () => {
    const m = env.QRCode.toModules('HELLO WORLD', 'L');
    assertEq(m.length, 21, 'v1 size 21');
    for (const row of m) assertEq(row.length, 21, 'square matrix');
    const big = env.QRCode.toModules('https://idm.example.test/ui/reset?token=' + 'ab'.repeat(60), 'M');
    assert(big.length >= 41, 'larger version selected for longer data');
    const svg = env.QRCode.toSVG('HELLO WORLD', { ecl: 'M', moduleSize: 5 });
    assertIncludes(svg, '<svg', 'SVG root');
    assertIncludes(svg, '<path', 'modules path');
    let threw = false;
    try { env.QRCode.toModules('x'.repeat(500), 'L'); } catch (e) { threw = true; }
    assert(threw, 'oversize data throws');
  });

  await test('SSO: authorise URL on origin root with PKCE S256', () => {
    const url = env.Auth.buildAuthorizeUrl('https://idm.example.test', {
      clientId: 'shenasa_admin_ui',
      redirectUri: 'https://shenasa.example.test/oauth2/redirect',
      scope: 'openid profile email',
      state: 'STATE123',
      nonce: 'NONCE456',
      challenge: 'CHALLENGE789'
    });
    assert(url.startsWith('https://idm.example.test/ui/oauth2?'), 'authorise UI on ORIGIN ROOT');
    assertNotIncludes(url, '/v1/oauth2', 'never under /v1');
    assertNotIncludes(url, '/oauth2/authorize', 'never the American-spelled JSON endpoint');
    assertIncludes(url, 'response_type=code', 'code flow');
    assertIncludes(url, 'code_challenge=CHALLENGE789', 'PKCE challenge');
    assertIncludes(url, 'code_challenge_method=S256', 'PKCE S256');
    assertIncludes(url, 'state=STATE123', 'state');
    assertIncludes(url, 'nonce=NONCE456', 'nonce');
    assertIncludes(url, 'redirect_uri=' + encodeURIComponent('https://shenasa.example.test/oauth2/redirect'), 'redirect uri encoded');
    assertIncludes(url, 'scope=' + encodeURIComponent('openid profile email'), 'scope encoded');
  });

  await test('passkey login: Kanidm stepped /v1/auth flow', async () => {
    const calls = [];
    const fakeAssertion = {
      id: 'cred-id',
      rawId: new Uint8Array([9]).buffer,
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null
      }
    };
    const env2 = loadModules({
      isSecureContext: true,
      PublicKeyCredential: function () {},
      navigator: {
        credentials: {
          get: async (opts) => {
            // Realm-agnostic check: buffers created inside the vm sandbox are
            // not instanceof the outer realm's ArrayBuffer.
            assert(opts.publicKey.challenge && typeof opts.publicKey.challenge.byteLength === 'number' &&
              opts.publicKey.challenge.byteLength > 0, 'challenge decoded from base64url to bytes');
            assertEq(opts.publicKey.rpId, 'idm.example.test', 'rpId passed through');
            return fakeAssertion;
          }
        }
      },
      fetch: async (url, init) => {
        calls.push({ url, init });
        const body = init && init.body ? JSON.parse(init.body) : {};
        let payload;
        if (url === 'https://idm.example.test/v1/auth') {
          if (body.step && body.step.init === 'alice') {
            payload = { state: { choose: ['password', 'passkey'] } };
          } else if (body.step && body.step.begin === 'passkey') {
            payload = { state: { 'continue': [{ passkey: { publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'idm.example.test', timeout: 60000, userVerification: 'preferred' } } }] } };
          } else if (body.step && body.step.cred && body.step.cred.passkey) {
            assertEq(body.step.cred.passkey.id, 'cred-id', 'assertion id forwarded');
            payload = { state: { success: 'tok-123' } };
          } else {
            throw new Error('unexpected /v1/auth payload ' + JSON.stringify(body));
          }
        } else if (url === 'https://idm.example.test/v1/self') {
          assertEq(init.headers.Authorization, 'Bearer tok-123', '/v1/self called with the fresh token');
          // REAL Kanidm 1.10 shape: WhoamiResponse { youare: Entry }.
          payload = { youare: { attrs: { name: ['alice'], displayname: ['Alice A'], mail: ['alice@example.test'], memberof: ['idm_admins@idm.example.test'] } } };
        } else {
          throw new Error('unexpected url ' + url);
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
    });
    env2.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    await env2.Auth.passkeyLogin('alice');
    assertEq(env2.Store.user.name, 'alice', 'user name taken from /v1/self');
    assertEq(env2.Store.user.display_name, 'Alice A', 'display name');
    assertEq(env2.Store.user.token, 'tok-123', 'session token stored');
    assertEq(env2.Store.user.authMethod, 'passkey', 'auth method recorded');
    assert(env2.Store.hasRole('idm_admins'), 'roles derived from whoami youare.memberof');
    assertEq(calls.filter(c => c.url === 'https://idm.example.test/v1/auth').length, 3, 'init + begin + cred steps');

    // Rejections surface clean errors.
    let threw = null;
    try { await env2.Auth.passkeyLogin('  '); } catch (e) { threw = e; }
    assert(threw && /account name/i.test(threw.message), 'empty username rejected locally');

    // An account without passkey gets a clear message (choose lacks "passkey").
    const env3 = loadModules({
      isSecureContext: true,
      PublicKeyCredential: function () {},
      navigator: { credentials: { get: async () => { throw new Error('should not reach the ceremony'); } } },
      fetch: async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        if (body.step && body.step.init === 'bob') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ state: { choose: ['password'] } }) };
        }
        throw new Error('flow must stop after init');
      }
    });
    env3.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    threw = null;
    try { await env3.Auth.passkeyLogin('bob'); } catch (e) { threw = e; }
    assert(threw && /no passkey/i.test(threw.message), 'missing passkey enrolment explained: ' + (threw && threw.message));
  });

  await test('SSO callback: no OAuth2 bearer on /v1, cookie session used', async () => {
    // Kanidm's OIDC access token is client-key signed and invalid on /v1;
    // the web-session cookie from the authorise journey authenticates
    // instead. This test pins that behaviour.
    const b64url = (s) => Buffer.from(s).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const idToken = b64url('{"alg":"none"}') + '.' + b64url(JSON.stringify({
      sub: 'alice', preferred_username: 'alice', displayname: 'Alice Claims',
      email: 'alice-claims@example.test',
      iss: 'https://idm.example.test/oauth2/openid/shenasa_admin_ui',
      aud: 'shenasa_admin_ui',
      exp: Math.floor(Date.now() / 1000) + 3600,
      groups: ['idm_people_admins@idm.example.test'], nonce: 'N-1'
    })) + '.x';
    const calls = [];
    const env4 = loadModules({
      location: { search: '?code=CODE-1&state=S-1', hash: '', pathname: '/admin/', href: 'https://idm.example.test/admin/' },
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (url === 'https://idm.example.test/oauth2/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'OAUTH-AT-MUST-NOT-GO-TO-V1', id_token: idToken }) };
        }
        if (url === 'https://idm.example.test/v1/self') {
          assert(!init.headers.Authorization, 'NO Authorization header sent to /v1 (cookie auth only)');
          // REAL Kanidm 1.10 shape: WhoamiResponse { youare: Entry }.
          return { ok: true, status: 200, text: async () => JSON.stringify({ youare: { attrs: { name: ['alice'], displayname: ['Alice Self'], mail: ['alice@example.test'], memberof: ['idm_admins@idm.example.test'] } } }) };
        }
        throw new Error('unexpected url ' + url);
      }
    });
    env4.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    env4.sessionStorage.setItem('shenasa.pkce', JSON.stringify({ verifier: 'V', state: 'S-1', nonce: 'N-1' }));
    const done = await env4.Auth.handleRedirectCallback('?code=CODE-1&state=S-1');
    assert(done === true, 'callback handled');
    assertEq(env4.Store.user.token, '', 'OIDC access token NOT stored for API use');
    assertEq(env4.Store.user.authMethod, 'sso', 'auth method');
    assertEq(env4.Store.user.name, 'alice', 'identity canonicalised from /v1/self');
    assertEq(env4.Store.user.display_name, 'Alice Self', 'display name from /v1/self (not claims)');
    assert(env4.Store.hasRole('idm_admins'), 'roles from whoami youare.memberof');

    // If the cookie is not usable, the id_token claims are the fallback.
    const env4b = loadModules({
      location: { search: '?code=CODE-1&state=S-1', hash: '', pathname: '/admin/', href: 'https://idm.example.test/admin/' },
      fetch: async (url) => {
        if (url === 'https://idm.example.test/oauth2/token') {
          return { ok: true, status: 200, json: async () => ({ access_token: 'AT', id_token: idToken }) };
        }
        if (url === 'https://idm.example.test/v1/self') {
          return { ok: false, status: 401, text: async () => '' };
        }
        throw new Error('unexpected url ' + url);
      }
    });
    env4b.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    env4b.sessionStorage.setItem('shenasa.pkce', JSON.stringify({ verifier: 'V', state: 'S-1', nonce: 'N-1' }));
    await env4b.Auth.handleRedirectCallback('?code=CODE-1&state=S-1');
    assert(env4b.Store.hasRole('idm_people_admins'), 'claims groups are the fallback when whoami is unreachable');
    assertEq(env4b.Store.user.display_name, 'Alice Claims', 'claims identity fallback');

    // State/nonce protection still enforced.
    env4.sessionStorage.setItem('shenasa.pkce', JSON.stringify({ verifier: 'V', state: 'S-1', nonce: 'N-1' }));
    let threw = null;
    try { await env4.Auth.handleRedirectCallback('?code=CODE-2&state=WRONG'); } catch (e) { threw = e; }
    assert(threw && /state/i.test(threw.message), 'bad state rejected');
  });

  await test('OIDC claims validation: iss/aud/exp/nonce are all enforced', () => {
    const w = loadModules();
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    const expected = () => ({ issuer: w.Auth.expectedIssuer(), audience: w.ShenaConfig.clientId(), nonce: 'N' });
    const ok = {
      iss: 'https://idm.example.test/oauth2/openid/shenasa_admin_ui',
      aud: 'shenasa_admin_ui',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: 'N'
    };
    assertEq(w.Auth.validateClaims(ok, expected()), true, 'well-formed claims accepted');
    assertEq(w.Auth.expectedIssuer(), 'https://idm.example.test/oauth2/openid/shenasa_admin_ui', 'issuer derived like discovery');
    const cases = [
      [{ ...ok, iss: 'https://evil.example.test/anything' }, /issuer/i, 'foreign issuer rejected'],
      [{ ...ok, aud: 'some_other_client' }, /aud|client/i, 'foreign audience rejected'],
      [{ ...ok, aud: ['other', 'also_other'] }, /aud|client/i, 'audience list without us rejected'],
      [{ ...ok, aud: ['other', 'shenasa_admin_ui'] }, true, 'audience list containing us accepted'],
      [{ ...ok, exp: Math.floor(Date.now() / 1000) - 5 }, /expired/i, 'expired token rejected'],
      [{ ...ok, exp: undefined }, /expired|expiry/i, 'missing expiry rejected'],
      [{ ...ok, nonce: 'OTHER' }, /nonce/i, 'nonce mismatch rejected'],
      [{ ...ok, nonce: undefined }, /nonce/i, 'missing nonce rejected']
    ];
    for (const [claims, re, msg] of cases) {
      let err = null;
      try { w.Auth.validateClaims(claims, expected()); } catch (e) { err = e; }
      if (re === true) assert(!err, msg);
      else assert(err && re.test(err.message), msg + ' (got: ' + (err && err.message) + ')');
    }
    assert(!w.Auth.validateClaims ? false : true, 'validator exists');
    let err = null;
    try { w.Auth.validateClaims(null, expected()); } catch (e) { err = e; }
    assert(err && /no claims/i.test(err.message), 'null claims rejected');
  });

  await test('session restore: tampered storage shapes cannot forge roles', () => {
    const w = loadModules();
    w.sessionStorage.setItem('shenasa.session', JSON.stringify({
      name: 'mallory', token: {}, authMethod: 'sso',
      roles: 'idm_admins' // string, not array — classic shape attack
    }));
    const u = w.Store.restore();
    assert(u, 'session restored');
    assertEq(u.roles.length, 0, 'string roles downgraded to empty array');
    assert(!w.Store.hasRole('idm_admins'), 'forged roles rejected');
    assertEq(u.authMethod, 'sso', 'authMethod kept');
    w.Store.clear();
    w.sessionStorage.setItem('shenasa.session', '{"name":"x","authMethod":"weird","roles":["idm_admins",42]}');
    const u2 = w.Store.restore();
    assertEq(u2.authMethod, 'sso', 'unknown authMethod coerced to sso');
    assertEq(u2.roles.length, 1, 'non-string role entries dropped');
    assert(w.Store.hasRole('idm_admins'), 'legitimate string role kept');
    w.Store.clear();
    w.sessionStorage.setItem('shenasa.session', 'not json{');
    assertEq(w.Store.restore(), null, 'corrupt JSON ignored');
  });

  await test('sign-out: closes the Kanidm server session (GET /ui/logout), not just local state', async () => {
    // Same-origin (single-origin topology): the SPA fetches /ui/logout
    // itself — Kanidm's view_logout_get calls handle_logout AND destroys
    // the auth-session/bearer cookies, so the SSO session really ends.
    const fetches = [];
    const w = loadModules({
      location: { origin: 'https://idm.example.test', search: '', hash: '', pathname: '/admin/', href: 'https://idm.example.test/admin/', assign() { throw new Error('must not navigate on same-origin'); } },
      fetch: async (url, init) => {
        fetches.push({ url, init });
        return { ok: true, status: 200, text: async () => '<html>login</html>' };
      }
    });
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    w.Store.setUser({ name: 'alice', roles: [], token: '', authMethod: 'sso' });
    const res = await w.Auth.signOut();
    assertEq(res.serverLogout, true, 'server session closed');
    assert(!w.Store.user, 'local session cleared');
    assertEq(fetches.length, 1, 'exactly one logout request');
    assertEq(fetches[0].url, 'https://idm.example.test/ui/logout', 'GET /ui/logout on the origin root');
    assertEq(fetches[0].init.credentials, 'include', 'cookie carried so it can be destroyed server-side');

    // Cross-origin (two-domain topology): fetch would be CORS-blocked, so
    // the caller gets a logoutUrl for a top-level navigation instead.
    let navigated = null;
    const w2fetches = [];
    const w2 = loadModules({
      location: { origin: 'https://admin.example.test', search: '', hash: '', pathname: '/', href: 'https://admin.example.test/', assign(u) { navigated = u; } },
      fetch: async (url, init) => { w2fetches.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; }
    });
    w2.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    w2.Store.setUser({ name: 'alice', roles: [], token: '', authMethod: 'sso' });
    const res2 = await w2.Auth.signOut();
    assertEq(res2.serverLogout, false, 'no ajax logout cross-origin');
    assertEq(res2.logoutUrl, 'https://idm.example.test/ui/logout', 'navigation URL handed back');
    assertEq(w2fetches.length, 0, 'no cross-origin fetch attempted');
    assert(!w2.Store.user, 'local session cleared cross-origin too');
  });

  await test('store: write-scope parsing mirrors server AccessScope rules', () => {
    const w = loadModules({});
    // Kanidm 1.10 UatPurpose serialization:
    //   "readonly"                                -> AccessScope::ReadOnly
    //   {"readwrite":{"expiry":null}}             -> ReadOnly (privilege-capable, not stepped-up)
    //   {"readwrite":{"expiry":<epoch secs>}}     -> ReadWrite only while now < expiry
    assertEq(w.Store.parseUatPurpose('readonly'), 0, 'readonly has no write window');
    assertEq(w.Store.parseUatPurpose({ readwrite: { expiry: null } }), 0, 'privilege-capable (expiry None) is NOT writable');
    const future = Math.floor(Date.now() / 1000) + 600; // server default privilege window is 600s
    assertEq(w.Store.parseUatPurpose({ readwrite: { expiry: future } }), future, 'r/w window parsed');
    assertEq(w.Store.parseUatPurpose(undefined), 0, 'missing purpose is read-only');
    w.Store.setWriteExpiry(future);
    assert(w.Store.canWriteNow(), 'writable inside window');
    assert(!w.Store.canWriteNow((future + 1) * 1000), 'read-only after the window closes');
    w.Store.setWriteExpiry(0);
    assert(!w.Store.canWriteNow(), 'no window, no writes');
  });

  await test('store: server version detection + Kanidm compatibility matrix (1.10 & 1.11)', () => {
    const w = loadModules({});
    assertEq(w.Store.serverCompat(), 'unknown', 'no header captured yet -> unknown (never an error)');
    // Supported range — both verified source trees (see README):
    w.Store.setServerVersion('1.10.5');
    assertEq(w.Store.serverCompat(), 'supported', '1.10.x supported');
    w.Store.setServerVersion('1.11.0');
    assertEq(w.Store.serverCompat(), 'supported', '1.11.x supported');
    const p = w.Store.serverVersionParsed();
    assertEq(p.major, 1, 'parsed major'); assertEq(p.minor, 11, 'parsed minor'); assertEq(p.patch, 0, 'parsed patch');
    // Outside the verified range -> unsupported (honest, not a crash):
    for (const bad of ['1.9.4', '1.12.0', '1.12.0-dev', '2.0.0', '0.9.9']) {
      w.Store.setServerVersion(bad);
      assertEq(w.Store.serverCompat(), 'unsupported', bad + ' -> unsupported');
    }
    // Whitespace is trimmed; garbage/non-strings are rejected and keep the
    // previous value (a forged header must not flip the badge):
    w.Store.setServerVersion('  1.10.5  ');
    assertEq(w.Store.serverVersion, '1.10.5', 'header value trimmed');
    w.Store.setServerVersion('garbage string with spaces');
    assertEq(w.Store.serverVersion, '1.10.5', 'garbage rejected, previous kept');
    w.Store.setServerVersion('<script>alert(1)</script>');
    assertEq(w.Store.serverVersion, '1.10.5', 'markup rejected');
    w.Store.setServerVersion(123);
    assertEq(w.Store.serverVersion, '1.10.5', 'non-string rejected');
  });

  await test('API client: X-KANIDM-VERSION header feeds the compatibility store', async () => {
    // The server stamps EVERY response (global version middleware in 1.10
    // and 1.11 — server/core/src/https/middleware/mod.rs).
    const w = loadModules({
      fetch: async () => ({
        ok: true, status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'x-kanidm-version' ? '1.11.0' : null) },
        text: async () => '[]'
      })
    });
    w.Store.user = { token: 'x' };
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    await w.Api.listPeople();
    assertEq(w.Store.serverVersion, '1.11.0', 'version captured from response header');
    assertEq(w.Store.serverCompat(), 'supported', 'detected 1.11 is supported');
    // Header absent/stripped (proxy, CORS expose) -> graceful 'unknown':
    const w2 = loadModules({
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '[]' })
    });
    w2.Store.user = { token: 'x' };
    w2.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    await w2.Api.listPeople();
    assertEq(w2.Store.serverCompat(), 'unknown', 'absent header degrades to unknown, no crash');
    // auth.js/api mocks without a headers property at all must not break:
    const w3 = loadModules({
      fetch: async () => ({ ok: true, status: 200, text: async () => '[]' })
    });
    w3.Store.user = { token: 'x' };
    w3.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    await w3.Api.listPeople();
    assertEq(w3.Store.serverCompat(), 'unknown', 'no headers object tolerated');
  });

  await test('step-up: POST /v1/reauth + passkey swaps in the r/w reissued token', async () => {
    // REAL reauth flow (verified against kanidm v1.10.5 reauth.rs +
    // libs/client reauth_passkey_begin/complete):
    //   POST /v1/reauth  body: "token"     -> {"state":{"continue":[{"passkey":<challenge>}]}}
    //   WebAuthn ceremony
    //   POST /v1/auth    {step:{cred:{passkey:…}}} -> {"state":{"success":"<reissued token>"}}
    // The reissued UAT is ReadWrite{expiry: now+600} — writes pass the
    // AccessScope gate that previously 403'd them.
    const calls = [];
    const fakeAssertion = {
      id: 'cred-id', rawId: new Uint8Array([1]).buffer, type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null
      }
    };
    const w = loadModules({
      isSecureContext: true,
      PublicKeyCredential: function () {},
      navigator: { credentials: { get: async () => fakeAssertion } },
      fetch: async (url, init) => {
        calls.push({ url, init });
        const body = init && init.body ? JSON.parse(init.body) : {};
        let payload = {};
        if (url === 'https://idm.example.test/v1/reauth') {
          assertEq(init.method, 'POST', 'reauth is a POST');
          assertEq(body, 'token', 'AuthIssueSession::Token serializes as bare "token"');
          assertEq(init.headers.Authorization, 'Bearer old-token', 'current session token attached');
          payload = { sessionid: 're-1', state: { 'continue': [{ passkey: { publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'idm.example.test', timeout: 60000 } } }] } };
        } else if (url === 'https://idm.example.test/v1/auth') {
          assert(body.step && body.step.cred && body.step.cred.passkey, 'answered with passkey credential');
          payload = { sessionid: 're-1', state: { success: 'rw-token' } };
        } else if (url === 'https://idm.example.test/v1/self/_uat') {
          assertEq(init.headers.Authorization, 'Bearer rw-token', 'scope check uses the NEW token');
          payload = { session_id: 's-1', purpose: { readwrite: { expiry: Math.floor(Date.now() / 1000) + 600 } } };
        } else {
          throw new Error('unexpected url ' + url);
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
    });
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    w.Store.setUser({ name: 'alice', display_name: 'Alice', mail: '', roles: ['idm_people_admins'], token: 'old-token', authMethod: 'passkey' });
    const ok = await w.Auth.stepUp();
    assertEq(ok, true, 'write window is active after step-up');
    assertEq(w.Store.user.token, 'rw-token', 'reissued r/w token swapped in');
    // Roles/identity survive the token swap.
    assert(w.Store.hasRole('idm_people_admins'), 'roles preserved across step-up');
    // A choose-style first answer is handled too (begin passkey first).
    const w2 = loadModules({
      isSecureContext: true,
      PublicKeyCredential: function () {},
      navigator: { credentials: { get: async () => fakeAssertion } },
      fetch: async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        let payload = {};
        if (url === 'https://idm.example.test/v1/reauth') {
          payload = { sessionid: 're-2', state: { choose: ['passkey'] } };
        } else if (url === 'https://idm.example.test/v1/auth' && body.step && body.step.begin === 'passkey') {
          payload = { sessionid: 're-2', state: { 'continue': [{ passkey: { publicKey: { challenge: 'Y2hhbGxlbmdl', rpId: 'x' } } }] } };
        } else if (url === 'https://idm.example.test/v1/auth' && body.step && body.step.cred) {
          payload = { sessionid: 're-2', state: { success: 'rw-token-2' } };
        } else if (url === 'https://idm.example.test/v1/self/_uat') {
          payload = { session_id: 's-2', purpose: { readwrite: { expiry: Math.floor(Date.now() / 1000) + 600 } } };
        } else {
          throw new Error('unexpected ' + url + ' ' + JSON.stringify(body));
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
    });
    w2.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    w2.Store.setUser({ name: 'bob', display_name: 'Bob', mail: '', roles: [], token: 'old-2', authMethod: 'sso' });
    assertEq(await w2.Auth.stepUp(), true, 'choose-then-begin variant also steps up');
    assertEq(w2.Store.user.token, 'rw-token-2', 'token swapped in choose variant');
  });

  await test('403 toast: read-only session points at step-up, not at roles', async () => {
    const toasts = [];
    const w = loadModules({
      document: {
        // readyState 'loading' keeps app.js boot() deferred (never fires).
        readyState: 'loading',
        addEventListener() {},
        createElement: () => ({
          setAttribute() {}, className: '',
          classList: { add() {}, remove() {} },
          set textContent(v) { toasts.push(v); },
          appendChild() {}, addEventListener() {}, style: {},
          parentNode: null, ownerDocument: null
        }),
        querySelector: () => null,
        body: { appendChild() {} }
      }
    });
    w.Store.setUser({ name: 'a', display_name: 'A', mail: '', roles: ['idm_people_admins'], token: 't', authMethod: 'passkey' });
    w.Store.setWriteExpiry(0); // interactive session = read-only
    w.Ui.handleError({ status: 403, message: '' }, 'people');
    assert(toasts.some((m) => /read-only/i.test(m) && /Unlock write access/i.test(m)),
      'read-only session: 403 explains the step-up, got: ' + JSON.stringify(toasts));
    assert(!toasts.some((m) => /idm_people_admins role/i.test(m)),
      'roles hint must NOT fire while the session is the real cause');
    // With an active write window, the original tier explanation applies.
    toasts.length = 0;
    w.Store.setWriteExpiry(Math.floor(Date.now() / 1000) + 600);
    w.Ui.handleError({ status: 403, message: '' }, 'people');
    assert(toasts.some((m) => /idm_people_admins/i.test(m)), 'with r/w window, role tiers are explained again');
  });

  await test('API client: 401 normalisation', async () => {
    const w = loadModules({
      fetch: async () => ({ status: 401, ok: false, text: async () => '{"message":"unauthorized"}', statusText: 'Unauthorized' })
    });
    w.Store.user = { token: 'x' };
    let err = null;
    try { await w.Api.listPeople(); } catch (e) { err = e; }
    assert(err, '401 throws');
    assertEq(err.status, 401, '401 status');
    assertEq(err.message, 'session expired', '401 message');
    assertEq(err.code, '401', '401 code');
    // Features with no Kanidm 1.10 REST surface must NOT exist as stubs —
    // dead "501 not mapped" shims (audit, invitations, other sessions,
    // recycle restore/purge, SCIM import) were removed outright.
    for (const gone of ['listAudit', 'createInvite', 'listInvites', 'revokeInvite',
      'restorePerson', 'restoreGroup', 'purge', 'listSessions', 'revokeSession',
      'revokeAllSessions', 'importScim', 'registerUserPasskey']) {
      assertEq(typeof w.Api[gone], 'undefined', `dead stub ${gone} removed`);
    }
  });

  await test('API client: recycle bin, self UAT and whoami unwrapping (real 1.10 endpoints)', async () => {
    const calls = [];
    const w = loadModules({
      fetch: async (url, init) => {
        calls.push({ url, init });
        let payload = [];
        if (url === 'https://idm.example.test/v1/recycle_bin') payload = [{ attrs: { name: ['old'], uuid: ['u-1'], class: ['person', 'recycled', 'object'] } }];
        if (url === 'https://idm.example.test/v1/recycle_bin/u-1/_revive') payload = {};
        if (url === 'https://idm.example.test/v1/self/_uat') payload = { session_id: 's-1', purpose: 'ReadWrite' };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
      }
    });
    w.Store.user = { token: 'x' };
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    const recycled = await w.Api.listRecycled();
    assertEq(recycled.length, 1, 'recycled entries listed');
    await w.Api.reviveRecycled('u-1');
    const uat = await w.Api.getSelfUat();
    assertEq(uat.session_id, 's-1', 'UAT returned');
    const urls = calls.map((c) => c.url);
    assertIncludes(urls, 'https://idm.example.test/v1/recycle_bin', 'GET /v1/recycle_bin');
    assertIncludes(urls, 'https://idm.example.test/v1/recycle_bin/u-1/_revive', 'POST _revive by uuid');
    assertIncludes(urls, 'https://idm.example.test/v1/self/_uat', 'GET /v1/self/_uat');
    const revive = calls.find((c) => c.url.indexOf('_revive') >= 0);
    assertEq(revive.init.method, 'POST', 'revive is a POST');
    assertEq(revive.init.body, undefined, 'revive has no body');
    // whoami WhoamiResponse { youare: Entry } unwrapping + bare tolerance.
    const wrapped = { youare: { attrs: { name: ['alice'] } } };
    assertEq(w.Api.selfEntry(wrapped).attrs.name[0], 'alice', 'youare unwrapped');
    const bare = { attrs: { name: ['bob'] } };
    assertEq(w.Api.selfEntry(bare).attrs.name[0], 'bob', 'bare entry tolerated');
  });

  await test('API client: OAuth2 / service-account / domain wiring (verified 1.10+1.11 contracts)', async () => {
    const calls = [];
    const w = loadModules({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
      }
    });
    w.Store.user = { token: 'x' };
    w.SHENASA_CONFIG.apiUrl = 'https://idm.example.test/v1';
    await w.Api.listOauth2Clients();
    await w.Api.getOauth2Client('next cloud');
    await w.Api.createOauth2PublicClient({ name: 'nc', displayname: 'NC', originLanding: 'https://c.example.test/cb' });
    await w.Api.createOauth2BasicClient({ name: 'api', displayname: 'API', originLanding: 'https://a.example.test/' });
    await w.Api.updateOauth2Client('nc', { displayname: 'NC2', oauth2_rs_origin: ['https://c.example.test/cb'] });
    await w.Api.deleteOauth2Client('nc');
    await w.Api.getOauth2BasicSecret('api');
    await w.Api.setOauth2ScopeMap('wiki', 'it team', ['openid', 'profile']);
    await w.Api.deleteOauth2ScopeMap('wiki', 'it team');
    await w.Api.setOauth2SupScopeMap('wiki', 'it', ['openid']);
    await w.Api.deleteOauth2SupScopeMap('wiki', 'it');
    await w.Api.setOauth2ClaimMap('wiki', 'department', 'it', ['eng']);
    await w.Api.deleteOauth2ClaimMap('wiki', 'department', 'it');
    await w.Api.listServiceAccounts();
    await w.Api.createServiceAccount({ name: 'svc-ci', displayname: 'CI', entryManagedBy: 'svc-managers' });
    await w.Api.listApiTokens('svc-ci');
    await w.Api.generateApiToken('svc-ci', { label: 'ci', expiry: null, readWrite: true, compact: false });
    await w.Api.deleteApiToken('svc-ci', 'tok-1');
    await w.Api.getDomain();

    const at = (m, path) => calls.find((c) => c.method === m && c.url === 'https://idm.example.test/v1' + path);
    assert(at('GET', '/oauth2'), 'GET /v1/oauth2');
    assert(at('GET', '/oauth2/next%20cloud'), 'client name URL-encoded in path');
    assert(at('POST', '/oauth2/_public'), 'create public client endpoint');
    assert(at('POST', '/oauth2/_basic'), 'create basic client endpoint');
    var pub = at('POST', '/oauth2/_public');
    var pubBody = JSON.parse(pub.body);
    assertEq(pubBody.attrs.name[0], 'nc', 'create body is the attrs envelope');
    assertEq(pubBody.attrs.oauth2_rs_origin_landing[0], 'https://c.example.test/cb', 'landing in attrs');
    assertEq(pubBody.attrs.oauth2_strict_redirect_uri[0], 'true', 'strict redirect uri default true (bootstrap-verified shape)');
    var patch = at('PATCH', '/oauth2/nc');
    assert(patch, 'PATCH /oauth2/{rs}');
    assertEq(JSON.parse(patch.body).attrs.oauth2_rs_origin[0], 'https://c.example.test/cb', 'PATCH replace-per-attr envelope');
    assert(at('DELETE', '/oauth2/nc'), 'DELETE client');
    assert(at('GET', '/oauth2/api/_basic_secret'), 'GET basic secret');
    var sm = at('POST', '/oauth2/wiki/_scopemap/it%20team');
    assert(sm, 'scope map POST path (group segment encoded)');
    assertEq(JSON.parse(sm.body)[1], 'profile', 'scope map body is a BARE array of scopes');
    assert(at('DELETE', '/oauth2/wiki/_scopemap/it%20team'), 'scope map DELETE');
    assert(at('POST', '/oauth2/wiki/_sup_scopemap/it'), 'sup scope map POST');
    assert(at('DELETE', '/oauth2/wiki/_sup_scopemap/it'), 'sup scope map DELETE');
    assert(at('POST', '/oauth2/wiki/_claimmap/department/it'), 'claim map POST /_claimmap/{claim}/{group}');
    assert(at('DELETE', '/oauth2/wiki/_claimmap/department/it'), 'claim map DELETE');
    assert(at('GET', '/service_account'), 'list service accounts');
    var svc = at('POST', '/service_account');
    assert(svc, 'create service account POST');
    assertEq(JSON.parse(svc.body).attrs.entry_managed_by[0], 'svc-managers', 'entry_managed_by REQUIRED in create body');
    assert(at('GET', '/service_account/svc-ci/_api_token'), 'list API tokens');
    var gen = at('POST', '/service_account/svc-ci/_api_token');
    var genBody = JSON.parse(gen.body);
    assertEq(genBody.label, 'ci', 'token label');
    assertEq(genBody.expiry, null, 'no expiry serialises as null (ApiTokenGenerate serde timestamp option)');
    assertEq(genBody.read_write, true, 'read_write flag');
    assertEq(genBody.compact, false, 'compact flag');
    assert(at('DELETE', '/service_account/svc-ci/_api_token/tok-1'), 'delete API token by id');
    assert(at('GET', '/domain'), 'GET /v1/domain');
  });

  await test('RBAC: oauth2 + service-account role gates', () => {
    const w = loadModules({});
    w.Store.setUser({ name: 'a', roles: ['idm_oauth2_admins'], token: 'x', authMethod: 'sso' });
    assert(w.Store.canManageOauth2(), 'idm_oauth2_admins -> manage oauth2');
    assert(!w.Store.canManageServiceAccounts(), 'oauth role != service accounts');
    w.Store.setUser({ name: 'b', roles: ['idm_service_account_admins'], token: 'x', authMethod: 'sso' });
    assert(w.Store.canManageServiceAccounts(), 'idm_service_account_admins -> manage svc accounts');
    assert(!w.Store.canManageOauth2(), 'svc role != oauth2');
    w.Store.setUser({ name: 'c', roles: ['idm_admins', 'idm_people_admins'], token: 'x', authMethod: 'sso' });
    assert(!w.Store.canManageOauth2(), 'idm_admins has NO oauth2 power (builtin ACPs)');
    assert(!w.Store.canManageServiceAccounts(), 'idm_admins has NO service-account power');
  });

  await test('validation: oauth client / service account / api token forms', () => {
    const w = loadModules({});
    const V = w.Validation;
    assert(!V.oauthClientForm({ name: 'Bad Name', displayname: 'X', originLanding: 'https://a.example.test/' }).ok, 'id with caps rejected');
    assert(!V.oauthClientForm({ name: 'nc', displayname: 'X', originLanding: 'http://a.example.test/' }).ok, 'http landing rejected — Kanidm requires https');
    assert(!V.oauthClientForm({ name: 'nc', displayname: 'X', originLanding: 'not-a-url' }).ok, 'garbage landing rejected');
    assert(V.oauthClientForm({ name: 'nc', displayname: 'X', originLanding: 'https://a.example.test/cb' }).ok, 'https landing accepted');
    assert(!V.serviceAccountForm({ name: 'svc-ci', displayname: 'CI', entryManagedBy: '' }).ok, 'managed-by REQUIRED (server rejects empty)');
    assert(V.serviceAccountForm({ name: 'svc-ci', displayname: 'CI', entryManagedBy: 'svc-managers' }).ok, 'valid svc account form');
    assert(!V.apiTokenForm({ label: '', expiry: '' }).ok, 'token label required');
    assert(!V.apiTokenForm({ label: 'ci', expiry: 'next friday' }).ok, 'token expiry must be a real date when present');
    assert(V.apiTokenForm({ label: 'ci', expiry: '' }).ok, 'empty expiry = never expires (allowed)');
    assert(!V.tokenList('openid "profile"', 'scopes').ok, 'quote chars rejected in scope list');
    assert(V.tokenList('openid profile,email groups', 'scopes').ok, 'space/comma separated scopes ok');
    assertEq(V.parseTokenList('a b,c').length, 3, 'token list parser');
  });

  await test('config: idleTimeoutMin parsing and clamping', () => {
    // Default = disabled.
    let w = loadModules({});
    assertEq(w.ShenaConfig.idleTimeoutMin(), 0, 'default 0 (disabled)');
    w.SHENASA_CONFIG.idleTimeoutMin = '30';
    assertEq(w.ShenaConfig.idleTimeoutMin(), 30, 'string minutes parsed');
    w.SHENASA_CONFIG.idleTimeoutMin = '99999';
    assertEq(w.ShenaConfig.idleTimeoutMin(), 1440, 'clamped at 24h');
    w.SHENASA_CONFIG.idleTimeoutMin = '-5';
    assertEq(w.ShenaConfig.idleTimeoutMin(), 0, 'negative means disabled');
    w.SHENASA_CONFIG.idleTimeoutMin = 'abc';
    assertEq(w.ShenaConfig.idleTimeoutMin(), 0, 'garbage means disabled');
    // Only allowed keys are persisted — idleTimeoutMin must be among them.
    w.ShenaConfig.save({ idleTimeoutMin: '15', sneakyKey: 'x' });
    const stored = JSON.parse(w.localStorage.getItem('shenasa.config'));
    assertEq(stored.idleTimeoutMin, '15', 'idle timeout persisted');
    assertEq(typeof stored.sneakyKey, 'undefined', 'unknown keys rejected');
  });

  await test('deploy: security headers and no TLS verification bypass', () => {
    const caddy = readFile('deploy/Caddyfile.example');
    const nginx1 = readFile('deploy/nginx/single-origin.conf.example');
    const nginx2 = readFile('deploy/nginx/two-domain.conf.example');
    for (const [name, text] of [['Caddyfile', caddy], ['nginx single-origin', nginx1], ['nginx two-domain', nginx2]]) {
      const low = text.toLowerCase();
      assertIncludes(low, 'strict-transport-security', name + ' HSTS');
      assertIncludes(low, 'x-content-type-options', name + ' nosniff');
      assertIncludes(low, 'x-frame-options', name + ' frame deny');
      assertIncludes(low, 'referrer-policy', name + ' referrer policy');
      assertIncludes(low, 'permissions-policy', name + ' permissions policy');
      assertIncludes(low, 'content-security-policy', name + ' CSP');
    }
    // Clickjacking protection via the CSP HEADER (invalid inside <meta>).
    assertIncludes(caddy.toLowerCase(), "frame-ancestors 'none'", 'Caddy CSP header frame-ancestors');
    // No production config may disable TLS verification.
    const deployFiles = [
      'deploy/server.toml.example', 'deploy/docker-compose.yml', 'deploy/Caddyfile.example',
      'deploy/setup.sh', 'deploy/bootstrap.sh', 'deploy/seed.sh',
      'deploy/nginx/single-origin.conf.example', 'deploy/nginx/two-domain.conf.example'
    ];
    for (const f of deployFiles) {
      const text = readFile(f);
      if (/tls_insecure_skip_verify\s*=\s*true/i.test(text)) {
        throw new Error(`${f} enables tls_insecure_skip_verify`);
      }
    }
    const compose = readFile('deploy/docker-compose.yml');
    assertIncludes(compose, 'kanidm/server', 'compose uses real Kanidm image');
    // Docker Hub tags for kanidm/server have NO "v" prefix (verified against
    // the Docker Hub API: :1.10.5 exists, :v1.10.5 is HTTP 404). The tag
    // must be a concrete pinned release — never a bare/:latest/:devel drift
    // and never a nonexistent "vX.Y.Z" reference (F5 shipped this bug).
    const imgMatch = compose.match(/image:\s*kanidm\/server:([^\s"']+)/);
    assert(imgMatch, 'compose pins a kanidm/server tag');
    const imgTag = imgMatch[1];
    assert(/^\d+\.\d+\.\d+$/.test(imgTag), `compose tag "${imgTag}" is a pinned semver release`);
    assert(!/^v/.test(imgTag), `compose tag "${imgTag}" must not use the git-style "v" prefix (Docker Hub has none)`);
    assert(imgTag !== 'latest' && imgTag !== 'devel', 'compose tag is not a drifting channel');
    // The pinned release line must be one Shenasa declares support for —
    // parsed straight from js/store.js so the two can never drift apart.
    const storeSrc = readFile('js/store.js');
    const supBlock = storeSrc.match(/SUPPORTED_KANIDM:\s*\[\[([\s\S]*?)\]\]/);
    assert(supBlock, 'store.js exposes SUPPORTED_KANIDM');
    const supportedLines = [...supBlock[1].matchAll(/(\d+)\s*,\s*(\d+)/g)].map((m) => `${m[1]}.${m[2]}`);
    const pinnedLine = imgTag.split('.').slice(0, 2).join('.');
    assert(supportedLines.includes(pinnedLine),
      `compose pin ${imgTag} must sit on a supported Kanidm line (${supportedLines.join(' / ')})`);
    // setup.sh must structurally prevent Kanidm DOWNGRADES: refuse a pin
    // older than the deployed image, and diagnose the one-way-migration
    // crash loop on readiness timeout (MG0010DowngradeNotAllowed is the
    // exact upstream refusal, observed live: domain 15 → target 14).
    const setupSh = readFile('deploy/setup.sh');
    assertIncludes(setupSh, 'docker inspect', 'setup.sh reads the deployed image tag');
    assertIncludes(setupSh, 'sort -V', 'setup.sh semver-compares image tags');
    assertIncludes(setupSh, 'refusing to DOWNGRADE Kanidm', 'setup.sh aborts on an older image pin');
    assertIncludes(setupSh, 'MG0010DowngradeNotAllowed', 'setup.sh diagnoses the downgrade crash loop');
    assertIncludes(setupSh, 'upgrade-policy', 'setup.sh references the upstream upgrade policy');
    const serverToml = readFile('deploy/server.toml.example');
    assertIncludes(serverToml, 'tls_chain', 'server.toml TLS chain');
    assertIncludes(serverToml, 'bindaddress', 'server.toml bind address');
  });

  await test('index.html: CSP, script order, no inline scripts', () => {
    const html = readFile('index.html');
    assertIncludes(html, "script-src 'self'", 'CSP script-src self');
    // frame-ancestors is invalid in <meta> CSP (browsers warn + ignore);
    // it must instead come from the HTTP header in the deploy configs.
    const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    assert(m, 'meta CSP present');
    assert(m[1].indexOf('frame-ancestors') < 0, 'no frame-ancestors in the meta CSP value');
    assertIncludes(html, "img-src 'self' data:", 'CSP img-src allows data: QR');
    for (const f of JS_FILES) assertIncludes(html, `src="js/${f}"`, `references js/${f}`);
    assertIncludes(html, 'href="css/styles.css"', 'references styles.css');
    const scripts = [...html.matchAll(/<script src="js\/([a-z]+\.js)"><\/script>/g)].map((m) => m[1]);
    assert(scripts.indexOf('config.js') < scripts.indexOf('api.js'), 'config before api');
    assert(scripts.indexOf('ui.js') < scripts.indexOf('pages.js'), 'ui before pages');
    assert(scripts.indexOf('pages.js') < scripts.indexOf('app.js'), 'pages before app');
  });

  await test('CI: shell scripts run under bash; integration image pinned', () => {
    // Ubuntu's sh is dash and aborts on `set -o pipefail` — bash-only
    // scripts must be invoked with bash explicitly (this exact bug kept
    // the real integration suite from ever executing before v1.1.0;
    // observed on the first GitHub CI run: "Illegal option -o pipefail").
    const ci = readFile('.github/workflows/ci.yml');
    assert(!/run:\s*sh\s+\S+\.sh/.test(ci), 'CI never invokes .sh scripts via sh (dash)');
    assertIncludes(ci, 'bash test/integration.sh', 'CI runs the integration suite via bash');
    const it = readFile('test/integration.sh');
    assertIncludes(it, '#!/usr/bin/env bash', 'integration.sh declares bash');
    assertIncludes(it, 'set -euo pipefail', 'integration.sh uses pipefail (bash-only)');
    const img = it.match(/SHENASA_IT_IMAGE:-kanidm\/server:([^}\s]+)\}/);
    assert(img, 'integration.sh exposes a default Kanidm image');
    assert(/^\d+\.\d+\.\d+$/.test(img[1]), `integration default image is a pinned release (${img[1]}), never :latest`);
    // Create envelope verified against libs/client/src/oauth.rs — attrs are
    // name/displayname/oauth2_rs_origin_landing; the internal class attr
    // (oauth2_rs_name) is rejected by the schema on create. Match the
    // attribute-usage shape only (comments above may name it in prose).
    assert(!/oauth2_rs_name\s*:/.test(it), 'integration.sh must not send oauth2_rs_name on create');
    assertIncludes(it, '_scopemap/', 'integration.sh grants scopes via the dedicated endpoint');
  });

  await test('privacy: no private deployment identifiers in shipped sources', () => {
    // Nothing in the public repo may name a real deployment (internal
    // domains, hostnames); shipped defaults use *.example.com placeholders.
    const files = ['index.html', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'css/styles.css',
      'deploy/setup.sh', 'deploy/bootstrap.sh', 'deploy/seed.sh', 'deploy/README.md',
      'deploy/docker-compose.yml', 'deploy/server.toml.example', 'deploy/Caddyfile.example',
      'deploy/Caddyfile.ui', 'deploy/Dockerfile.ui',
      'deploy/nginx/single-origin.conf.example', 'deploy/nginx/two-domain.conf.example',
      'docs/ROADMAP.md', 'docs/USER-GUIDE.md'].concat(JS_FILES.map((f) => 'js/' + f));
    for (const f of files) {
      const m = readFile(f).match(/avvalman|fastcreate/i);
      if (m) throw new Error(`${f} leaks a private deployment identifier: "${m[0]}"`);
    }
    const cfg = readFile('js/config.js');
    assertIncludes(cfg, "apiUrl: 'https://idm.example.com/v1'", 'config.js default apiUrl is the example placeholder');
    assertIncludes(cfg, "oidcRedirectUri: 'https://idm.example.com/oauth2/redirect'", 'config.js default redirect is the example placeholder');
  });

  await test('source: English-only (no Persian characters)', () => {
    for (const f of ['index.html', 'css/styles.css', ...JS_FILES.map((x) => 'js/' + x),
      'README.md', 'deploy/README.md']) {
      const text = readFile(f);
      const m = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/.exec(text);
      if (m) throw new Error(`${f} contains Persian/Arabic character U+${m[0].charCodeAt(0).toString(16)}`);
    }
  });

  // ------------------------------------------------------------------
  // DOM tests (jsdom)
  // ------------------------------------------------------------------
  let JSDOM = null;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch (e) {
    console.log('\njsdom not installed — DOM suite skipped (run `npm install`).');
    for (const n of ['login screen', 'dashboard charts', 'nav real endpoints', 'settings gating',
      'users list + RBAC gating', 'groups list', 'profile', 'recycle bin', 'sessions UAT',
      'settings no-mock', 'XSS inert injection']) skip(n, 'jsdom missing');
  }

  if (JSDOM) {
    console.log('\nDOM tests (jsdom)\n-----------------');

    const fakePeople = [
      { attrs: { name: ['alice'], displayname: ['Alice Admin'], mail: ['alice@example.test'], uuid: ['u1'], memberof: ['idm_admins@idm.example.test'], passkeys: ['pk-a'] } },
      { attrs: { name: ['bob'], displayname: ['Bob Bystander'], mail: ['bob@example.test'], uuid: ['u2'], memberof: ['staff@idm.example.test'], account_expire: ['2020-01-01T00:00:00Z'] } },
      { attrs: { name: ['carol'], displayname: ['<img src=x onerror=window.__pwned=1>'], mail: ['carol@example.test'], uuid: ['u3'], account_valid_from: ['2999-01-01T00:00:00Z'] } },
      { attrs: { name: ['dave'], displayname: ['=cmd|/c calc'], mail: ['dave@example.test'], uuid: ['u4'] } }
    ];
    const fakeGroups = [
      { attrs: { name: ['idm_admins'], displayname: ['Admins'], member: ['alice@idm.example.test'] } },
      { attrs: { name: ['staff'], displayname: ['Staff'], description: ['Staff team group'], member: ['alice@idm.example.test', 'bob@idm.example.test', 'team@idm.example.test'], entry_managed_by: ['idm_access_control_admins@idm.example.test'] } },
      { attrs: { name: ['team'], displayname: ['Team'], member: ['carol@idm.example.test'] } }
    ];
    const fakeRecycled = [
      { attrs: { name: ['old-bob'], uuid: ['11111111-2222-3333-4444-555555555555'], class: ['person', 'account', 'recycled', 'object'] } },
      { attrs: { uuid: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], class: ['group', 'recycled', 'object'] } }
    ];
    const fakeUat = {
      session_id: 'sess-uuid-1', spn: 'alice@idm.example.test', displayname: 'Alice Admin',
      issued_at: '2026-08-01T10:00:00Z', expiry: '2026-08-01T14:00:00Z', purpose: 'ReadWrite'
    };
    const fakeClients = [
      { attrs: { name: ['nextcloud'], displayname: ['Nextcloud Files'], uuid: ['u-nc'],
        class: ['object', 'oauth2_resource_server', 'oauth2_resource_server_basic'],
        oauth2_rs_origin_landing: ['https://cloud.example.test/login'],
        oauth2_strict_redirect_uri: ['true'],
        oauth2_rs_origin: ['https://cloud.example.test/login'],
        oauth2_rs_scope_map: ['it-team: [openid, profile, email]'],
        oauth2_rs_claim_map: ['department: it-team: [engineering platform]'] } },
      { attrs: { name: ['wiki'], displayname: ['Wiki'], uuid: ['u-wk'],
        class: ['object', 'oauth2_resource_server'],
        oauth2_rs_origin_landing: ['https://wiki.example.test/'] } }
    ];
    const fakeSvcAccounts = [
      { attrs: { name: ['svc-ci'], displayname: ['CI Deployer'], entry_managed_by: ['svc-managers'], uuid: ['u-svc'] } }
    ];
    const fakeApiTokens = [
      { token_id: 'tok-1', label: 'ci', issued_at: 1700000000, expiry: null, purpose: 'readwrite' },
      { token_id: 'tok-2', label: 'poll', issued_at: 1700000001, expiry: 1893456000, purpose: 'readonly' }
    ];
    const calls = { revived: [], api: [] };
    function makeFakeApi() {
      return {
        attr: (e, n) => (e && e.attrs && e.attrs[n] ? e.attrs[n][0] : undefined),
        attrs: (e, n) => (e && e.attrs && e.attrs[n] ? e.attrs[n] : []),
        accountStatus: (p) => (env.Api ? env.Api.accountStatus(p) : 'active'),
        accountActive: () => true,
        stats: async () => ({
          totalUsers: fakePeople.length, totalGroups: fakeGroups.length,
          activeUsers: 1, passkeyOnlyUsers: 0, people: fakePeople, groups: fakeGroups
        }),
        analytics: async () => ({
          membersPerGroup: fakeGroups.map((g) => ({ name: g.attrs.name[0], count: g.attrs.member.length })),
          passkeyUsers: 1, totalUsers: fakePeople.length, passkeyAdoption: 33
        }),
        listPeople: async () => fakePeople,
        listGroups: async () => fakeGroups,
        getPerson: async (n) => fakePeople.find((p) => p.attrs.name[0] === n),
        getGroup: async (n) => fakeGroups.find((g) => g.attrs.name[0] === n),
        // REAL shape of Kanidm 1.10 whoami: WhoamiResponse { youare: Entry }.
        getSelf: async () => ({ youare: fakePeople[0] }),
        listRecycled: async () => fakeRecycled,
        reviveRecycled: async (uuid) => { calls.revived.push(uuid); return {}; },
        getSelfUat: async () => fakeUat,
        createPerson: async (d) => d,
        updatePerson: async () => ({}),
        deletePerson: async () => null,
        addGroupMember: async () => null,
        removeGroupMember: async () => null,
        // v1.1: apps / service accounts / domain fixtures
        getDomain: async () => ({ attrs: { name: ['idm.example.test'], displayname: ['Example IdM'] } }),
        listOauth2Clients: async () => fakeClients,
        getOauth2Client: async (n) => fakeClients.find((c) => c.attrs.name[0] === n),
        getOauth2BasicSecret: async () => 'BASIC-SECRET-123',
        setOauth2ScopeMap: async () => ({}),
        deleteOauth2ScopeMap: async () => null,
        setOauth2SupScopeMap: async () => ({}),
        deleteOauth2SupScopeMap: async () => null,
        setOauth2ClaimMap: async () => ({}),
        deleteOauth2ClaimMap: async () => null,
        createOauth2PublicClient: async () => ({}),
        createOauth2BasicClient: async () => ({}),
        updateOauth2Client: async () => ({}),
        deleteOauth2Client: async () => null,
        listServiceAccounts: async () => fakeSvcAccounts,
        getServiceAccount: async (n) => fakeSvcAccounts.find((s) => s.attrs.name[0] === n),
        createServiceAccount: async (d) => d,
        deleteServiceAccount: async () => null,
        listApiTokens: async () => fakeApiTokens,
        generateApiToken: async () => 'FULL-TOKEN-XYZ',
        deleteApiToken: async () => null
      };
    }

    function makeDom(userRoles) {
      const dom = new JSDOM(readFile('index.html'), {
        url: 'https://shenasa.example.test/admin/?apiUrl=https://idm.example.test/v1',
        runScripts: 'outside-only',
        pretendToBeVisual: true
      });
      const w = dom.window;
      w.HTMLElement.prototype.scrollIntoView = w.HTMLElement.prototype.scrollIntoView || function () {};
      if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      for (const f of JS_FILES) w.eval(readFile(path.join('js', f)));
      w.Api = Object.assign({}, w.Api, makeFakeApi());
      if (userRoles) {
        w.Store.setUser({
          name: 'alice', display_name: 'Alice Admin', mail: 'alice@example.test',
          roles: userRoles, token: 'test-token', authMethod: 'sso'
        });
      } else {
        w.Store.clear();
      }
      return dom;
    }

    await test('login screen: SSO + passkey buttons, no demo form, no language toggle', () => {
      const dom = makeDom(null);
      const w = dom.window;
      w.App.renderLogin();
      const login = w.document.getElementById('login-root');
      const ssoBtn = login.querySelector('[data-login-sso]');
      const pkBtn = login.querySelector('[data-login-passkey]');
      assert(ssoBtn, 'SSO button present');
      assertIncludes(ssoBtn.textContent, 'Sign in with SSO', 'SSO label');
      assert(pkBtn, 'passkey button present');
      assertIncludes(pkBtn.textContent, 'Sign in with passkey', 'passkey label');
      assert(!login.querySelector('input[type=password]'), 'no password form');
      assert(!login.querySelector('input[type=text][name=username]'), 'no local username form');
      assertNotIncludes(login.innerHTML.toLowerCase(), 'demo', 'no demo mode');
      assert(!login.querySelector('select'), 'no language/mock selector in login');
      const issuer = login.querySelector('.login-issuer code');
      assert(issuer, 'issuer shown');
      assertEq(issuer.textContent, 'https://idm.example.test', 'issuer is origin root (no /v1)');
      dom.window.close();
    });

    await test('login: passkey step asks for the account name', () => {
      const dom = makeDom(null);
      const w = dom.window;
      // The harness env has no WebAuthn, so enable it like a real browser.
      w.PublicKeyCredential = function () {};
      w.isSecureContext = true;
      w.App.renderLogin();
      const login = w.document.getElementById('login-root');
      const pkBtn = login.querySelector('[data-login-passkey]');
      assert(pkBtn && !pkBtn.disabled, 'passkey button enabled with WebAuthn present');
      pkBtn.click();
      const form = login.querySelector('[data-passkey-form]');
      assert(form, 'username step appears after clicking passkey');
      const input = form.querySelector('#login-pk-username');
      assert(input, 'account-name input rendered');
      assert(!login.querySelector('[data-login-sso]'), 'SSO button swapped out during passkey step');
      const back = form.querySelector('[data-passkey-back]');
      assert(back, 'back button present');
      back.click();
      assert(login.querySelector('[data-login-sso]'), 'back returns to SSO/passkey buttons');
      assert(login.querySelector('[data-login-passkey]'), 'passkey button restored');
      dom.window.close();
    });

    await test('shell becomes visible after sign-in (no white page)', async () => {
      const dom = makeDom(['idm_admins']);
      const w = dom.window;
      w.location.hash = '#/dashboard';
      w.App.route();
      await sleep(20);
      const app = w.document.getElementById('app-root');
      const login = w.document.getElementById('login-root');
      assert(app.innerHTML.length > 100, 'shell rendered');
      assert(!app.classList.contains('hidden'), 'app-root must NOT stay hidden after sign-in');
      assert(login.classList.contains('hidden'), 'login-root hidden while signed in');
      // Session write-scope chip: interactive session = read-only, so the
      // unlock button is visible in the top bar...
      const chip = w.document.querySelector('[data-scope-chip]');
      assert(chip, 'scope chip rendered in top bar');
      assertIncludes(chip.textContent, 'Unlock write access', 'read-only chip offers step-up');
      // ...and after a simulated step-up grant it flips to the r/w state.
      w.Store.setWriteExpiry(Math.floor(Date.now() / 1000) + 600);
      w.App.route();
      await sleep(20);
      const chip2 = w.document.querySelector('[data-scope-chip]');
      assertIncludes(chip2.textContent, 'Writes until', 'r/w chip shows the window end');
      assert(!w.document.querySelector('[data-stepup]'), 'no unlock button while writable');
      dom.window.close();
    });

    await test('dashboard: stat cards and SVG charts render', async () => {
      const dom = makeDom(['idm_admins']);
      const w = dom.window;
      w.location.hash = '#/dashboard';
      w.App.route();
      await sleep(20);
      const view = w.document.getElementById('view');
      assertEq(view.querySelectorAll('.stat-card').length, 5, 'five stat cards (4 stats + domain card from GET /v1/domain)');
      assert(view.querySelectorAll('.chart svg').length >= 3, 'pie + bars + ring charts');
      assertIncludes(view.innerHTML, 'Your roles', 'roles card');
      assertIncludes(view.innerHTML, 'idm_admins', 'role chip');
      // Audit is documented as server-log-only (Kanidm 1.10 has no audit API)
      assertIncludes(view.innerHTML, 'Audit logs', 'audit-logs info card');
      assertIncludes(view.innerHTML, 'docker logs', 'points to the server log');
      dom.window.close();
    });

    await test('nav: only pages with real server endpoints (audit/invitations gone)', async () => {
      const dom = makeDom(['idm_admins']);
      const w = dom.window;
      w.location.hash = '#/dashboard';
      w.App.route();
      await sleep(20);
      const nav = w.document.querySelector('nav.sidebar');
      assertNotIncludes(nav.innerHTML, '#/audit', 'no audit nav item (no REST endpoint exists)');
      assertNotIncludes(nav.innerHTML, '#/invites', 'no invitations nav item');
      assertNotIncludes(nav.innerHTML, '#/recycle', 'recycle hidden for idm_admins (needs idm_recycle_bin_admins)');
      assertIncludes(nav.innerHTML, '#/settings', 'settings listed for a signed-in admin');
      dom.window.close();
    });

    await test('settings: requires sign-in (no pre-login access or edits)', async () => {
      const dom = makeDom(null); // NOT signed in
      const w = dom.window;
      w.location.hash = '#/settings';
      w.App.route();
      await sleep(20);
      const app = w.document.getElementById('app-root');
      const login = w.document.getElementById('login-root');
      assert(!app.querySelector('[name=apiUrl]'), 'settings form NOT rendered when signed out');
      assert(!login.classList.contains('hidden'), 'login page shown instead');
      assert(!app.innerHTML || app.classList.contains('hidden'), 'app shell stays hidden');
      dom.window.close();
    });

    await test('recycle bin: lists recycled entries, revives by uuid (real endpoints)', async () => {
      calls.revived = [];
      const dom = makeDom(['idm_recycle_bin_admins']);
      const w = dom.window;
      w.location.hash = '#/recycle';
      w.App.route();
      await sleep(20);
      const view = w.document.getElementById('view');
      assertEq(view.querySelectorAll('tbody tr').length, 2, 'two recycled rows');
      assertIncludes(view.innerHTML, 'old-bob', 'recycled person name');
      assertIncludes(view.innerHTML, 'idm_recycle_bin_admins', 'rights note shown');
      // Retention note: 7 days per Kanidm 1.10's RECYCLEBIN_MAX_AGE (7*86400
      // in server/lib/src/constants/mod.rs); no manual purge endpoint exists.
      assertIncludes(view.innerHTML, '7 days', '7-day retention documented');
      assertNotIncludes(view.innerHTML, 'data-recycle-purge', 'no dead purge button (no such endpoint in 1.10)');
      const btn = view.querySelector('[data-recycle-revive]');
      assert(btn, 'revive button for a recycle-bin admin');
      btn.click();
      await sleep(20);
      const ok = w.document.querySelector('.modal .btn-primary, .modal .btn-danger');
      assert(ok, 'confirm dialog shown');
      ok.click();
      await sleep(20);
      assertEq(calls.revived.length, 1, 'revive called');
      assertEq(calls.revived[0], '11111111-2222-3333-4444-555555555555', 'revive sends the entry uuid');
      // idm_admins alone must NOT see revive controls
      const dom2 = makeDom(['idm_admins']);
      const w2 = dom2.window;
      w2.location.hash = '#/recycle';
      w2.App.route();
      await sleep(20);
      assert(!w2.document.querySelector('[data-recycle-revive]'), 'revive hidden without idm_recycle_bin_admins');
      dom.window.close();
      dom2.window.close();
    });

    await test('sessions: shows the real current-session UAT', async () => {
      const dom = makeDom([]);
      const w = dom.window;
      w.Store.setUser({ name: 'alice', display_name: 'Alice Admin', roles: [], token: 't', authMethod: 'sso' });
      w.location.hash = '#/sessions';
      w.App.route();
      await sleep(20);
      const view = w.document.getElementById('view');
      assertIncludes(view.innerHTML, 'alice@idm.example.test', 'UAT spn shown');
      assertIncludes(view.innerHTML, 'sess-uuid-1', 'session id shown');
      assertIncludes(view.innerHTML, 'ReadWrite', 'purpose badge');
      assertIncludes(view.innerHTML, '2026-08-01', 'issued time rendered');
      assert(!view.querySelector('[data-session-revoke]'), 'no made-up revoke buttons');
      dom.window.close();
    });

    await test('groups 403: toast names the Kanidm permission tiers (high-privilege rule)', async () => {
      const dom = makeDom(['idm_admins']);
      const w = dom.window;
      // Active write window => a 403 is genuinely role-tier related; the
      // read-only-session hint (which takes precedence otherwise) is off.
      w.Store.setWriteExpiry(Math.floor(Date.now() / 1000) + 600);
      w.Ui.handleError({ status: 403, message: 'HTTP 403' }, 'groups');
      await sleep(5);
      const toast = w.document.querySelector('.toast, [class*=toast]');
      assert(toast, 'toast rendered');
      assertIncludes(toast.textContent, 'ordinary groups', 'tier rule explained');
      assertIncludes(toast.textContent, 'idm_access_control_admins', 'system tier named');
      // Read-only session + write 403 => step-up guidance instead of tiers.
      w.Store.setWriteExpiry(0);
      w.Ui.handleError({ status: 403, message: 'HTTP 403' }, 'groups');
      await sleep(5);
      const msgs = w.document.querySelectorAll('.toast-msg');
      const last = msgs[msgs.length - 1];
      assert(last, 'second toast rendered');
      assertIncludes(last.textContent, 'read-only', 'read-only session flagged as the real cause');
      assertIncludes(last.textContent, 'Unlock write access', 'points at the step-up action');
      dom.window.close();
    });

    await test('users list: renders rows, RBAC gating, PII gating', async () => {
      // admin sees everything (people management needs idm_people_admins,
      // NOT idm_admins — Kanidm 1.10 builtin ACPs)
      let dom = makeDom(['idm_people_admins']);
      let w = dom.window;
      w.location.hash = '#/users';
      w.App.route();
      await sleep(20);
      let view = w.document.getElementById('view');
      assertEq(view.querySelectorAll('tbody tr').length, 4, 'four user rows');
      assert(view.querySelector('[data-users-new]'), 'New user button for idm_people_admins');
      assertIncludes(view.innerHTML, 'alice@example.test', 'PII mail visible to admin');
      assert(view.querySelector('[data-user-delete]'), 'delete button gated ON');
      assertIncludes(view.innerHTML, 'Expired', 'status badge computed');
      assertIncludes(view.innerHTML, 'Not yet valid', 'future valid_from badge');

      // CSV export is formula-injection safe: the "=cmd|/c calc" display
      // name must be escaped with a leading apostrophe, not exported raw.
      let downloaded = null;
      const origDownload = w.Ui.download;
      w.Ui.download = (name, content) => { downloaded = { name, content }; };
      view.querySelector('[data-users-export-csv]').click();
      w.Ui.download = origDownload;
      assert(downloaded, 'export triggered');
      assertIncludes(downloaded.content, "'=cmd|/c calc", 'formula cell neutralised with apostrophe');
      dom.window.close();

      // plain user: no management buttons, PII hidden
      dom = makeDom(['staff']);
      w = dom.window;
      w.location.hash = '#/users';
      w.App.route();
      await sleep(20);
      view = w.document.getElementById('view');
      assert(!view.querySelector('[data-users-new]'), 'New user button hidden without roles');
      assert(!view.querySelector('[data-user-delete]'), 'delete hidden without roles');
      assertNotIncludes(view.innerHTML, 'alice@example.test', 'PII hidden without role');
      assertIncludes(view.innerHTML, 'Restricted', 'PII placeholder shown');
      dom.window.close();
    });

    await test('groups list + detail: rows, members, capabilities, managed-by', async () => {
      const dom = makeDom(['idm_group_admins']);
      const w = dom.window;
      w.location.hash = '#/groups';
      w.App.route();
      await sleep(20);
      let view = w.document.getElementById('view');
      assertEq(view.querySelectorAll('tbody tr').length, 3, 'three group rows');
      assertIncludes(view.innerHTML, 'idm_access_control_admins', 'managed-by shown');
      // Built-in roles get an annotated capability; custom groups show
      // their server-side description instead.
      assertIncludes(view.innerHTML, 'Changes membership of the built-in', 'idm_admins capability annotated');
      assertIncludes(view.innerHTML, 'Staff team group', 'custom group description shown');
      w.location.hash = '#/groups/staff';
      w.App.route();
      await sleep(20);
      view = w.document.getElementById('view');
      assertIncludes(view.innerHTML, 'Group: staff', 'group detail title');
      assertIncludes(view.innerHTML, 'Description', 'description row on detail');
      assertIncludes(view.innerHTML, 'Staff team group', 'description value on detail');
      assert(view.querySelectorAll('[data-member-remove]').length >= 2, 'member remove buttons');
      assertIncludes(view.innerHTML, 'team', 'nested group chip');
      dom.window.close();
    });

    await test('profile: identity, auth method, role-gated email edit', async () => {
      let dom = makeDom([]);
      let w = dom.window;
      w.Store.setUser({ name: 'alice', display_name: 'Alice Admin', mail: 'alice@example.test', roles: [], token: 't', authMethod: 'sso' });
      w.location.hash = '#/profile';
      w.App.route();
      await sleep(20);
      let view = w.document.getElementById('view');
      assertIncludes(view.innerHTML, 'alice', 'username');
      assertIncludes(view.innerHTML, 'sso', 'auth method badge');
      assert(!view.querySelector('[data-edit-mail]'), 'email edit hidden without idm_people_self_mail_write');
      assertIncludes(view.textContent, 'idm_people_self_mail_write', 'gating note shown');
      assert(view.querySelector('[data-register-own-passkey]'), 'register passkey button');
      dom.window.close();

      dom = makeDom([]);
      w = dom.window;
      w.Store.setUser({ name: 'alice', display_name: 'Alice Admin', mail: 'a@e.t', roles: ['idm_people_self_mail_write'], token: 't', authMethod: 'passkey' });
      w.location.hash = '#/profile';
      w.App.route();
      await sleep(20);
      view = w.document.getElementById('view');
      assert(view.querySelector('[data-edit-mail]'), 'email edit shown with idm_people_self_mail_write');
      dom.window.close();
    });

    await test('nav + gating: Apps/Service-accounts items only with their roles', async () => {
      const dom = makeDom(['idm_oauth2_admins', 'idm_service_account_admins']);
      const w = dom.window;
      w.location.hash = '#/dashboard';
      w.App.route();
      await sleep(20);
      const links = [...w.document.querySelectorAll('.nav-link')].map((a) => a.getAttribute('href'));
      assert(links.indexOf('#/apps') >= 0, 'Apps visible for idm_oauth2_admins');
      assert(links.indexOf('#/svcaccounts') >= 0, 'Service accounts visible for role');
      dom.window.close();
      const dom2 = makeDom(['idm_people_admins']);
      const w2 = dom2.window;
      w2.location.hash = '#/dashboard';
      w2.App.route();
      await sleep(20);
      const links2 = [...w2.document.querySelectorAll('.nav-link')].map((a) => a.getAttribute('href'));
      assert(links2.indexOf('#/apps') < 0, 'Apps hidden without idm_oauth2_admins');
      assert(links2.indexOf('#/svcaccounts') < 0, 'Service accounts hidden without role');
      dom2.window.close();
    });

    await test('apps: list renders clients with type badges; detail shows maps + secret + strict toggle', async () => {
      const dom = makeDom(['idm_oauth2_admins']);
      const w = dom.window;
      w.location.hash = '#/apps';
      w.App.route();
      await sleep(30);
      const view = w.document.getElementById('view');
      assertIncludes(view.innerHTML, 'nextcloud', 'client row rendered');
      assertIncludes(view.innerHTML, 'basic (secret)', 'basic badge for nextcloud (class/attr derived)');
      assertIncludes(view.innerHTML, 'public (PKCE)', 'public badge for wiki');
      // detail: renderShell replaces #view on each route — re-query after
      // navigating, a stale element would still show the LIST page.
      w.location.hash = '#/apps/nextcloud';
      w.App.route();
      await sleep(30);
      const view2 = w.document.getElementById('view');
      assertIncludes(view2.innerHTML, 'App:', 'detail page rendered');
      assertIncludes(view2.innerHTML, 'https://cloud.example.test/login', 'landing shown');
      assert(view2.querySelector('[data-strict]'), 'strict toggle present');
      assertEq(view2.querySelector('[data-strict]').checked, true, 'strict on per server value');
      assert(view2.querySelector('[data-reveal-secret]'), 'reveal-secret only for basic clients');
      assertIncludes(view2.innerHTML, 'it-team', 'scope map group parsed from text form');
      assertIncludes(view2.innerHTML, 'openid, profile, email'.split(',')[0], 'scope map scopes shown');
      assertIncludes(view2.innerHTML, 'department', 'claim map claim parsed (two-key form)');
      assertIncludes(view2.innerHTML, 'engineering platform', 'claim values shown');
      assert(view2.querySelector('[data-map-del="scope:0"]'), 'parsed scope row actionable');
      assert(view2.querySelector('[data-map-del="claim:0"]'), 'parsed claim row actionable');
      // origins list + strict toggle are real PATCH-backed controls:
      assert(view2.querySelector('[data-origin-add]'), 'add redirect URI control');
      dom.window.close();
    });

    await test('apps: public client detail has NO secret button (not a fake control)', async () => {
      const dom = makeDom(['idm_oauth2_admins']);
      const w = dom.window;
      w.location.hash = '#/apps/wiki';
      w.App.route();
      await sleep(30);
      const view = w.document.getElementById('view');
      assert(!view.querySelector('[data-reveal-secret]'), 'no secret reveal for public client');
      assertIncludes(view.innerHTML, 'no secret by design', 'explanation shown instead');
      dom.window.close();
    });

    await test('apps/svc denied views without roles (deep link safe)', async () => {
      const dom = makeDom(['idm_people_admins']);
      const w = dom.window;
      w.location.hash = '#/apps';
      w.App.route();
      await sleep(20);
      assertIncludes(w.document.getElementById('view').innerHTML, 'idm_oauth2_admins', 'apps deep link names required role');
      w.location.hash = '#/svcaccounts';
      w.App.route();
      await sleep(20);
      assertIncludes(w.document.getElementById('view').innerHTML, 'idm_service_account_admins', 'svc deep link names required role');
      dom.window.close();
    });

    await test('service accounts: list, token table with ro/rw badges, issue modal shows token ONCE with QR', async () => {
      const dom = makeDom(['idm_service_account_admins']);
      const w = dom.window;
      w.location.hash = '#/svcaccounts/svc-ci';
      w.App.route();
      await sleep(30);
      const view = w.document.getElementById('view');
      assertIncludes(view.innerHTML, 'svc-ci', 'account shown');
      assertIncludes(view.innerHTML, 'svc-managers', 'managed-by shown');
      assertIncludes(view.innerHTML, 'read-write', 'rw badge for tok-1 (purpose readwrite)');
      assertIncludes(view.innerHTML, 'read-only', 'ro badge for tok-2');
      assertIncludes(view.innerHTML, 'never', 'null expiry renders as never');
      assert(view.querySelector('[data-token-del^="tok-1"]'), 'delete token wired by token_id');
      // open the issue dialog and submit:
      view.querySelector('[data-token-new]').click();
      await sleep(10);
      const overlay = w.document.querySelector('.modal-overlay');
      assert(overlay, 'issue dialog opened');
      overlay.querySelector('[name=label]').value = 'ci-deploy';
      overlay.querySelector('[name=readWrite]').checked = true;
      overlay.querySelector('[data-submit]').click();
      await sleep(30);
      const modal2 = w.document.querySelector('.modal-overlay .modal-body');
      assert(modal2 && modal2.textContent.indexOf('FULL-TOKEN-XYZ') >= 0, 'full token shown exactly once post-issue');
      assertIncludes(modal2.innerHTML, 'only time', 'one-time warning copy');
      assert(modal2.querySelector('.qr-box svg'), 'QR for the token rendered');
      dom.window.close();
    });

    await test('dashboard: domain stat card renders from GET /v1/domain (tolerant)', async () => {
      const dom = makeDom(['idm_admins']);
      const w = dom.window;
      w.location.hash = '#/dashboard';
      w.App.route();
      await sleep(30);
      assertIncludes(w.document.getElementById('view').innerHTML, 'Example IdM', 'domain display name in stat card');
      dom.window.close();
    });

    await test('idle watchdog: inactive session is fully signed out', async () => {
      const dom = makeDom([]);
      const w = dom.window;
      w.Store.setUser({ name: 'alice', display_name: 'A', mail: '', roles: [], token: 't', authMethod: 'sso' });
      // Force the SAME-ORIGIN sign-out path (like the production single-origin
      // deployment): the API must live on the window's origin, and jsdom has
      // no fetch — stub it as a successful /ui/logout call.
      w.SHENASA_CONFIG.apiUrl = 'https://shenasa.example.test/v1';
      w.fetch = async (url) => {
        if (String(url).indexOf('/ui/logout') < 0) throw new Error('unexpected fetch ' + url);
        return { ok: true, status: 303 };
      };
      // 0.001 min ≈ 60 ms so the test doesn't wait a real minute; server
      // logout fetch fails offline -> Auth.signOut is expected to degrade.
      // The watchdog wakes at most once/second, so allow >1s plus margin.
      w.SHENASA_CONFIG.idleTimeoutMin = '0.001';
      w.location.hash = '#/dashboard';
      w.App.route(); // arms the watchdog
      await sleep(1800);
      const login = w.document.getElementById('login-root');
      const app = w.document.getElementById('app-root');
      assert(!login.classList.contains('hidden'), 'login shown after idle timeout');
      assert(app.classList.contains('hidden'), 'shell hidden after idle timeout');
      assertIncludes(login.textContent, 'inactivity', 'idle-out message shown');
      assert(!w.Store.isSignedIn(), 'local session cleared');
      // Watchdog must stay disarmed on the login screen (no zombie timers):
      // if it fired twice, the app root could get resurrected.
      dom.window.close();
    });

    await test('settings: renders config, no mock/demo mode anywhere', async () => {
      const dom = makeDom([]);
      const w = dom.window;
      w.Store.setUser({ name: 'alice', display_name: 'A', mail: '', roles: [], token: 't', authMethod: 'sso' });
      w.location.hash = '#/settings';
      w.App.route();
      await sleep(20);
      const view = w.document.getElementById('view');
      assert(view.querySelector('[name=apiUrl]'), 'apiUrl field');
      assert(view.querySelector('[name=oidcClientId]'), 'clientId field');
      assert(view.querySelector('[name=theme]'), 'theme select');
      assert(view.querySelector('[name=idleTimeoutMin]'), 'idle sign-out field');
      assertEq(view.querySelector('[name=idleTimeoutMin]').getAttribute('type'), 'number', 'idle field numeric');
      assert(view.querySelector('[data-settings-test]'), 'test-connection button');
      assertEq(view.querySelector('[name=apiUrl]').value, 'https://idm.example.test/v1', 'apiUrl from URL override');
      assertEq(view.querySelector('[name=oauthBase]').value, 'https://idm.example.test', 'derived origin root shown');
      // Live server compatibility row (X-KANIDM-VERSION driven):
      assert(view.querySelector('[data-server-version-row]'), 'server version row rendered');
      assertEq(view.querySelector('[data-server-version]').textContent, '—', 'no API call yet -> version undetected');
      assert(view.querySelector('[data-server-version-row] .badge'), 'compat badge rendered');
      const low = view.innerHTML.toLowerCase();
      assertNotIncludes(low, 'mock', 'no mock mode');
      assertNotIncludes(low, 'demo', 'no demo mode');
      dom.window.close();
    });

    await test('XSS: injected <img> in displayname stays inert', async () => {
      const dom = makeDom(['idm_people_admins']);
      const w = dom.window;
      w.location.hash = '#/users';
      w.App.route();
      await sleep(20);
      const view = w.document.getElementById('view');
      assert(!view.querySelector('img'), 'no <img> element materialised');
      assertIncludes(view.innerHTML, '&lt;img', 'payload rendered as escaped text');
      assertEq(typeof w.__pwned, 'undefined', 'no handler executed');
      // user detail page too
      w.location.hash = '#/users/carol';
      w.App.route();
      await sleep(20);
      assert(!view.querySelector('img'), 'no <img> on detail page');
      assertIncludes(view.innerHTML, '&lt;img', 'escaped on detail page');
      dom.window.close();
    });
  }

  // ------------------------------------------------------------------
  console.log(`\npassed: ${passed}, failed: ${failed}, skipped: ${skipped}`);
  if (failed) {
    console.error('\nFAILURES:');
    for (const f of failures) console.error(`  - ${f.name}: ${f.err && f.err.message ? f.err.message : f.err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
