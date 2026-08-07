# Releasing Shenasa (maintainer guide)

How to cut a release and publish it on GitHub. For v1.1.0 the exact
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

## 3. v1.1.0 — the exact release

House state as shipped: `package.json` version `1.1.0`, changelog section
`[1.1.0] - 2026-08-06` (on top of the already-published `[1.0.0]`), 50/50
self-tests green, deploy pins `kanidm/server:1.11.0` (1.10.5 verified
alternative). The working tree is the existing clone from the v1.0.0
publish — no `git init`.

**Repository form (github.com → New repository):**

- Name: `shenasa` — Public — do NOT add README/.gitignore/license (we ship
  our own).
- Description (≤ 350 chars):

```
Dependency-free admin UI for Kanidm. Vanilla-JS SPA (no build step, no runtime deps): SSO (OIDC + PKCE) & passkey sign-in, step-up write unlock, RBAC-aware users/groups, OAuth2/OIDC apps, service accounts & API tokens, QR flows, recycle bin. Source-verified for Kanidm 1.10.x & 1.11.x.
```

**Commit — title:** `Shenasa v1.1.0 — OAuth2 apps, service accounts & deploy hardening`

**Commit — body** (embedded in the command below):

```sh
# from the existing clone used for the v1.0.0 publish:
unzip -o /path/to/shenasa-admin-v1.1.0.zip   # refreshes the tree in place (archive has no .git)
git add -A
git commit -m "Shenasa v1.1.0 — OAuth2 apps, service accounts & deploy hardening" -m "$(cat <<'EOF'
Shenasa v1.1.0 — "Applications & service accounts".

Added
- Apps page (#/apps, gated on idm_oauth2_admins): full OAuth2/OIDC client
  management — create public (PKCE) or basic (confidential) clients with
  strict redirect matching, edit displayname/landing/strict, delete,
  redirect-origin add/remove, scope maps, supplementary scope maps and
  claim maps via the dedicated _scopemap/_sup_scopemap/_claimmap
  endpoints, one-time basic-secret reveal for confidential clients.
- Service accounts page (#/svcaccounts, gated on
  idm_service_account_admins): list/create/delete (the form enforces the
  server-required entry_managed_by group) plus the complete API-token
  lifecycle — list with read-only/read-write badges and expiry, issue
  (label, optional expiry epoch, read_write, compact) with the full token
  shown exactly once (copy + QR hand-off, never persisted), revoke by id.
- Dashboard domain stat card (GET /v1/domain; tolerant of denied roles).
- Role-accurate 403 guidance for the new areas.
- setup.sh downgrade guard: refuses to start Kanidm when the pinned image
  is older than the deployed one (migrations are one-way,
  MG0010DowngradeNotAllowed) and diagnoses that exact refusal from the
  logs; forward upgrades print a notice with an abort window.

Changed
- Deploy layer pins kanidm/server:1.11.0 (1.10.5 verified alternative).
- Publish hygiene: config defaults use idm.example.com placeholders;
  SECURITY.md routes reports via GitHub private vulnerability reporting.

Fixed
- Corrected the builtin OAuth2-admin role name to idm_oauth2_admins across
  docs and UI copy (idm_oauth2_client_admins never existed).

Every new endpoint and payload source-verified against the Kanidm v1.10.5
and v1.11.0 trees (their /v1 route sets are identical); citations in
CHANGELOG [1.1.0]. 50/50 self-tests green. Runtime dependencies: none.
EOF
)"
git tag -a v1.1.0 -m "Shenasa v1.1.0 — \"Applications & service accounts\""
git push origin main
git push origin v1.1.0

zip -rq shenasa-admin-v1.1.0.zip . \
  -x "node_modules/*" -x ".git/*" -x ".arena/*" \
  -x "deploy/tls/*" -x "deploy/out/*" -x "deploy/ui/*"
sha256sum shenasa-admin-v1.1.0.zip | tee shenasa-admin-v1.1.0.zip.sha256

gh release create v1.1.0 shenasa-admin-v1.1.0.zip shenasa-admin-v1.1.0.zip.sha256 \
  --title "Shenasa v1.1.0 — OAuth2 apps, service accounts & API tokens (Kanidm 1.10/1.11)" \
  --notes-file RELEASE_TEXT.md
```

### Release title

```
Shenasa v1.1.0 — OAuth2 apps, service accounts & API tokens (Kanidm 1.10/1.11)
```

### Release notes (paste as-is — also mirrored below for the web UI)

```markdown
**Shenasa v1.1.0** — *"Applications & service accounts"* — adds full
OAuth2/OIDC application management, service accounts with the complete
API-token lifecycle, and a hardened deploy layer. Still dependency-free:
no frameworks, no build step, no runtime dependencies, no CDNs.

## What's new

- **Apps page** (`#/apps`, role `idm_oauth2_admins`): full OAuth2/OIDC
  client management — create **public (PKCE)** or **basic (confidential)**
  clients with strict redirect matching, edit displayname/landing/strict,
  delete, redirect-origin add/remove, **scope maps**, **supplementary
  scope maps** and **claim maps** via the dedicated
  `_scopemap`/`_sup_scopemap`/`_claimmap` endpoints, and one-time
  **reveal basic secret** for confidential clients.
- **Service accounts page** (`#/svcaccounts`, role
  `idm_service_account_admins`): list/create/delete service accounts (the
  form enforces the server-required `entry_managed_by` group) plus the
  complete **API-token lifecycle** — list with read-only/read-write badges
  and expiry, **issue** (label, optional expiry, read_write, compact) with
  the token shown **exactly once** (copy + QR hand-off, never persisted),
  **revoke** by token id.
- **Dashboard domain card** (`GET /v1/domain`; roles without domain-read
  simply skip it) and role-accurate 403 guidance for the new areas.

## Changed

- Deploy layer pins `kanidm/server:1.11.0` (1.10.5 verified alternative —
  Docker Hub tags have no `v` prefix; never track `:latest`).
- **`deploy/setup.sh` downgrade guard**: setup refuses to start Kanidm
  when the pinned image is older than the one the host already runs
  (migrations are one-way — `MG0010DowngradeNotAllowed`) and diagnoses
  that exact refusal from the logs on timeout; forward upgrades print a
  notice with a short abort window.

## Fixed

- Corrected the builtin OAuth2-admin role name to `idm_oauth2_admins`
  across docs and UI copy (the previously documented
  `idm_oauth2_client_admins` never existed upstream).

## Compatibility

✅ Kanidm **1.10.x** (recommended 1.10.5) · ✅ **1.11.x** (verified 1.11.0 —
identical `/v1` route sets, verified by diffing both source trees) ·
❌ ≤ 1.9.x · ⚠️ ≥ 1.12.x unverified. The UI auto-detects the server version
(`X-KANIDM-VERSION`) and badges it in Settings.

## Upgrade from v1.0.0

Drop-in file replacement, no config migration:

```sh
unzip -o shenasa-admin-v1.1.0.zip -d shenasa && cd shenasa
# On 1.10.x servers first set the compose pin back to kanidm/server:1.10.5 —
# the zip defaults to 1.11.0 and downgrades are impossible upstream.
bash deploy/setup.sh idm.example.com    # re-stages the SPA, restarts, re-runs bootstrap (rotates idm_admin)
```

Then a hard refresh (Ctrl+F5) and one **Sign out** to clear the old
web-session cookie.

## Fresh install

```sh
unzip shenasa-admin-v1.1.0.zip -d shenasa && cd shenasa
bash deploy/setup.sh idm.example.com          # single-origin
# or: bash deploy/setup.sh idm.example.com shenasa.example.com  # two domains
```

50/50 self-tests green · every new endpoint source-verified (evidence in
[CHANGELOG](CHANGELOG.md) `[1.1.0]`) · CI (Node 20/22, container build,
real-Kanidm integration, npm audit) · MIT.

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
