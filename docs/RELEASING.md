# Releasing Shenasa (maintainer guide)

How to cut a release and publish it on GitHub. For v1.0.0 the exact
commands and the ready-to-paste release text are in §3.

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

## 3. v1.0.0 — the exact release (first public publish)

House state as shipped: `package.json` version `1.0.0`, changelog section
`[1.0.0] - 2026-08-06`, 38/38 self-tests green, deploy pins
`kanidm/server:1.10.5`.

```sh
git init -b main
git add -A
git commit -m "Shenasa v1.0.0 — first stable release"
git remote add origin https://github.com/mirzamohamadi/shenasa.git
git push -u origin main
git tag -a v1.0.0 -m "Shenasa v1.0.0 — first stable release"
git push origin v1.0.0

zip -rq shenasa-admin-v1.0.0.zip . \
  -x "node_modules/*" -x ".git/*" -x ".arena/*" \
  -x "deploy/tls/*" -x "deploy/out/*" -x "deploy/ui/*"
sha256sum shenasa-admin-v1.0.0.zip | tee shenasa-admin-v1.0.0.zip.sha256

gh release create v1.0.0 shenasa-admin-v1.0.0.zip shenasa-admin-v1.0.0.zip.sha256 \
  --title "Shenasa v1.0.0 — first stable release (Kanidm 1.10 admin UI)" \
  --notes-file RELEASE_TEXT.md
```

### Release title

```
Shenasa v1.0.0 — first stable release (Kanidm 1.10 admin UI)
```

### Release notes (paste as-is — also mirrored below for the web UI)

```markdown
**Shenasa** is a modern, dependency-free administration UI for the
[Kanidm](https://kanidm.com) identity management server: a static SPA in
plain HTML/CSS/vanilla JS — no frameworks, no build step, no runtime
dependencies, no CDNs.

## Compatibility

✅ **Kanidm server 1.10.x** (recommended **1.10.5**) — every endpoint, auth
flow, builtin ACP and error path is source-verified against the v1.10.5
tree. ❌ ≤ 1.9.x unsupported · ⚠️ ≥ 1.11.x unverified.
The deploy layer pins `kanidm/server:1.10.5` (Docker Hub tags have no `v`
prefix; `:latest` tracks the dev branch — always pin).

## Highlights

- **Sign-in:** OIDC SSO (Authorization Code + PKCE S256) or FIDO2/WebAuthn
  passkeys. No local password form, no demo mode.
- **Write unlock (step-up):** one-tap passkey re-auth opens Kanidm's
  ~10-minute server-side write window — the same flow as Kanidm's own UI
  and `kanidm reauth`; a top-bar chip always shows the session state, and
  403s explain *why* (read-only session vs missing role).
- **Users / groups:** full lifecycle, memberships, nested groups,
  managed-by, capability descriptions, PII gating, CSV import +
  CSV/JSON export (formula-injection hardened).
- **Service-desk flows:** one-time credential-reset links with a built-in,
  dependency-free QR encoder; passkey-only enforcement with lockout
  protection.
- **Recycle bin:** real list/revive (`idm_recycle_bin_admins`); server-side
  7-day retention documented honestly (1.10 has no manual purge endpoint).
- **Sessions:** your live token (`/v1/self/_uat`) incl. the write window;
  idle sign-out setting that ends the server session too.
- **Security posture:** strict CSP (`script-src 'self'`, no inline JS),
  hardened proxy headers, every value HTML-escaped, id-token claims
  validated (iss/aud/exp/nonce), no secrets in the browser, real sign-out
  via `/ui/logout`. Full pre-release audit: `docs/security-audit-1.0.0.md`.
- **Deploy layer:** docker-compose (Kanidm + Caddy), single-origin or
  two-domain topologies, one-command `deploy/setup.sh`, nginx examples,
  enterprise-scale tuning notes.

## Docs

- [User guide + RBAC/tiering best practice](docs/USER-GUIDE.md)
- [README](README.md) · [CHANGELOG](CHANGELOG.md) ·
  [Security policy](SECURITY.md)

## Install

```sh
unzip shenasa-admin-v1.0.0.zip -d shenasa && cd shenasa
bash deploy/setup.sh idm.example.com          # single-origin
# or: bash deploy/setup.sh idm.example.com shenasa.example.com  # two domains
```

38/38 self-tests green · CI (Node 20/22, container build, real-Kanidm
integration, npm audit) · MIT license.
```

---

## 4. After publishing

- Tweet/toot/LinkedIn: link the **release** (`…/releases/tag/v1.0.0`), not
  just the repo — the notes sell the project.
- Watch Issues for the first days; SECURITY.md routes security reports to
  e-mail instead of public issues.
- Next release: bump `package.json`, add a dated CHANGELOG section, keep
  `[Unreleased]` for ongoing work, repeat §1–2.
