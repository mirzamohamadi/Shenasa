# Releasing Shenasa (maintainer guide)

How to cut a release and publish it on GitHub.

**Current tag to publish: v1.3.0.** Exact title, About text, commit,
tag message and release notes are in
[`docs/GITHUB-RELEASE-v1.3.0.md`](GITHUB-RELEASE-v1.3.0.md). GitHub
still only has `v1.0.0` and `v1.1.0`. Do not also create `v1.3.1`.

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

---

## 4. v1.3.0 — the exact release

House state as shipped: `package.json` version `1.3.0`, changelog section
`[1.3.0] - 2026-08-08` (on top of `[1.1.0]` and `[1.0.0]`), 67/67
self-tests green, deploy pins `kanidm/server:1.11.0` (1.10.5 verified
alternative), CI integration matrix runs BOTH pins. The v1.2 tag is
skipped by product decision: the combined v1.2+v1.3 milestones ship as
this one release.

### Commit

Title:

```
Shenasa v1.3.0 — bulk ops, governance reports, CSP tightened & lifecycle depth (Kanidm 1.10/1.11)
```

Body:

```
v1.3.0 ships the roadmap's v1.2 "Operations at scale" and v1.3 "Deeper
lifecycle" milestones as ONE release (the v1.2 tag is skipped by product
decision), with every feature verified against the exact upstream sources
of kanidm/kanidm v1.10.5 and v1.11.0.

Operations at scale:
- Bulk user actions with mandatory dry-run: add-to-group (ONE batched
  _attr/member POST; idm_* role groups excluded) and set/clear expiry
  (per-user preview; clear = empty-array purge per ModifyList::from_patch).
- Group-membership CSV import with a dry-run adds/removes/no-ops/conflicts
  report and per-(group, action) batched apply.
- Governance reports page: accounts expiring within N days (+ CSV),
  passkey-only adoption per group (bounded fan-out of _credential/_status,
  403-tolerant), client-side membership diff of two group JSON exports.
- Performance: in-flight GET de-duplication; windowed rendering proven at
  5k+ entries (5004 people → 15 DOM rows, 334 pages, self-tested).
- CSP: style-src drops 'unsafe-inline' everywhere (meta + all deploy
  configs); guard tests scan every JS module for inline-style patterns.
- Optional community locale packs (locales/<code>.json merged over the
  English core with a strict allowlist; core stays English-only).
- Accessibility: WCAG 2.2 AA pass (skip link, aria-current, labelled
  selection controls, scope=col report tables).
- k6 load-test package (docs/load-test/): SSO-burst script + method; the
  results table is filled on first operator run.

Deeper lifecycle (already in the tree, finalised here):
- Credential status card, onboarding wizard, domain settings editor,
  account-recovery card.
- CI integration now runs against kanidm/server:1.10.5 AND 1.11.0 and
  mirrors the new flows (batched membership, expiry set/clear,
  credential-status read); release.yml attaches zip+sha256 to tag
  releases and publishes the UI image to GHCR.

Fixed: blank page at /admin without trailing slash (generated Caddyfile
now redirects /admin → /admin/).

67/67 self-tests · zero runtime dependencies · MIT.
```

### Tag

```
git tag -a v1.3.0 -m "Shenasa v1.3.0 — operations at scale + deeper lifecycle (Kanidm 1.10/1.11)"
git push origin main v1.3.0
```

Pushing the tag triggers `.github/workflows/release.yml`, which runs the
test gate and attaches `shenasa-admin-v1.3.0.zip` + `.sha256` to the
release automatically, and pushes `ghcr.io/mirzamohamadi/shenasa-ui` with
`1.3.0` / `1.3` tags.

### Release title

```
Shenasa v1.3.0 — operations at scale & deeper lifecycle (Kanidm 1.10/1.11)
```

### Release notes (paste as-is)

````markdown
Shenasa v1.3.0 completes the roadmap's **v1.2 "Operations at scale"** and
**v1.3 "Deeper lifecycle"** milestones in one release (the v1.2 tag is
skipped by product decision). Every new operation is composed exclusively
of endpoints verified in the upstream sources of Kanidm **1.10.5** and
**1.11.0** — no guessed APIs, no dead buttons.

## Highlights

- **Bulk user actions (dry-run first)**: multi-select users → add to
  group (ONE batched request; `idm_*` role groups deliberately excluded)
  or set/clear account expiry — clear uses Kanidm's empty-array purge
  semantics, verified in `ModifyList::from_patch`.
- **Group-membership CSV import** with a dry-run report of
  adds/removes/no-ops/conflicts and reasons, applied batched per group.
- **Governance reports**: accounts expiring within N days (+ CSV),
  passkey-only adoption per group (permission-aware), and a client-side
  diff of two group JSON exports to review role-group drift.
- **Lifecycle depth**: credential status card, onboarding wizard
  (person → baseline groups → QR hand-off), domain settings editor,
  honest account-recovery card.
- **Performance & hardening**: in-flight GET de-duplication; lists proven
  at 5k+ entries; `style-src` no longer needs `'unsafe-inline'` anywhere;
  WCAG 2.2 AA pass (skip link, aria-current, labelled controls).
- **Optional community locale packs** (`locales/<code>.json`) — the
  audited core stays English-only.
- **k6 load-test package** (`docs/load-test/`) with interactive budgets
  as thresholds.
- **Fixed**: opening `/admin` (no trailing slash) no longer renders a
  blank page — the generated Caddyfile redirects to `/admin/`.

## Compatibility

Kanidm **1.10.x** and **1.11.x** (CI integration runs against both Docker
pins on every commit). Static SPA — unzip behind any hardened static file
server or use the included Caddy/nginx configs or the
`ghcr.io/mirzamohamadi/shenasa-ui` image.

## Upgrade from v1.1.0

Re-unzip and re-run `bash deploy/setup.sh <your-domain>` (repeatable,
idempotent). Note the re-run rotates the `idm_admin` recovery password
(bootstrap re-runs) — then hard-refresh (Ctrl+F5) and sign in once.

67/67 self-tests · zero runtime dependencies · MIT.
````
