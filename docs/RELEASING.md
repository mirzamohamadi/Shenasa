# Releasing Shenasa (maintainer guide)

How to cut a release and publish it on GitHub. For v1.1.0 — the first
public release — the exact commands and the ready-to-paste release text
are in §3.

Repository: <https://github.com/mirzamohamadi/shenasa>

---

## 1. Pre-flight checklist (any release)

```sh
# from the repo root
npm install                 # dev-only: jsdom for tests
npm run check               # syntax lint + all smoke tests must be green
npm audit                   # expect: 0 vulnerabilities (dev deps only)
grep -rn "avvalman\|9011\|password\|secret" --include="*.js" --include="*.sh" \
  --include="*.yml" js deploy scripts | grep -vi "example" || true
#  ↑ manual secret/domain scan — nothing private must ship

# version strings agree:
grep '"version"' package.json
grep -n '^## \[' CHANGELOG.md | head -3     # [X.Y.Z] - YYYY-MM-DD dated today
grep -n 'K_SERVER\|kanidm/server:' deploy/docker-compose.yml
```

- CHANGELOG: everything for the release lives under `## [X.Y.Z] -
  YYYY-MM-DD`; `[Unreleased]` is empty; bottom compare links updated.
- Compatibility statement (README + docs/USER-GUIDE.md) still matches the
  Kanidm version the deploy layer pins.

## 2. Release mechanics (any release)

```sh
git add -A
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "Shenasa vX.Y.Z"
git push origin main --tags

# build the distributable zip (contents at archive root):
zip -rq shenasa-admin.zip . \
  -x "node_modules/*" -x ".git/*" -x ".arena/*" \
  -x "deploy/tls/*" -x "deploy/out/*" -x "deploy/ui/*"
sha256sum shenasa-admin.zip | tee shenasa-admin.zip.sha256
```

Then publish on GitHub (web UI or `gh`):

```sh
gh release create vX.Y.Z shenasa-admin.zip shenasa-admin.zip.sha256 \
  --title "…" --notes-file RELEASE_TEXT.md      # or paste via the web UI
```

Repository hygiene once, not per release:

- **About** (repo front page): description
  *"Dependency-free admin UI for Kanidm — SSO/passkey sign-in, step-up
  write unlock, RBAC-aware."*, website = your deployment URL (optional).
- **Topics**: `kanidm`, `identity-management`, `admin-ui`, `webauthn`,
  `passkeys`, `fido2`, `oidc`, `rbac`, `vanilla-javascript`, `security`.
- **Settings → Branches**: protect `main` (require PR + CI green, no force
  push).
- **Settings → Security**: enable Dependabot alerts, private vulnerability
  reporting (SECURITY.md is in place).
- README badges (release / CI / license / Kanidm compatibility) render
  automatically once the repo is public and CI has run once.

---

## 3. v1.1.0 — the exact release (first public publish)

House state as shipped: `package.json` version `1.1.0`, changelog section
`[1.1.0] - 2026-08-06` (`[1.0.0]` kept as the internal baseline milestone,
never tagged publicly), 49/49 self-tests green, deploy pins
`kanidm/server:1.11.0` (1.10.5 verified alternative).

**Repository form (github.com → New repository):**

- Name: `shenasa` — Public — do NOT add README/.gitignore/license (we ship
  our own).
- Description (≤ 350 chars):

```
Dependency-free admin UI for Kanidm. Vanilla-JS SPA (no build step, no runtime deps): SSO (OIDC + PKCE) & passkey sign-in, step-up write unlock, RBAC-aware users/groups, OAuth2/OIDC apps, service accounts & API tokens, QR flows, recycle bin. Source-verified for Kanidm 1.10.x & 1.11.x.
```

**Commit — title:** `Shenasa v1.1.0 — first public release`

**Commit — body** (embedded in the command below):

```sh
git init -b main
git add -A
git commit -m "Shenasa v1.1.0 — first public release" -m "$(cat <<'EOF'
First public release of Shenasa, a dependency-free administration UI for
the Kanidm identity management server (source-verified against Kanidm
1.10.x and 1.11.x; the deploy layer pins kanidm/server:1.11.0).

- Static SPA in plain HTML/CSS/vanilla JS: no frameworks, no build step,
  no runtime dependencies, no CDNs (works air-gapped).
- Sign-in via OIDC SSO (Authorization Code + PKCE S256; iss/aud/exp/nonce
  validated) or FIDO2/WebAuthn passkeys (stepped /v1/auth). No local
  password form, no demo mode.
- Step-up write unlock (/v1/reauth): one-tap passkey re-auth opens the
  server's ~10-minute ReadWrite window; live scope chip in the top bar;
  403 toasts distinguish "read-only session" from "missing role".
- Apps page: full OAuth2/OIDC client management (public PKCE and basic
  confidential clients, strict redirect matching, redirect origins,
  scope/supplementary-scope/claim maps, one-time basic-secret reveal).
- Service accounts: lifecycle incl. required managed-by, and the full
  API-token lifecycle (issue read-only/read-write, optional expiry, the
  token shown exactly once with copy + QR hand-off, revoke by id).
- Users/groups lifecycle: create/edit/soft-delete, memberships, nested
  groups, managed-by, per-group capability descriptions, PII gating,
  validity windows, CSV import + CSV/JSON export (hardened against
  spreadsheet formula injection).
- Service-desk flows: one-time credential-reset intents with a built-in,
  dependency-free QR encoder; passkey-only enforcement with lockout
  protection.
- Recycle bin: real list/revive (idm_recycle_bin_admins); 7-day
  server-side retention documented (Kanidm exposes no manual purge
  endpoint — no fake buttons).
- Sessions: live token view (/v1/self/_uat) incl. the write window; idle
  sign-out setting that ends the server session too.
- Server version auto-detected from X-KANIDM-VERSION with a compatibility
  badge in Settings (1.10.x / 1.11.x supported).
- Security: strict CSP (script-src 'self', no inline JS), hardened proxy
  headers, all output HTML-escaped, no secrets in repo or browser, real
  sign-out via /ui/logout. Pre-release audit: docs/security-audit-1.0.0.md.
- Deploy layer: docker-compose (Kanidm 1.11.0 + Caddy, 1.10.5 verified
  alternative), single-origin or two-domain topologies, one-command
  deploy/setup.sh with a Kanidm downgrade guard, nginx examples,
  enterprise-scale tuning notes.
- Quality: 49/49 self-tests (jsdom), syntax lint, real-Kanidm integration
  script, CI (Node 20/22, image build, real-server test, npm audit), MIT.

Docs: README.md, docs/USER-GUIDE.md (usage + RBAC/tiering best practice),
docs/RELEASING.md, docs/ROADMAP.md, docs/openapi.yaml, GO-LIVE-checklist.md.
EOF
)"
git remote add origin https://github.com/mirzamohamadi/shenasa.git
git push -u origin main
git tag -a v1.1.0 -m "Shenasa v1.1.0 — first public release"
git push origin v1.1.0

zip -rq shenasa-admin-v1.1.0.zip . \
  -x "node_modules/*" -x ".git/*" -x ".arena/*" \
  -x "deploy/tls/*" -x "deploy/out/*" -x "deploy/ui/*"
sha256sum shenasa-admin-v1.1.0.zip | tee shenasa-admin-v1.1.0.zip.sha256

gh release create v1.1.0 shenasa-admin-v1.1.0.zip shenasa-admin-v1.1.0.zip.sha256 \
  --title "Shenasa v1.1.0 — first public release (Kanidm 1.10/1.11 admin UI)" \
  --notes-file RELEASE_TEXT.md
```

### Release title

```
Shenasa v1.1.0 — first public release (Kanidm 1.10/1.11 admin UI)
```

### Release notes (paste as-is — also mirrored below for the web UI)

```markdown
**Shenasa** is a modern, dependency-free administration UI for the
[Kanidm](https://kanidm.com) identity management server: a static SPA in
plain HTML/CSS/vanilla JS — no frameworks, no build step, no runtime
dependencies, no CDNs.

## Compatibility

✅ **Kanidm server 1.10.x *and* 1.11.x** (recommended 1.10.5 · verified
1.11.0) — the servers' `/v1` route sets are identical across both releases
and their builtin ACP/auth constants match, verified by diffing the
v1.10.5 and v1.11.0 source trees. ❌ ≤ 1.9.x unsupported · ⚠️ ≥ 1.12.x
unverified. The UI auto-detects the server version via the
`X-KANIDM-VERSION` header and badges it in Settings.
The deploy layer pins `kanidm/server:1.11.0` by default (1.10.5 verified
alternative; Docker Hub tags have no `v` prefix; `:latest` tracks the dev
branch — always pin).

## Highlights

- **Sign-in:** OIDC SSO (Authorization Code + PKCE S256) or FIDO2/WebAuthn
  passkeys. No local password form, no demo mode.
- **Write unlock (step-up):** one-tap passkey re-auth opens Kanidm's
  ~10-minute server-side write window — the same flow as Kanidm's own UI
  and `kanidm reauth`; a top-bar chip always shows the session state, and
  403s explain *why* (read-only session vs missing role).
- **Apps:** full OAuth2/OIDC client management — public (PKCE) and basic
  (confidential) clients, strict redirect matching, redirect origins,
  scope / supplementary-scope / claim maps, one-time basic-secret reveal.
- **Service accounts:** lifecycle incl. the server-required managed-by
  group, plus the complete API-token lifecycle — issue read-only or
  read-write tokens with optional expiry, the token is shown **exactly
  once** (copy + QR hand-off), revoke by token id.
- **Users / groups:** full lifecycle, memberships, nested groups,
  managed-by, capability descriptions, PII gating, CSV import +
  CSV/JSON export (formula-injection hardened).
- **Service-desk flows:** one-time credential-reset links with a built-in,
  dependency-free QR encoder; passkey-only enforcement with lockout
  protection.
- **Recycle bin:** real list/revive (`idm_recycle_bin_admins`); server-side
  7-day retention documented honestly (no manual purge endpoint exists).
- **Sessions:** your live token (`/v1/self/_uat`) incl. the write window;
  idle sign-out setting that ends the server session too.
- **Kanidm 1.10 + 1.11:** server version auto-detected
  (`X-KANIDM-VERSION`) with a live compatibility badge in Settings.
- **Security posture:** strict CSP (`script-src 'self'`, no inline JS),
  hardened proxy headers, every value HTML-escaped, id-token claims
  validated (iss/aud/exp/nonce), no secrets in the browser, real sign-out
  via `/ui/logout`. Full pre-release audit: `docs/security-audit-1.0.0.md`.
- **Deploy layer:** docker-compose (Kanidm + Caddy), single-origin or
  two-domain topologies, one-command `deploy/setup.sh` with a Kanidm
  **downgrade guard** (Kanidm migrations are one-way — setup aborts
  instead of ever rolling the server image back), nginx examples,
  enterprise-scale tuning notes.

## Docs

- [User guide + RBAC/tiering best practice](docs/USER-GUIDE.md)
- [README](README.md) · [CHANGELOG](CHANGELOG.md) ·
  [Roadmap](docs/ROADMAP.md) · [Security policy](SECURITY.md)

## Install

```sh
unzip shenasa-admin-v1.1.0.zip -d shenasa && cd shenasa
bash deploy/setup.sh idm.example.com          # single-origin
# or: bash deploy/setup.sh idm.example.com shenasa.example.com  # two domains
```

49/49 self-tests green · CI (Node 20/22, container build, real-Kanidm
integration, npm audit) · MIT license.

## Assets

- `shenasa-admin-v1.1.0.zip` — full source + deploy layer (contents at the
  archive root). Verify integrity with the attached `.sha256`.
```

---

## 4. After publishing

- Tweet/toot/LinkedIn: link the **release** (`…/releases/tag/v1.1.0`), not
  just the repo — the notes sell the project.
- Watch Issues for the first days; SECURITY.md routes security reports to
  GitHub private vulnerability reporting instead of public issues.
- Next release: bump `package.json`, add a dated CHANGELOG section, keep
  `[Unreleased]` for ongoing work, repeat §1–2.
