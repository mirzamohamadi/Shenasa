# Changelog

All notable changes to Shenasa are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

(No changes yet.)

## [1.0.0] - 2026-08-06

First stable public release. Shipped after a full security audit of every
code path (see `docs/security-audit-1.0.0.md`): XSS-sink review, OIDC
claim binding, CSRF/clickjacking posture, CSV injection, dependency audit
(`npm audit`: 0 vulnerabilities), secret scan, and hardened deployment
files. 38/38 self-tests pass.

**Compatibility: Kanidm server 1.10.x** (source-verified against v1.10.5;
the deploy layer pins `kanidm/server:1.10.5`). See the Compatibility
section in the README and `docs/USER-GUIDE.md`.

### Security

- **ID-token claims are now validated** (`Auth.validateClaims`): issuer,
  audience, expiry, and a strict nonce mismatch all abort sign-in. The
  client decodes the id_token for identity/role display only (never sends
  it anywhere, server-side authorisation is untouched), but enforcing the
  flow-binding claims removes token-substitution/confused-deputy vectors.
- **Session-storage restore is shape-validated**: a tampered
  `shenasa.session` blob (e.g. `roles` as a truthy string, which would
  substring-match inside `hasRole`) can no longer forge UI-level roles.
  Server-side enforcement was never affected.
- **CSV export hardened against spreadsheet formula injection**: cells
  starting with `=`, `+`, `-`, `@` (or tab/CR) are prefixed with `'`, so a
  malicious display name can no longer weaponise the exported file when an
  admin opens it in Excel/LibreOffice.
- **Setup hardening**: `deploy/setup.sh` validates the supplied domain(s)
  against a hostname grammar before interpolating them into the rendered
  `server.toml`/`Caddyfile`; the compose file pins `kanidm/server:1.10.5`
  (read-release-notes upgrades instead of a drifting `:latest`) and binds
  the Kanidm HTTPS port to `127.0.0.1` only — Caddy is the sole public
  ingress.
- A missing i18n label on the CSV-import dialog (fell back to the raw key
  `common.upload`) was restored.

- **Settings is now behind authentication.** Previously `#/settings` was
  reachable (and editable) without signing in; anyone with the URL could
  view and rewrite the connection configuration (apiUrl/OIDC client) of
  that browser profile. All application pages — Settings included — now
  require a session. The bootstrap case "no API URL configured at all" is
  still handled by the inline apiUrl field on the login page itself.

- **Sign-out now really ends the server session.** The old sign-out only
  cleared `sessionStorage`, leaving Kanidm's web-session cookie alive —
  "Sign in with SSO" then silently re-authenticated the previous user
  without any prompt (verified against v1.10.5 `https/views/login.rs`).
  Sign-out now calls `GET /ui/logout` (which runs `handle_logout` and
  always destroys the auth-session/bearer/oauth2-req/cu-session cookies):
  fetched in-place on same-origin deployments, or via a top-level
  navigation in two-domain ones. A passkey-mode bearer token, being
  stateless, remains valid until its expiry — Kanidm 1.10 exposes no
  token-revocation endpoint.

### Added

- **Step-up authentication (write unlock).** Interactive logins (Kanidm web
  login and Shenasa's stepped passkey flow, both with `privileged: false`)
  mint a *privilege-capable* session whose UAT maps to
  `AccessScope::ReadOnly` at the server — every write is denied with a bare
  HTTP 403 **before roles are evaluated** (evidence:
  `process_uat_to_identity` in `server/lib/src/idm/server.rs` and the
  access gates in `server/lib/src/server/access/{delete,modify}.rs` of
  Kanidm v1.10.5). Shenasa now implements the same remedy as the Kanidm
  web UI and the `kanidm reauth` CLI: a one-tap **"Unlock write access"**
  flow (`POST /v1/reauth` → passkey verification → reissued
  `ReadWrite{expiry:+600s}` token swapped into the session). A top-bar
  chip always shows the state: 🔒 read-only (click to step up) or
  ✍ write-until-`<time>`. The Sessions page explains the window and hosts
  the same unlock button. Write-scope is re-fetched from
  `GET /v1/self/_uat` after every sign-in and page reload (never
  persisted client-side).
- **Idle session timeout setting.** `Settings → Idle sign-out (minutes)`
  (`idleTimeoutMin`, 0 = disabled, max 24h; persisted in the public config).
  A watchdog tracks only genuine user input (pointer/keys/wheel/touch),
  and on timeout performs the FULL sign-out — `GET /ui/logout` cross-
  origin fallback included — instead of a modal that would silently keep
  Kanidm SSO able to re-enter. New `login.idleout` copy. Watchdog is
  disarmed on logout/settings-reset.
- **Recycle-bin retention documentation.** The page now states what the
  server enforces: recycled entries live for **7 days** (Kanidm 1.10
  `RECYCLEBIN_MAX_AGE = 7 * 86400`, hard-coded server-side constant —
  `server/lib/src/constants/mod.rs`), then the server purges them on its
  scheduled `PurgeRecycledEvent`. A manual per-object purge button was
  **deliberately NOT shipped**: Kanidm 1.10 exposes no REST endpoint for
  it (verified — `v1.rs` routes, `libs/client` has only
  `recycle_bin_list/get/revive`, and even the official CLI offers only
  list/get/revive). A fake button would be worse than none.
- **Group capability descriptions.** The groups list and group detail now
  show what members of each group can do: built-in `idm_*` role groups get
  an annotated summary derived from the Kanidm 1.10 builtin ACPs
  (`dl14/access.rs`), and every group additionally surfaces its own
  server-side `description` attribute. Group create/edit dialogs gained a
  Description field (the attribute is writable on ordinary groups).
- **Performance/scale guidance**: `deploy/server.toml.example` documents
  the enterprise tuning knobs verified in v1.10.5 (`thread_count`,
  `db_fs_type`, `trust_x_forward_for`, `KANIDM_*` env overlay), and
  `deploy/README.md` gained a "Performance & scale" section (token
  caching by applications, sizing, `/status` health checks, HA posture).

### Fixed

- **Usernames with dots rejected** (`m.mirzamohammadi`): the client-side
  username regex was stricter than the server. Kanidm's actual rule,
  verified in v1.10.5 (`server/lib/src/value.rs`,
  `INAME_RE = ^[a-z][a-z0-9-_\.]{0,63}$`), allows dots but requires the
  name to start with a letter and reserves `root`/`dn=token`. The
  validator now mirrors the server exactly.

- **Roles silently dropped after login** (`HTTP 403` on privileged
  actions despite correct group membership): `/v1/self` returns
  `WhoamiResponse {"youare": {"attrs": …}}` (proto/src/v1/mod.rs), not a
  bare entry — the client read `.attrs` off the wrapper, got `undefined`,
  and stored an empty role set. Identity/roles are now unwrapped via
  `Api.selfEntry()` in both the SSO and passkey paths, preferring the
  server's own live `memberof` (granted by `idm_acp_self_read`) with OIDC
  claims as fallback; the same fix repairs the profile page's group list.
  Regression tests use the real `youare` response shape.

- **Group-management 403s now explain Kanidm's permission tiers** instead
  of a bare error: `idm_group_admins` manages only ordinary groups (its
  builtin ACP `idm_acp_group_manage` excludes high-privilege groups);
  built-in `idm_*` role groups are `entry_managed_by: idm_admins` and
  editable only by `idm_admins`; system-level groups
  (`idm_high_privilege`, `idm_access_control_admins`, …) only by
  `idm_access_control_admins` / system admins (verified against
  `server/lib/src/migration_data/dl14/access.rs`).

- **Docker image pin used a nonexistent tag** — the compose file referenced
  `kanidm/server:v1.10.5`, but Docker Hub publishes Kanidm tags without a
  `v` prefix (`:1.10.5` exists, `:v1.10.5` returns HTTP 404), so
  `docker compose up` failed with "not found". The pin is now
  `kanidm/server:1.10.5`, and a regression test asserts the compose tag is
  always a concrete `X.Y.Z` release with no `v` prefix and no drifting
  channel.

### Changed

- **403 guidance tells the truth about read-only sessions.** When a write
  is denied while `Store.canWriteNow()` is false, the toast now leads with
  *"Your session is read-only … Unlock write access, then retry"* instead
  of suggesting missing role membership — that misdirection was the root
  of repeated "I'm in idm_people_admins but still get 403" confusion. The
  role/tier explanation is still shown when the write window is active.
- **UI RBAC gates aligned with the server's builtin ACPs.** The client used
  to treat `idm_admins` as an all-powerful role; the Kanidm 1.10 builtin
  ACPs grant it NO people/group/PII powers (its only builtin power is
  entry-managing the `idm_*` role groups). Gates now match the server:
  people ops → `idm_people_admins`; group create/edit/delete →
  `idm_group_admins`; member add/remove → `idm_group_admins` OR
  `idm_admins` (new `canEditGroupMembers`); managed-by →
  `idm_access_control_admins`; recycle bin → `idm_recycle_bin_admins`.
- **Audit page removed**: Kanidm 1.10 has no REST endpoint for reading
  audit events (verified: no audit route exists in `https/v1.rs`), so the
  page could only ever show an empty state. The dashboard now carries an
  "Audit logs" card pointing to the server's own log.
- **Invitations page and SCIM import modal removed**: neither has any
  Kanidm 1.10 REST surface; onboarding is covered by the credential-reset
  link flow (now also rendered as a QR code for handover to a phone).
- **Recycle bin is real**: lists soft-deleted entries via
  `GET /v1/recycle_bin` and revives by UUID via
  `POST /v1/recycle_bin/{id}/_revive` (both gated on
  `idm_recycle_bin_admins` — its own dedicated role; the old page was a
  501 stub with non-existent per-type restore/purge calls).
- **Sessions page is real**: shows the current session's `UserAuthToken`
  (`GET /v1/self/_uat` — id, issued/expiry, purpose) instead of a stubbed
  fake table; Kanidm 1.10 exposes no endpoint to list/revoke others.

### Fixed (earlier in this cycle)

- Blank white page after a successful sign-in with every `/v1` call
  returning 200: `index.html` mounts both `#login-root` and `#app-root`
  hidden, and `show('app')` was only invoked from the pre-login settings
  route — so on a fresh post-SSO page load, `route()`/`renderShell()`
  rendered the entire app into a root that never became visible. The
  existing DOM tests asserted content (which is present regardless of CSS
  classes), never visibility. `renderShell()` now reveals the shell, and a
  regression test pins `app-root` visible / `login-root` hidden after
  sign-in.

- SSO sign-in completed (token exchange 200) but every `/v1/*` call then
  failed with 401 "session expired": the SPA sent Kanidm's OIDC access
  token as a bearer to the management API. Verified against the v1.10.5
  source that `/v1` only accepts domain-key-signed tokens (UserAuthToken
  from `/v1/auth` or the web session, or service-account API tokens) — an
  OAuth2 client token can never authenticate there. SSO mode no longer
  stores or sends that bearer; REST calls now authenticate with the Kanidm
  web-session cookie created during the authorise journey (the same
  mechanism Kanidm's own UI uses, carried via `credentials:'include'`),
  and identity/roles are canonicalised from `/v1/self` with the id_token
  claims kept only as fallback. Passkey sign-in still uses its genuine
  UserAuthToken as a bearer.
- `index.html` meta CSP contained `frame-ancestors`, which is invalid in a
  `<meta>` element (Chrome logs an ignore-warning). Removed from the meta
  tag; the directive remains enforced via the HTTP header in the Caddy and
  nginx deploy configs (a test now pins delivery through the header).

- `setup.sh` TLS readiness check connected to `127.0.0.1:8443`, which can
  never match the certificate's hostname; it now waits against the real
  domain resolved to localhost (`curl --resolve`), in both quickstart-CA and
  public-certificate modes.
- `setup.sh` now conditionally emits `tls_trusted_ca_certs` in the rendered
  Caddyfile only when a local CA exists; deployments with publicly-trusted
  certificates no longer crash Caddy with a missing `/srv/tls/ca.pem`.
- `setup.sh` restarts containers on re-runs so re-rendered bind-mounted
  configs take effect.
- `bootstrap.sh` / `seed.sh` default `KANIDM_API_ORIGIN` is
  `https://<domain>:8443` and all curl calls connect via `--resolve
  <host>:<port>:127.0.0.1` (override with `KANIDM_RESOLVE_LOCAL=0`).
- Docs/Makefile invoke the bash scripts with `bash` (Ubuntu's `sh` is dash).
- SSO sign-in 404 ("route not found"): the SPA sent the browser to
  `/oauth2/authorize`, which does not exist in Kanidm. The browser-facing
  authorise entry is `/ui/oauth2` — exactly what Kanidm's discovery
  document publishes as `authorization_endpoint` (the similarly-named
  `/oauth2/authorise`, British spelling, is the machine/JSON endpoint and
  answers 400/401 without a login UI). Verified against the v1.10.5 source.
- Passkey sign-in 404: the previously guessed `/_session/passkey[/begin]`
  endpoints do not exist. Passkey login now uses Kanidm's real stepped
  `/v1/auth` protocol (init → begin "passkey" → cred); because `init`
  requires the account name, the login screen asks for it on a dedicated
  passkey step. Successful auth yields a standard Kanidm bearer token and
  roles come from `/v1/self`'s `memberof`.
- Passkey enrolment: removed calls to non-existent
  `/v1/credentials/webauthn[/begin]` and `/v1/people/<name>/webauthn[/begin]`.
  Self-service enrolment deep-links into Kanidm's audited credential
  manager (`/ui/update_credentials`); admins bootstrap other users with a
  one-time credential-reset link (service-desk flow) via
  `GET /v1/person/{id}/_credential/_update_intent/{ttl}` handed to the user
  as `<origin>/ui/reset?token=…`.
- The credential-reset intent was called with POST; Kanidm exposes that
  route as GET (upstream "TODO: this shouldn't be a get").
- The passkey-only toggle and dashboard stat read/wrote a
  `credential_type_min` attribute; the real schema attribute is
  `credential_type_minimum`.
- Blank white page when opening `/admin` without the trailing slash: the
  SPA's relative asset paths resolved outside `/admin/…` and 404'd on the
  Kanidm proxy. The rendered Caddyfile now answers `redir /admin /admin/
  308` (the nginx example already did).
- `bootstrap.sh` created the public OAuth2 client with an out-of-date
  request body (`oauth2_rs_name` attribute, no `attrs` envelope), which
  Kanidm rejects with HTTP 500 `InvalidEntryState`. Bodies now match the
  Kanidm 1.10 REST contract exactly (`{"attrs":{...}}` with `name`,
  `displayname`, `oauth2_rs_origin_landing`, `oauth2_strict_redirect_uri`),
  verified against the upstream source of v1.10.5.
- `bootstrap.sh` no longer PATCHes a hand-built `oauth2_rs_scope_map`
  value (wrong wire format); it uses the dedicated
  `POST /v1/oauth2/{rs}/_scopemap/{group}` endpoint per role group, which
  resolves group names server-side. The run is idempotent: an existing
  client is detected and converged instead of erroring.

### Changed

- Default OIDC scope now includes `groups`
  (`openid profile email groups`): without requesting it, Kanidm never
  emits the group SPNs Shenasa maps to UI roles, leaving signed-in admins
  with no permissions.

- Settings page connection test now queries the per-client OIDC discovery
  document (`/oauth2/openid/<client>/.well-known/openid-configuration`),
  which also validates that the OAuth2 client exists.

## 0.1.0 - 2026-08-05

Initial development snapshot (pre-public; never tagged).

### Added

- Static SPA admin UI for Kanidm (no frameworks, no build step, zero
  runtime dependencies).
- Sign-in with OIDC SSO (Authorization Code + PKCE S256, origin-root
  endpoints) and FIDO2/WebAuthn passkeys.
- RBAC-gated management of persons and groups (create/edit/soft-delete,
  memberships, nested groups, managed-by), PII gating.
- Dashboard with live stats and dependency-free inline SVG charts.
- User detail: reset-password (credential intents), passkey registration for
  users (interactive WebAuthn), passkey-only toggle with lockout protection,
  impersonation guidance.
- CSV import + CSV/JSON export, SCIM import modal; audit/invitations/
  recycle-bin/sessions pages with real API integration and clear
  not-mapped fallbacks per Kanidm version.
- Profile self-service (email edit gated by role, passkey registration,
  groups, auth method), settings page with connection test.
- Dependency-free QR encoder (byte mode, versions 1–10, ECC L/M,
  Reed–Solomon ECC, mask scoring) verified against a reference encoder.
- Deployment layer: docker-compose (Kanidm + Caddy), single-origin and
  two-domain topologies, nginx examples, `setup.sh`/`bootstrap.sh`/`seed.sh`,
  static UI container image.
- Tooling: dependency-free syntax lint, jsdom smoke tests, real-Kanidm
  integration test, CI (lint/test/image/integration/audit), Makefile.
- Documentation: README, deploy two-phase guide, SECURITY, CONTRIBUTING,
  OpenAPI reference, go-live checklist, MIT license.

[Unreleased]: https://github.com/mirzamohamadi/shenasa/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mirzamohamadi/shenasa/releases/tag/v1.0.0
