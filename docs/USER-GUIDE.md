# Shenasa User Guide

Complete guide to operating Kanidm through Shenasa on a day-to-day basis,
plus a field-tested **RBAC & tiering best practice** model you can adopt as
your organisation's delegation standard.

- Audience: identity administrators, service-desk staff, security engineers.
- Applies to: **Shenasa v1.0.0** with **Kanidm server 1.10.x or 1.11.x**
  (recommended 1.10.5 / verified 1.11.0 — see the Compatibility table in
  the README; the server version is auto-detected and badged in Settings).
- Everything below is verified against the Kanidm 1.10 behaviour; where the
  server is the source of truth (and it always is), the server file is
  named so you can check for yourself.

---

## 1. Mental model: read this first

### 1.1 Shenasa is a client, Kanidm is the authority

Shenasa never grants permissions. It hides buttons you provably cannot use
and explains denials, but **every single operation is re-authorised by the
Kanidm server**. If the server says 403, the operation is denied — no UI
state can override that. Conversely, a server-side grant works even if the
UI looks conservative; reload to refresh the role view.

### 1.2 Read-only sessions vs the write window (step-up)

Kanidm interactive logins are **privilege-capable but read-only** until
you prove possession again (the same design as `sudo`):

- Right after SSO or passkey sign-in, your token maps to
  `AccessScope::ReadOnly`. **Any write returns a bare HTTP 403 — before
  roles are even checked.** (Verified: `process_uat_to_identity` in
  `server/lib/src/idm/server.rs`; the deny gates in
  `server/lib/src/server/access/{delete,modify}.rs`.)
- Click **🔒 Unlock write access** in the top bar (or on the Sessions
  page) and touch your passkey once. The server reissues the token as
  `ReadWrite` with an **expiry of ~10 minutes** (server constant:
  `DEFAULT_AUTH_PRIVILEGE_EXPIRY = 600s`).
- The top-bar chip shows the live state: 🔒 read-only, or ✍
  *Writes until HH:MM*. When it expires, click it again.
- Read operations (search, dashboard, exports) always work — only writes
  need the window.

This is identical to the Kanidm web UI's `/ui/reauth` and the CLI's
`kanidm reauth`. It is not a Shenasa limitation; it is Kanidm's
session-hardening design.

### 1.3 Two sign-in methods

| | SSO (OIDC) | Passkey |
| --- | --- | --- |
| How | Browser redirect through Kanidm's `/ui/oauth2`, Authorization Code + PKCE (S256, state, nonce) | Stepped `/v1/auth` ceremony (init → begin → cred), FIDO2 hardware |
| REST auth afterwards | Kanidm **web-session cookie** (`credentials: 'include'`) — Kanidm 1.10 deliberately does not accept OIDC access tokens on `/v1` | Genuine **UserAuthToken** sent as bearer |
| Needs | The `shenasa_admin_ui` public client registered on the server | Your account name typed once, plus a registered passkey |
| Sign-out | Destroys the server session too (`GET /ui/logout`) | Clears the local token (stateless bearer; valid until expiry — Kanidm 1.10 has no revocation endpoint) |

Both flows verify `iss`, `aud`, `exp` and the nonce before accepting any
identity claims.

---

## 2. First run

1. Open the deployed URL (e.g. `https://idm.example.com/admin/`).
2. If the connection is not preconfigured, enter the Kanidm API URL
   (**must end in `/v1`**, e.g. `https://idm.example.com/v1`) and the OIDC
   client id on the login card — or use **Settings** after signing in.
   Precedence: URL parameters > Settings (localStorage) > `js/config.js`
   defaults. **Only public values are configurable; there is no secret.**
3. Sign in with SSO or your passkey.
4. Notice the 🔒 chip in the top bar — click it and step up **before**
   your first write.
5. Recommended immediately: **Settings → Idle sign-out** — set e.g. 10–15
   minutes (0 = off, max 1440 = 24 h). On timeout Shenasa performs a full
   sign-out, including the server session.

---

## 3. Page by page

### 3.1 Dashboard

Live stat cards (total users, groups, active/expired accounts,
passkey-only accounts), dependency-free SVG charts (account-status pie,
members-per-group bars, passkey-adoption ring), your effective roles, and
an **Audit logs** card pointing at the server journal — Kanidm 1.10 exposes
no REST audit API, so Shenasa links to `journalctl -u kanidm`/your log
pipeline instead of faking a page.

### 3.2 Users

- Search (name/display name/e-mail), filter by group, paginate.
- **Create person**: username (server rule: `^[a-z][a-z0-9-_.]{0,63}$`,
  starts with a letter, `root` and `dn=token` reserved), display name,
  e-mail, optional validity window (`valid from` / `expires`).
- **Edit**, **soft-delete** (goes to the recycle bin — see 3.5),
  **CSV import**, **CSV/JSON export** (exports are formula-injection
  hardened: cells starting with `= + - @` are prefixed with `'`).
- PII fields (e-mail etc.) are gated on `idm_people_pii_read`.

### 3.3 User detail

- Fields, groups (chip add/remove), validity window, passkey count.
- **Reset credentials (service-desk flow)**: creates a one-time
  credential-update intent (`GET /v1/person/{id}/_credential/_update_intent/{ttl}`)
  and shows the link both as copyable text **and as a QR code** (Shenasa's
  own dependency-free encoder). Hand the link/QR to the user over a
  second channel; they land on Kanidm's audited credential manager and
  enrol a new passkey/set a new password themselves. Shenasa — and you —
  never see the credential.
- **Passkey-only toggle**: raises `credential_type_minimum` so passwords
  stop working for the account. The toggle refuses to arm if the account
  has **no registered passkey** (lockout protection).
- **Impersonation**: guidance for the audited CLI path; no silent
  in-UI impersonation.

### 3.4 Groups

- Search, nested-group filter, pagination; create/edit/delete ordinary
  groups; members (add/remove persons); nested groups; `managed by`
  (role-gated).
- **Capability descriptions**: built-in `idm_*` role groups show what
  membership actually grants (derived from the server's builtin ACPs);
  custom groups show their own `description` attribute, editable in the
  group dialog. **Use this — document every group you create.**
- Denials explain Kanidm's real tiers (see §5): `idm_group_admins` manages
  only ordinary groups; `idm_*` role groups are entry-managed by
  `idm_admins`; system groups by `idm_access_control_admins`.

### 3.5 Apps (OAuth2/OIDC clients)

Requires `idm_oauth2_admins`. One client per SSO application.

- **List** with public/basic badges; **New client**: choose **public**
  (browser/SPA/native — PKCE, no secret) or **basic** (server-side app —
  authenticates with a client secret), client id (becomes the OIDC
  `client_id`), display name, landing URL (https — Kanidm builds the
  strict redirect list from it).
- **Detail**: edit display name/landing; **Strict redirect URI** toggle
  (keep ON — exact matching; off = prefix matching, legacy only);
  **redirect origins** add/remove; **scope maps** / **supplementary scope
  maps** / **claim maps** add-update-remove per group (e.g. give group
  `app-users` the scopes `openid profile email groups`); **basic secret**
  reveal for confidential clients (copy it into your vault — it is a
  password for that application).
- Deleting a client kills its sign-ins immediately — the danger zone asks
  for confirmation.

### 3.6 Service accounts

Requires `idm_service_account_admins`. One account per integration/robot,
never a shared human account.

- **New service account**: name, display name, and the required
  **managed-by group** (the server rejects accounts without one).
- **API tokens**: list shows label, read-only/read-write badge, issued
  and expiry dates; **Issue token** — label, optional expiry (empty =
  never expires; schedule rotation instead), read-write checkbox (grant
  only when the integration truly writes), compact (shorter token for
  header-size-limited systems). **The full token is shown exactly once** —
  copy it or scan the QR into your vault immediately. **Delete** a token
  to cut an integration's access instantly.

### 3.7 Recycle bin

- Lists soft-deleted entries (`GET /v1/recycle_bin`), **Revive** restores
  by UUID (`POST /v1/recycle_bin/{id}/_revive`). Requires
  `idm_recycle_bin_admins`.
- **Retention: exactly 7 days.** Server-side constant
  (`RECYCLEBIN_MAX_AGE = 7 * 86400`); the server purges on an internal
  schedule. Kanidm 1.10 has **no REST endpoint to purge early** (not in
  the web routes, not in the official client, not in the CLI) — so Shenasa
  deliberately documents this instead of offering a dead button.

### 3.8 Sessions

Shows **your current session** decoded from `GET /v1/self/_uat`: token id,
issued-at, expiry, purpose — including the **write window** state with its
own unlock button like the top-bar chip. Kanidm 1.10 exposes no endpoint to
list or revoke *other* sessions, so none is shown.

### 3.9 Profile (self-service)

Edit your own e-mail (role-gated), register an additional passkey
(deep-link into Kanidm's credential manager), change password, view your
groups and sign-in method.

### 3.10 Settings

Connection (apiUrl, OIDC client id/scope/redirect URI) with a **Test
connection** button that queries the client's discovery document (which
also proves the OAuth2 client exists), theme (light/dark/auto), **Idle
sign-out** minutes, and a full reset of local overrides.

---

## 4. Everyday operations cookbook

### 4.1 Onboard a new employee

1. 🔒 Step up (unlock write access).
2. Users → **New person** → username per your naming standard, display
   name, work e-mail, optional validity window.
3. Open the user → add the baseline groups (see §5.4 example).
4. **Reset credentials** → copy the link or show the QR → hand it to the
   user over a verified second channel (in person, chat, MDM). They enrol
   their own passkey.
5. For privileged roles: require a **passkey**, then arm
   **passkey-only** once ≥1 passkey is registered.

### 4.2 Lost password / lost passkey

Same reset-intent flow (4.1 step 4). The link is single-purpose and
time-boxed (TTL you choose); issuing a new one is safe — old intents are
superseded.

### 4.3 Offboard

1. Step up.
2. Users → select → **Delete** (soft delete: the account stops working
   immediately).
3. If it was a mistake: Recycle bin → **Revive** — within **7 days**.
4. After 7 days the server purges the entry permanently. For legal
   retention keep your own export (Users → Export) before deleting.

### 4.4 Grant or revoke admin powers safely

1. Decide the **tier** first (§5), then the role group.
2. Only `idm_admins` can edit `idm_*` role-group membership; only
   `idm_access_control_admins` can touch system groups — plan who holds
   those *before* you need it at 2 a.m.
3. Grant by adding the person to the role group; the UI capability note on
   the group reminds you what you just granted. Revoke by removing them.
4. Changes apply on the server immediately; the affected user sees the new
   powers at next sign-in (or token refresh).

### 4.5 Bulk import (CSV)

Users → **Import CSV** — one person per row using the exported column
layout. Import is additive; export first for a backup. Exported/imported
cells are safe against spreadsheet formula injection.

---

## 5. RBAC & tiering best practice

Everything in this section reflects **Kanidm 1.10's builtin access-control
profiles** (`server/lib/src/migration_data/dl14/access.rs`), which Shenasa
mirrors in its UI gates and group capability notes.

### 5.1 The builtin roles (what membership actually grants)

| Role group | Grants (summary) | Membership edited by |
| --- | --- | --- |
| `idm_access_control_admins` | Modify access control itself; manage **system-level** groups | itself / system |
| `idm_admins` | Entry-manager of the `idm_*` **role groups** — and nothing else by default! Not people, not groups, not PII | `idm_admins` |
| `idm_people_admins` | Create/modify/delete persons, account lifecycle | `idm_admins` |
| `idm_people_pii_read` | Read PII attributes (e-mail, …) | `idm_admins` |
| `idm_people_self_mail_write` | Users may change their own e-mail | `idm_admins` |
| `idm_group_admins` | Create/modify/delete **ordinary** groups and their members | `idm_admins` |
| `idm_service_desk` | Service-desk powers (credential-reset intents, …) | `idm_admins` |
| `idm_recycle_bin_admins` | Search/revive recycle bin | `idm_admins` |
| `idm_oauth2_admins` | Manage OAuth2/OIDC clients (your ~50 apps) | `idm_admins` |
| `idm_schema_admins`, `idm_high_privilege`, … | System/schema level | `idm_access_control_admins` |

The single most common misunderstanding: **`idm_admins` is not
all-powerful.** Its only builtin power is curating the role groups. A 403
for an `idm_admins` member doing people work is *correct* server behaviour
— grant `idm_people_admins` too. (And remember §1.2: no role helps while
the session is read-only — step up first.)

### 5.2 Recommended tiering model

Adapted from the classic AD tiering to Kanidm's builtin roles:

| Tier | Purpose | Kanidm groups | Account style | Typical headcount |
| --- | --- | --- | --- | --- |
| **T0 — Control plane** | Protect the IdM itself: access control, schema, recovery | `idm_access_control_admins`, `idm_schema_admins` (and hold `idm_admin` recovery credentials offline) | Dedicated `a-` admin accounts, passkey-only, hardware keys | 2–3 |
| **T1 — Identity admins** | Role curation + people/groups lifecycle | `idm_admins`, plus `idm_people_admins` / `idm_group_admins` as needed | Dedicated `a-` accounts, passkey-only | 3–6 |
| **T2 — Application & helpdesk** | Service desk, OAuth2 clients, recycle bin, PII read | `idm_service_desk`, `idm_oauth2_admins`, `idm_recycle_bin_admins`, `idm_people_pii_read` | Can be the daily account for helpdesk; passkey strongly recommended | 5–20 |
| **T3 — Workforce** | Ordinary users of the ~50 apps | Ordinary business groups (`app-*`, `dept-*`) managed by T1/T2 | Daily accounts | everyone |

### 5.3 Hard rules (adopt as policy)

1. **Separate admin from daily identities.** T0/T1 work happens through
   dedicated accounts (e.g. `a-mmirzamohammadi`); the daily account has no
   builtin role membership at all.
2. **Passkey-only for anything T0/T1** (arm the passkey-only toggle after
   enrolling ≥1 hardware passkey; keep a second key enrolled as backup).
3. **Least privilege, additive grants.** Grant the *smallest* role set for
   the task (`idm_people_pii_read` alone for an HR reporting account,
   never `idm_people_admins`). You can always add.
4. **Never nest an ordinary group *into* an `idm_*` role group** to "make
   it easier" — that silently promotes every member, including nested
   transitivity. Grant individual accounts instead.
5. **Recycle-bin admin is its own grant.** Neither `idm_admins` nor
   `idm_people_admins` can revive deletions; keep
   `idm_recycle_bin_admins` with a small, deliberate set (T1 + on-call
   T2), because revive restores privileges too.
6. **OAuth2 client admin != people admin.** With ~50 SSO apps, one
   mis-clicked redirect URI is a breach. Keep
   `idm_oauth2_admins` tiny and require strict redirect URIs
   (Shenasa's own client is the template).
7. **`idm_access_control_admins` is break-glass territory.** 2–3 named
   humans, hardware keys, and a membership review on a calendar. Never a
   shared account.
8. **Protect the recovery path.** The `idm_admin` generated password
   (printed by bootstrap) is full control. Rotate on each setup run (the
   deploy scripts do), store in your vault, test quarterly.
9. **Membership recertification.** Quarterly: export group membership for
   all `idm_*` groups (Groups → export or `kanidm group list-members`),
   diff against the approved list.
10. **Write actions need the step-up window** — that is a *feature*
    (limits the blast radius of a stolen unlocked browser). Do not work
    around it; plan ~10-minute write batches.

### 5.4 Example delegation for a ~2000-user org

| Duty | Group(s) | Who |
| --- | --- | --- |
| IdM platform ownership, ACP/schema/HA | `idm_access_control_admins`, `idm_schema_admins` | 2 senior engineers, `a-` accounts |
| Role curation & user lifecycle | `idm_admins` + `idm_people_admins` + `idm_group_admins` | IAM team leads, `a-` accounts |
| Password/passkey resets, off-hours | `idm_service_desk` (+ `idm_recycle_bin_admins` for on-call) | Helpdesk (daily accounts OK) |
| App onboarding, redirect URIs, scopes | `idm_oauth2_admins` | App integration team |
| HR reporting (read-only PII) | `idm_people_pii_read` via service account | HR analytics |
| Business access | `dept-*`, `app-*` ordinary groups (document each via the group Description field!) | T1/T2 maintain |

### 5.5 When you get a 403 — decision tree

```
HTTP 403 on a write?
├─ Top-bar chip shows 🔒 read-only?
│   └─ YES → Click "Unlock write access", touch passkey, retry.
│            (Session scope gate — before roles are even checked.)
└─ Chip shows ✍ writes active?
    ├─ Working on persons/PII?   → need idm_people_admins (+ idm_people_pii_read for PII)
    ├─ Ordinary group edit?      → need idm_group_admins
    ├─ idm_* role-group members? → need idm_admins
    ├─ System group/schema?      → need idm_access_control_admins
    ├─ Recycle bin?              → need idm_recycle_bin_admins
    └─ OAuth2 clients?           → need idm_oauth2_admins
```

Shenasa's error toasts walk you through exactly this tree inline.

---

## 6. Security hygiene for operators

- Set **Idle sign-out** (Settings) on every admin workstation — 10–15 min
  is a sane default; the timeout signs out *server-side* too.
- Prefer **Sign out** over closing the tab when finished; it destroys the
  Kanidm web session so SSO cannot silently re-enter.
- Lock your OS session — the write window is bearer-equivalent.
- Don't share admin accounts; Kanidm's audit log attributes every write to
  a person — keep that useful.
- Review the **Sessions** page occasionally: it shows the token id,
  issued/expiry and purpose of your live session.

## 7. Troubleshooting quick list

| Symptom | Cause → fix |
| --- | --- |
| 401 right after SSO sign-in | Old build sent the OIDC access token to `/v1` — upgrade; v1.0.0 uses the web-session cookie. |
| 403 on *every* write, roles correct | Read-only session → **Unlock write access** (§1.2). |
| Buttons hidden you think you should have | Reload once (roles refresh from `/v1/self`); else you truly lack the role (§5.5). |
| `m.mirzamohammadi` rejected | Old validator; fixed — dots are legal (`INAME_RE`). |
| Passkey prompt never appears | Browser/platform without WebAuthn, non-HTTPS origin, or clock skew. |
| Sign back in instantly after sign-out | You hit an old build whose sign-out kept the server cookie; redeploy + Ctrl+F5. |
| Nothing loads after upgrade | Hard refresh (Ctrl+F5): the SPA is cache-busted but browsers love stale HTML. |
| Need audit events | Kanidm 1.10 has no REST audit API — read the server journal/log pipeline (Dashboard card links there). |
