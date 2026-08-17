# Security Policy

## Scope

Shenasa is a client-side admin UI for Kanidm. The **authorisation authority
is always the Kanidm server**; Shenasa never grants permissions itself. This
policy covers the Shenasa repository (UI, deploy layer, scripts).

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open public issues for
security problems.

- Report via **GitHub private vulnerability reporting** (*Security →
  Advisories → Report a vulnerability* on the repository page), or the
  contact address listed in the repository profile/README.
- Include: affected versions, reproduction steps, impact, and whether a
  working exploit exists.
- We aim to acknowledge within **3 business days** and provide a fix or
  mitigation plan within **30 days** for confirmed issues.

If the issue is in **Kanidm itself**, report it upstream via
<https://github.com/kanidm/kanidm/security>.

## Security model (what to review)

- **Authentication**: OIDC Authorization Code + PKCE (S256) with state and
  nonce validation; FIDO2/WebAuthn passkeys via the server's session
  endpoints. There is no local password store, no demo accounts, and no
  legacy flows.
- **Token handling**: access/ID tokens are kept in memory and
  sessionStorage only. Nothing sensitive is persisted to localStorage or
  cookies by the SPA. The public config (`js/config.js`) contains no secrets
  — the OAuth2 client is a public PKCE client by design.
- **Endpoint separation**: OIDC/OAuth2/WebAuthn calls go to the origin root
  (`/oauth2/*`, `/_session/*`, `/.well-known/*`); only REST calls go under
  `/v1`. An accidental `/v1/oauth2/*` call would indicate a regression
  covered by tests.
- **RBAC gating**: UI elements are enabled from token roles, but every
  operation is enforced server-side; a forged token gains nothing.
- **Session lifecycle**: sign-out closes the Kanidm server session as well
  as local state (`GET /ui/logout` destroys the web-session cookies), so
  SSO cannot silently re-authenticate a signed-out user. All application
  pages, Settings included, require an authenticated session.
- **Write scope (step-up)**: interactive logins are read-only at the
  Kanidm access layer (`AccessScope::ReadOnly`) until the user completes a
  passkey step-up (`POST /v1/reauth`), which grants a ~10-minute write
  window enforced server-side. Shenasa never fabricates write authority;
  it only surfaces and requests this server-issued window.
- **XSS**: all user-provided values are escaped with `Ui.esc()` before
  insertion into HTML; smoke tests assert injected markup stays inert.
- **CSP & headers**: `script-src 'self'` (no inline JavaScript),
  `style-src 'self'` (**no `unsafe-inline` since v1.3**), `img-src 'self'
  data:`, `connect-src 'self' https:`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`;
  proxies add HSTS,
  `X-Content-Type-Options`, `X-Frame-Options DENY`, `Referrer-Policy
  no-referrer`, and a restrictive `Permissions-Policy`.
- **Connection URLs**: `apiUrl` and `oidcRedirectUri` (query,
  localStorage, Settings, login rescue) accept only `https://` or
  loopback `http://localhost` / `127.0.0.1` / `[::1]`. `javascript:`,
  `data:`, `file:` and remote `http://` are dropped so they cannot
  become `location.assign` / `<a href>` sinks (v1.3.0).
- **TLS**: enforced end-to-end; deployment configs never disable
  certificate verification (enforced by tests/CI). The dev-only CA in
  `deploy/setup.sh` is for evaluation and is replaced with real
  certificates for production.
- **Dev server**: `scripts/serve.js` rejects `..`, malformed percent-
  encoding, and hidden path segments (`.git`, `.env`, …).
- **Dependencies**: zero runtime dependencies; the only dev dependency is
  jsdom (tests). CI runs `npm audit`.

## Security audits

- **[docs/security-audit-1.0.0.md](docs/security-audit-1.0.0.md)** — full
  pre-release audit of v1.0.0 (2026-08-06): methodology, findings F1–F6
  (all fixed before release), and documented accepted risks.

## Deployment hardening checklist

1. Use publicly trusted certificates; keep HSTS enabled.
2. Restrict the Caddy/nginx exposure to 80/443 (+636 for LDAPS when needed).
3. Keep `idm_admin` credentials in a password manager; prefer passkeys and
   the built-in admin UI break-glass flow.
4. Review role-group membership (`idm_*`) regularly; grant least privilege.
5. Subscribe to Kanidm security advisories and keep the server updated.
6. Run `npm run check` and `bash test/integration.sh` before upgrades.
