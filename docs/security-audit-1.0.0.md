# Security audit — Shenasa v1.0.0

**Date:** 2026-08-06 · **Scope:** full codebase (SPA, deploy scripts, docs,
CI) against Kanidm v1.10.5 (upstream source reviewed as the contract
reference) · **Method:** manual line-by-line review of every security-relevant
sink, plus automated scans and the project's own 33-test suite.

Audit verdict: **no critical or high issues found in the audited version;
the medium/low findings below were all fixed before release.** The test
suite is at 33/33 and `npm audit` reports 0 vulnerabilities.

## Methodology checklist (what was verified)

| Area | Result |
| --- | --- |
| XSS: every interpolated value in every `innerHTML` sink escaped via `Ui.esc()` (pages, modals, tables, chips, toasts use `textContent` where dynamic) | ✅ verified by review + inert-injection DOM test |
| CSP `script-src 'self'`, no inline scripts/styles handlers; `frame-ancestors`/`object-src 'none'` via HTTP headers in Caddy/nginx | ✅ verified, pinned by tests |
| OIDC: Authorization Code + PKCE (S256), single-use `state` and `nonce` (sessionStorage), query scrubbed after callback | ✅ verified |
| OIDC id_token claim binding (iss/aud/exp/nonce) | ⚠️ finding F1 — fixed |
| Kanidm OIDC access token never sent to `/v1` (client-key-signed; guaranteed 401 and a leaked-token footgun) | ✅ verified (regression-tested) |
| Session restore from `sessionStorage` shape-validated | ⚠️ finding F2 — fixed |
| CSV export spreadsheet-formula injection | ⚠️ finding F3 — fixed |
| CSV import preview escaping, per-row API errors surfaced | ✅ verified |
| No demo/mock mode, no local password form, no secrets in repo (`config.js` public PKCE client) | ✅ verified by grep pins + CI |
| Dependency audit (dev-only `jsdom`) | ✅ `npm audit` = 0 |
| Lockfile committed (`package-lock.json`) for reproducible CI | ✅ |
| Pre-login attack surface (what renders without a session) | ✅ login + inline apiUrl rescue only (Settings was reachable — fixed earlier in this cycle) |
| Sign-out terminates the server session (`GET /ui/logout`, cookies destroyed server-side) | ✅ fixed earlier in this cycle |
| Deploy scripts: quoting, injection of operator-supplied domains into `sed`/rendered configs | ⚠️ finding F4 — fixed |
| Container supply chain (`kanidm/server:latest` drift) | ⚠️ finding F5 — fixed |
| Kanidm port exposure besides the Caddy ingress | ⚠️ finding F5 — fixed (localhost bind) |
| Dev static server: path-traversal guard, hardened headers | ✅ verified |
| No `eval`/`new Function`/remote scripts/CDN/inline event handlers | ✅ verified |
| Shell injection review (`curl | sh`, `eval`, unquoted expansions) in deploy scripts | ✅ verified |

## Findings fixed in this audit round

- **F1 (Medium) — id_token claims were not validated.** The SPA decoded the
  token for identity/roles without checking issuer/audience/expiry and only
  conditionally compared the nonce. A substituted token minted for a
  different client or issuer would have been displayed as a valid sign-in.
  Impact was limited to the UI (tokens are never sent to `/v1`; the server
  enforces everything), but `Auth.validateClaims()` now enforces
  iss/aud/exp and a strict nonce. Regression tests pin all rejection cases.
- **F2 (Low) — session restore trusted storage shapes.** A tampered
  `shenasa.session` JSON (e.g. `roles` as a truthy string) could
  substring-match inside `hasRole()` and forge UI-level permissions. The
  restore path now rebuilds the session from validated fields only.
- **F3 (Low) — CSV export formula injection.** Cells starting with
  `= + - @` (or tab/CR) execute as formulas in Excel/LibreOffice. Export
  now prefixes them with an apostrophe. Covered by a DOM test with a
  malicious display name.
- **F4 (Low, operator-side) — `setup.sh` interpolated unvalidated domains**
  into `sed` substitutions and the rendered `Caddyfile`/`server.toml`.
  Inputs are now validated against a strict hostname grammar first.
- **F5 (Low/Medium, deployment) — supply-chain & exposure hygiene.** The
  compose file tracked `kanidm/server:latest` (silent, unaudited identity-
  server upgrades) and published the Kanidm HTTPS port on all interfaces.
  It now pins `kanidm/server:1.10.5` (Docker Hub tags carry no `v` prefix)
  and binds the port to `127.0.0.1`,
  with Caddy as the only ingress.
- **F6 (Trivial) — CSV-import dialog showed the raw key `common.upload`**
  after the string was removed; label restored.

## Accepted risks (documented, by design)

- **No JWS signature verification in the browser.** A dependency-free,
  no-build client cannot verify the id_token signature; the token arrives
  over TLS directly from the token endpoint in response to our own
  code+PKCE exchange, and the claims that bind it to this flow
  (iss/aud/exp/nonce) are enforced. The token is never forwarded anywhere.
- **Passkey-mode bearer tokens remain valid until expiry** after sign-out;
  Kanidm 1.10 exposes no token-revocation endpoint. (Web session / SSO
  cookies ARE destroyed on sign-out.)
- **Client-side RBAC is cosmetic by design**; every write is re-authorised
  by the Kanidm server (forged UI permissions gain nothing).
- **Kanidm replication** is marked a development feature by upstream in
  1.10; HA guidance (backup + fast redeploy) is documented in
  `deploy/README.md`.

## Hardening references for reviewers

- Endpoint/behaviour claims in this codebase cite the Kanidm v1.10.5
  source (see inline comments and `docs/openapi.yaml`).
- CI: syntax lint, 33 smoke tests (pure + jsdom DOM), deployment-header
  checks, secret-pattern guard, `npm audit`.
