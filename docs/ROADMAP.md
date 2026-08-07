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

## Next — v1.0.x patches

- Field feedback from the first public deployments; a11y/wording polish.
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

Aimed at ~2000-user / ~50-app deployments.

- **Bulk operations**: group membership CSV import (dry-run report showing
  adds/removes/conflicts before applying), multi-select user actions
  (add-to-group, set expiry), export-*filtered*-views.
- **Governance reports**: accounts expiring within N days, passkey-only
  adoption per group, role-group membership diff since last export
  (client-side diffing of two exports — no new server API needed).
- **Performance**: virtualised/paginated list rendering proven at 5k+
  entries, request de-duplication on rapid navigation, measurable
  interaction budget on the dashboard.
- **CSP tightening**: eliminate `'unsafe-inline'` from `style-src` (move to
  fully external CSS), keeping `script-src 'self'` as-is.
- **Optional community language packs** loaded as *external* JSON locale
  files; the audited core stays English-only (the English-only source
  guard test keeps passing — packs are data, not code).
- Accessibility: WCAG 2.2 AA audit of focus order, contrast and ARIA.

## v1.3 — "Deeper lifecycle"

- **Per-user credential status**: `/v1/person/{id}/_credential/_status`
  (exists today) — show passkeys (named), TOTP presence, credential-type
  minimum, without ever touching secrets.
- **Account recovery (admin-triggered)**: Kanidm 1.10 added email-based
  recovery — verify the exact REST surface in the target release first,
  then surface "send recovery email" next to the reset-intent QR flow.
- **Onboarding wizard**: person → baseline groups → reset link in one
  guided flow (composes existing endpoints; nothing fake).
- **Domain settings editor** (`/v1/domain/_attr/{attr}`): display name and
  image management for admins with the matching ACP.
- **k6 load-test report** published in docs: SSO token-fetch bursts for 50
  apps, sizing guidance validated on 1.10/1.11.

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
