# Shenasa development roadmap

Public roadmap. Versioning follows semver; dates are targets, not promises.
The guiding rules stay the same as for v1.0.0: **every feature must be
backed by a real, source-verified Kanidm endpoint** (no dead buttons),
the server remains the sole authorisation authority, and the codebase
stays dependency-free vanilla JS with no build step.

Server verification method (same as 1.0.0): diff/read the exact upstream
source tree of the target release — routes
(`server/core/src/https/v1.rs`), builtin ACPs
(`server/lib/src/migration_data/<dl>/access.rs`), auth constants
(`server/lib/src/constants/mod.rs`) — and cite file/line in the CHANGELOG.

---

## Now — v1.0.0 (2026-08-06)

- First stable public release.
- Kanidm **1.10.x and 1.11.x** verified (identical `/v1` route sets across
  both releases; dl15 ACPs additive-only; auth constants unchanged).
- Live server-version detection (`X-KANIDM-VERSION`) with a compatibility
  badge in Settings.
- Users/groups/RBAC, step-up write unlock, recycle bin, sessions, profile,
  idle sign-out, QR service-desk flows, CSV import/export, hardened
  deploy layer, 40/40 self-tests.

## Shipped — v1.3.0 (2026-08-17)

Public tag after v1.1.0. Includes operations-at-scale, lifecycle depth,
and the Apps create/hardening work.

- Connection URL allow-list; dev-server path lock-down.
- Apps create: live type note, auto `oauth2_rs_origin` PATCH, hash to
  `#/apps/{id}`, one-shot secret modal after basic create.
- Service-account token dialog labels; report CSV newlines; mail purge;
  CSV row cap; malformed-`%` routes.
- Operator docs: `docs/USER-GUIDE.md` rewritten for every page;
  `docs/APPS.md` added.

## Next — patches after v1.3.0

- Field feedback from the first v1.3.0 deployments; a11y/wording polish.
- Track upstream 1.10.x/1.11.x patch releases; re-verify the matrix on
  each and extend `SUPPORTED_KANIDM` accordingly.

## v1.1 — "Applications & service accounts" (shipped)

✅ **Status: released as v1.1.0 (2026-08-06).**
Apps page, service accounts + API tokens, the domain card and the deploy
downgrade guard all landed (see CHANGELOG `[1.1.0]`); the CI server matrix
and release automation below remain open for a patch/minor follow-up.

The biggest verified-but-unused REST surface in Kanidm 1.10/1.11 — perfect
for organisations running dozens of SSO apps.

- **Apps page (OAuth2/OIDC client management)** ✅ shipped in Unreleased —
  client list/create/edit/delete, strict redirect URIs, scope/sup-scope/
  claim maps, one-time basic-secret reveal (`_image` upload deferred).
- **Service accounts page** ✅ shipped in Unreleased — list/create/delete,
  **API token issue & revoke** with one-time display + QR + expiry/compact
  flags (`_into_person`, `_unix`, `_lock` deferred to a later release).
- **Domain card** ✅ shipped in Unreleased (`GET /v1/domain`; `_image`
  upload deferred).
- **CI server matrix**: run `test/integration.sh` against both
  `kanidm/server:1.10.5` and `:1.11.0` so the dual support is enforced on
  every commit.
- **Release automation**: GitHub Action that builds and attaches
  `shenasa-admin-<tag>.zip` + `.sha256` to every release; publish the UI
  container to GHCR with semver tags.

## v1.2 — "Operations at scale"

✅ **Status: shipped inside v1.3.0 (2026-08-08)** — the v1.2 tag itself was
skipped by product decision; every item below landed in the combined
release. Aimed at ~2000-user / ~50-app deployments.

- **Bulk operations** ✅ — group membership CSV import (dry-run report
  with adds/removes/no-ops/conflicts + per-row reasons, batched apply),
  multi-select user actions (dry-run-first add-to-group, set/clear expiry
  with purge-semantics clear), export-*filtered*-views (already present
  since v1.0: CSV/JSON of the current Users filter; v1.3 adds the
  expiring-report CSV and the group JSON export).
- **Governance reports** ✅ — accounts expiring within N days,
  passkey-only adoption per group (bounded fan-out of `_credential/_status`,
  403-tolerant), membership diff of two exports (fully client-side).
- **Performance** ✅ — in-flight GET de-duplication; windowed/paginated
  rendering proven at 5k+ entries (self-test: 5004 people → 15 DOM rows,
  334 pages); the dashboard interaction budget is expressed as k6
  thresholds in `docs/load-test/`.
- **CSP tightening** ✅ — `'unsafe-inline'` eliminated from `style-src`
  everywhere (meta + all deploy configs); `script-src 'self'` unchanged;
  guard tests scan every JS module for inline-style patterns.
- **Optional community language packs** ✅ — `locales/<code>.json`
  merged over the English core with a strict allowlist; core stays
  English-only (guard unchanged).
- **Accessibility** ✅ — WCAG 2.2 AA pass: skip link, `aria-current`,
  labelled selection controls, `scope="col"` tables, focus ring preserved
  across new controls.
- **k6 load-test report** ✅ (script + method in `docs/load-test/`;
  results table filled on first operator run).

## v1.3 — "Deeper lifecycle"

✅ **Status: shipped as v1.3.0 (2026-08-08), together with v1.2.**
By product decision the v1.2 tag is skipped; both milestones landed in
v1.3.0.

- **Per-user credential status** ✅ implemented — real
  `GET /v1/person/{id}/_credential/_status` (types + labels + UUID,
  403-tolerant; never touches secrets).
- **Account recovery (admin-triggered)** — ⚠️ amended after upstream
  verification: **no admin "send recovery email" REST surface exists**
  (recovery is user self-service at `/ui/recover`). Shipped honestly
  instead: recovery page link on the user page + the
  `domain_allow_account_recovery` toggle in the domain editor.
- **Onboarding wizard** ✅ implemented — person → baseline groups →
  reset link (composes existing verified endpoints; nothing fake).
- **Domain settings editor** ✅ implemented — display name + recovery
  toggle via `/v1/domain/_attr/{attr}` (domain_admins role; `_image`
  upload stays deferred).
- **k6 load-test report** ✅ published in `docs/load-test/` (script +
  method + sizing guidance; results attached on first operator run).
- **CI server matrix** ✅ — integration suite runs against both
  `kanidm/server:1.10.5` and `:1.11.0` (from the v1.1 leftovers).
- **Release automation** ✅ — `release.yml` attaches
  `shenasa-admin-<tag>.zip` + `.sha256` to every tag release and publishes
  the UI image to GHCR with semver tags (from the v1.1 leftovers).

## v2.0 — "Next platform" (long-term, upstream-gated)

Starts only when Kanidm **1.12 stable** ships; every item requires the
upstream feature to be *stable*, not dev-flagged.

- **Sync/SCIM clients UI** when the sync API stabilises.
- **Replication/cluster awareness** (status page per node) once server
  replication is stable (dev-flagged through 1.11).
- **Cross-server version-adaptive feature flags**: the
  `X-KANIDM-VERSION` plumbing from 1.0.0 becomes per-feature gating.
- **HA deployment guide** + validated backup/restore runbook.

## Permanently blocked (tracked, re-checked every release)

These are intentionally absent because the server exposes **no API**;
each is re-verified per upstream release:

| Want | Status upstream (1.10/1.11) |
| --- | --- |
| Audit log reading | no REST surface — use server journal/SIEM |
| Listing/revoking *other* sessions | no REST surface (only `/v1/self/_uat`) |
| Manual recycle-bin purge | none — 7-day server schedule only |
| SCIM import | 1.10/1.11: no stable admin REST surface |

## Version-support policy

- Each Shenasa release names its **verified Kanidm range** in the README
  compatibility table; the Settings badge reflects detection at runtime.
- New upstream minor → verified within one Shenasa release cycle;
  support is only claimed after the source diff method above has run.
- Security fixes land on the latest minor only; users on older minors get
  a "please upgrade" note in the advisory.
