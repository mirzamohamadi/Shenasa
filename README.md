# Shenasa — Admin UI for Kanidm

[![Release](https://img.shields.io/badge/release-v1.3.0-blue)](https://github.com/mirzamohamadi/shenasa/releases)
[![Kanidm compatibility](https://img.shields.io/badge/Kanidm-1.10.x%20%7C%201.11.x-blueviolet)](#compatibility)
[![CI](https://github.com/mirzamohamadi/shenasa/actions/workflows/ci.yml/badge.svg)](https://github.com/mirzamohamadi/shenasa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Shenasa is a modern, dependency-free **administration UI for the
[Kanidm](https://kanidm.com) identity management server**. It is *not* a
standalone identity provider: the real identity engine is Kanidm. Shenasa
gives administrators a clean web UI to manage users, groups, memberships,
passkeys, OAuth2/OIDC apps, service accounts, reports and sessions —
instead of using the `kanidm` CLI for everything.

The UI is a **static single-page application (SPA)** written in plain
HTML/CSS/vanilla JS: no frameworks, no build step, no runtime npm packages,
no CDNs (works offline behind an air gap). It talks directly to a **real
Kanidm server** through its REST/OIDC/WebAuthn endpoints.

```
┌──────────────────────┐   HTTPS    ┌──────────────────────────────┐
│   Shenasa UI (SPA)   │ ─────────> │       Kanidm core server     │
│  sign in: SSO (OIDC) │            │  SSO/OIDC · WebAuthn/FIDO2   │
│  or Passkey (FIDO2)  │            │  LDAP · SCIM · RBAC          │
│  users/groups/RBAC   │            │  recycle bin · enforced TLS  │
│  dashboard/sessions  │            │  (the source of truth)       │
└──────────────────────┘            └──────────────────────────────┘
```

## Compatibility

**Shenasa v1.3.0 supports Kanidm server `1.10.x` and `1.11.x`** — verified
by diffing the v1.10.5 and v1.11.0 source trees. The deploy layer pins
`kanidm/server:1.11.0` by default; `1.10.5` is the verified alternative (see
`deploy/README.md` "Running Kanidm 1.11"). `deploy/setup.sh` refuses to ever
roll the pinned image **backwards** below the tag a host already runs —
Kanidm migrations are one-way.

| Shenasa | Kanidm server | Status |
| --- | --- | --- |
| **v1.3.0** | **1.10.x** (recommended **1.10.5**) | ✅ Supported — every endpoint, auth flow, builtin ACP and error path the UI touches is source-verified against the Kanidm **v1.10.5** tree (file/line evidence in `docs/security-audit-1.0.0.md` and the CHANGELOG) |
| **v1.3.0** | **1.11.x** (verified **1.11.0**) | ✅ Supported — the `/v1` route sets of 1.10.5 and 1.11.0 are **identical** (100/100 routes); dl15 builtin ACPs are additive-only vs dl14 (self-read attribute widening, OAuth2 introspection attributes) so the role/tier mapping is unchanged; auth scope semantics, the 600 s write window and the 7-day recycle retention are the same constants |
| v1.3.0 | ≤ 1.9.x | ❌ Unsupported — earlier servers lack parts of the 1.10 REST/auth surface this UI relies on (stepped `/v1/auth` passkey flow, `/v1/reauth` write-unlock semantics) |
| v1.3.0 | ≥ 1.12.x | ⚠️ Unverified — dev series; use *at your own risk* until a Shenasa release states support |

Notes:

- The UI **auto-detects the server version** from the
  `X-KANIDM-VERSION` response header (present in both 1.10 and 1.11) and
  shows a live *supported / not supported / not detected* badge in
  **Settings** — you never have to guess what you are talking to.
- Kanidm Docker tags have **no `v` prefix** (`kanidm/server:1.10.5`, not
  `:v1.10.5`), and `:latest` tracks the **dev** branch — always pin an
  exact version.
- Browser side: any current Chrome/Edge/Firefox/Safari with
  **WebAuthn/FIDO2** support (passkey sign-in and write-unlock require
  it); JavaScript and cookies (the SSO web session) must be enabled.

## Features

- **Sign-in**: OIDC SSO (Authorization Code + PKCE, S256) or Passkey
  (FIDO2/WebAuthn). No local username/password form, no demo mode.
- **Sign-out** ends BOTH the local session and the Kanidm server session
  (GET /ui/logout), so SSO cannot silently re-log you in.
- **Dashboard**: live stat cards (users, groups, active accounts,
  passkey-only accounts), SVG charts (status pie, members-per-group bars,
  passkey-adoption ring), the server **domain card** (`GET /v1/domain`),
  your roles, and a pointer to the server's own audit log (Kanidm does not
  expose audit events over REST).
- **Users**: search, group filter, pagination; create/edit/soft-delete;
  valid-from/expiry; PII gating; CSV import + CSV/JSON export.
  **Bulk actions** (v1.3): multi-select rows, dry-run-first *add-to-group*
  (one batched request) and *set/clear expiry* (per-user preview;
  clear = attribute purge). **Onboarding wizard**: person → baseline
  groups → first-sign-in link with QR.
- **Reports** (v1.3, `idm_people_admins`): accounts expiring within N days
  (+ CSV), passkey-only adoption per group (bounded fan-out of credential
  status reads, permission-aware), and a client-side membership diff of
  two group JSON exports.
- **User detail**: edit fields (username read-only), group chips
  (add/remove), reset password (service-desk flow: one-time credential-reset
  link, with QR), impersonate guidance, passkey-only toggle
  with register-first lockout protection, passkey count. **Credential
  status card** (v1.3): live credential types/labels/UUID from
  `_credential/_status`, permission-aware; **account-recovery card** linking
  Kanidm's self-service flow honestly (no fake admin email-send).
- **Settings**: connection + theme + idle sign-out, live server-version
  compatibility (`X-KANIDM-VERSION`), the **domain editor** (v1.3,
  `domain_admins`: display name + account-recovery toggle), optional
  **community locale packs** (audited core stays English-only).
- **Groups**: search, nested-group filter, pagination; create/edit/delete;
  managed-by (role-gated); members with add/remove; nested groups;
  **membership CSV import with dry-run adds/removes/conflicts report** and a
  canonical JSON export (v1.3); per-group capability descriptions (built-in
  `idm_*` roles annotated from the server's builtin ACPs, custom groups from
  their description attribute, editable in the group dialog). Permission
  denials explain Kanidm's tiered rules (see below).
- **Apps (OAuth2/OIDC clients)** (`idm_oauth2_admins`): public (PKCE) vs
  basic (confidential) clients. Create fields are the same either way —
  Kanidm never accepts a secret on create; it generates one. After save,
  the landing URL is written as a redirect origin and a basic secret is
  shown once. Detail page: strict matching, extra origins, per-group
  **scope / supplementary-scope / claim maps**, **Reveal basic secret**.
  Operator guide: [`docs/APPS.md`](docs/APPS.md).
- **Service accounts** (`idm_service_account_admins`): create/delete
  service accounts, and full **API-token lifecycle** — list (with
  read-only/read-write badges), issue with optional expiry/compact, the
  full token shown exactly once with QR hand-off, revoke by id.
- **Recycle bin**: list soft-deleted entries and revive them (real
  `/v1/recycle_bin` endpoints; requires `idm_recycle_bin_admins`). Entries
  are retained for 7 days (Kanidm server constant), then purged by the
  server on schedule — 1.10 exposes no manual per-object purge endpoint,
  so Shenasa documents this instead of offering a dead button.
- **Sessions**: the real current-session token view (`/v1/self/_uat`).
- **Idle sign-out**: Settings → *Idle sign-out (minutes)* signs the user
  out (locally **and** server-side) after N inactive minutes; 0 = off.
- **Write unlock (step-up)**: interactive Kanidm sessions are read-only
  until re-authenticated (Kanidm design — writes need `AccessScope::
  ReadWrite`). Use **Unlock write access** in the top bar to verify your
  passkey once; a ~10-minute write window opens (same as the Kanidm UI's
  reauth and `kanidm reauth`). A top-bar chip always shows the current
  state, and a 403 on a write explains this instead of misleading role
  hints.
- **Profile (self-service)**: edit email (role-gated), register passkey,
  change password (via Kanidm's own credential-update UI), view groups and
  auth method.
- **RBAC gating**: buttons/pages are enabled from your roles — read from
  the server's own whoami (`/v1/self`, which returns
  `{"youare": {…, memberof: …}}`), with OIDC claims as fallback. The Kanidm
  **server always enforces the real authorisation** — the UI only reduces
  clutter.

### Kanidm's permission tiers (so a 403 makes sense)

Verified against the Kanidm 1.10 builtin access-control profiles
(`server/lib/src/migration_data/dl14/access.rs`):

- **Ordinary groups** are managed by **`idm_group_admins`** (builtin ACP
  `idm_acp_group_manage`, whose target *excludes* high-privilege groups).
- **Built-in `idm_*` role groups** (e.g. `idm_people_admins`,
  `idm_group_admins`, `idm_service_desk`) are `entry_managed_by:
  idm_admins` — only **`idm_admins`** members may change their members
  (builtin ACP `idm_acp_group_entry_manager`).
- **System-level groups** (`idm_high_privilege`,
  `idm_access_control_admins`, `idm_schema_admins`,
  `idm_recycle_bin_admins`, `idm_oauth2_admins`, …) are managed by
  **`idm_access_control_admins` / system admins** — not by `idm_admins`.
- The **recycle bin** requires its own role: **`idm_recycle_bin_admins`**.
- **Security**: strict CSP, hardened headers (HSTS, nosniff, frame deny,
  referrer/permissions policy), all user content HTML-escaped (XSS-safe),
  PKCE-only public client, no secrets in the browser, TLS end-to-end.
- **Light/dark theme** (with auto mode), responsive layout with a
  collapsible mobile sidebar, keyboard/ARIA accessibility.
- **Dependency-free QR code** for credential-reset links (own encoder: byte
  mode, versions 1–10, ECC L/M, Reed–Solomon, mask scoring), rendered as
  inline SVG.

## Quick start (development)

```sh
npm install        # dev-only: jsdom for tests
npm run check      # syntax lint + smoke tests
npm start          # static dev server at http://localhost:8080
```

Then point the UI at a Kanidm server — either through the **Settings** page
or by URL parameters (handy on someone else's deployment):

```
https://…/?apiUrl=https://idm.example.com/v1&oidcClientId=shenasa_admin_ui&oidcRedirectUri=https://…/
```

## Deploying with a real Kanidm server

The `deploy/` layer brings up **Kanidm + Shenasa together** (two supported
topologies):

- **A — single-origin**: Kanidm and Shenasa on the same domain, SPA under
  `/admin/`. `https://idm.example.com/admin/`
- **B — two-domain**: Kanidm on `idm.example.com`, Shenasa on
  `shenasa.example.com` (CORS handled by template configs; a same-origin API
  proxy makes CORS unnecessary in practice).

```sh
# single-origin, one command (certs, configs, containers, OAuth2 client):
bash deploy/setup.sh idm.example.com

# two-domain:
bash deploy/setup.sh idm.example.com shenasa.example.com

# pick the pieces manually instead:
make setup IDM_DOMAIN=idm.example.com
make up down logs bootstrap seed
```

See **[deploy/README.md](deploy/README.md)** for the two-phase guide and
verification checklist.

### Serving the SPA yourself

The SPA is fully static: serve `index.html`, `css/`, `js/` from any web
server with the headers from `deploy/nginx/*.example` or
`deploy/Caddyfile.ui`. A container image is available:

```sh
docker build -f deploy/Dockerfile.ui -t shenasa-ui .
docker run --rm -p 8080:80 shenasa-ui
```

## Configuration

`js/config.js` holds **public** values only (the OAuth2 client is a public
PKCE client — there is no secret):

| key | default | notes |
| --- | --- | --- |
| `apiUrl` | `https://idm.example.com/v1` | Kanidm REST base, **ends in `/v1`** |
| `oidcClientId` | `shenasa_admin_ui` | public OAuth2 client |
| `oidcScope` | `openid profile email groups` | without `groups` Kanidm will not emit the SPNs Shenasa maps to UI roles |
| `oidcRedirectUri` | `https://idm.example.com/oauth2/redirect` | must be registered on the client |
| `theme` | `light` | `light`/`dark`/`auto` |

Overrides (precedence: URL query > localStorage (Settings page) > defaults):

```
?apiUrl=&oidcClientId=&oidcScope=&oidcRedirectUri=&theme=
```

> **Important:** the OIDC entry points live at the **origin root**, not
> under `/v1`. Shenasa derives that base by stripping a trailing `/v1` from
> `apiUrl`. The browser-facing authorise page is `/ui/oauth2` (what Kanidm's
> discovery document publishes as `authorization_endpoint`), tokens go to
> `/oauth2/token`, discovery lives under `/oauth2/openid/<client>/…`, and
> passkey sign-in steps through `/v1/auth` (init → begin → cred). Only
> `/v1/*` calls are REST API calls.

## Security model

- Sign-in happens at Kanidm; Shenasa only receives an `id_token` via
  Authorization Code + PKCE (state + nonce + S256 challenge). Kanidm's
  OIDC access token is deliberately **not** usable on the `/v1` management
  API (verified against the 1.10 source: `/v1` only trusts domain-key
  UserAuthTokens or service-account API tokens), so SSO mode authenticates
  REST calls with the Kanidm web-session cookie created during the
  authorise journey — the same mechanism Kanidm's own UI uses. Passkey
  sign-in steps through `/v1/auth` and yields a genuine UserAuthToken,
  which Shenasa sends as a bearer.
- Tokens live in memory/sessionStorage (no cookies set by Shenasa, nothing
  in localStorage except the public config override).
- RBAC only gates UI elements; every operation is re-authorised by Kanidm.
- Content-Security-Policy: `script-src 'self'` (no inline JS anywhere),
  `style-src 'self'` (**no `unsafe-inline` since v1.3** — chart swatches are
  SVG attributes, everything else is external CSS), `img-src 'self' data:`,
  plus `object-src 'none'`, `frame-ancestors 'none'`, `base-uri`/
  `form-action 'self'`. Reverse proxies add HSTS, `X-Content-Type-Options`,
  `X-Frame-Options DENY`, `Referrer-Policy no-referrer` and a
  `Permissions-Policy`.
- All user-provided values are escaped (`Ui.esc`) before reaching HTML; the
  smoke tests verify injected markup stays inert.
- No demo mode, no mock backend, no test users, no secrets in the repo or
  the public config, and production deployments never disable TLS
  verification.

Found an issue? See **[SECURITY.md](SECURITY.md)**.

## Tests

```sh
npm test              # jsdom smoke tests (fake API injected for tests only)
node scripts/check-syntax.js
bash test/integration.sh   # spins up a REAL Kanidm container and verifies
```

CI (`.github/workflows/ci.yml`) runs: lint + tests (Node 20/22), the UI
container build, a real-Kanidm integration test, and `npm audit`.

## Project layout

```
index.html            SPA shell (login + app), CSP meta
css/styles.css        design tokens, light/dark themes
js/  config.js i18n.js store.js api.js validation.js ui.js auth.js
     qrcode.js pages.js app.js        (plain scripts, loaded in order)
docs/  openapi.yaml          endpoints the client uses
       USER-GUIDE.md         every page + RBAC/tiering
       APPS.md               OAuth2/OIDC operator guide
       GITHUB-RELEASE-v1.3.0.md  paste-ready GitHub release pack
       RELEASING.md          maintainer release procedure
       ROADMAP.md            public development roadmap
       security-audit-1.0.0.md   pre-1.0 audit evidence
deploy/               docker-compose, Caddyfile, nginx examples, scripts
scripts/  check-syntax.js, serve.js
test/     smoke.test.js (jsdom), integration.sh (real Kanidm)
```

## Documentation

- **[docs/USER-GUIDE.md](docs/USER-GUIDE.md)** — how every page works,
  everyday operations, and the **RBAC & tiering** model.
- **[docs/APPS.md](docs/APPS.md)** — OAuth2/OIDC clients: create contract,
  secret/origin behaviour, scope maps, adding a third-party app.
- **[docs/GITHUB-RELEASE-v1.3.0.md](docs/GITHUB-RELEASE-v1.3.0.md)** —
  paste-ready GitHub About text, tag commands; notes in
  [`docs/RELEASE-NOTES-v1.3.0.md`](docs/RELEASE-NOTES-v1.3.0.md).
- **[docs/openapi.yaml](docs/openapi.yaml)** — the Kanidm endpoints the
  client uses.
- **[docs/security-audit-1.0.0.md](docs/security-audit-1.0.0.md)** —
  pre-1.0 security audit evidence.
- **[docs/RELEASING.md](docs/RELEASING.md)** — maintainer release
  procedure (GitHub publish checklist).
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — public development roadmap.
- **[GO-LIVE-checklist.md](GO-LIVE-checklist.md)** — production go-live
  checklist.

## Contributing & license

See **[CONTRIBUTING.md](CONTRIBUTING.md)** and
**[CHANGELOG.md](CHANGELOG.md)**.
Shenasa is released under the **[MIT license](LICENSE)**.
