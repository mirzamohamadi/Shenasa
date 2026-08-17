# Shenasa User Guide

How every page actually works, plus the RBAC / tiering model.

- Audience: identity administrators, service-desk staff, security engineers.
- Applies to: **Shenasa v1.3.0** with **Kanidm 1.10.x or 1.11.x**
  (recommended 1.10.5 / verified 1.11.0). Settings badges the live
  `X-KANIDM-VERSION` header.
- Kanidm is always the authority. Where this guide names a server file,
  you can check it yourself.

OAuth2/OIDC applications have a dedicated operator guide:
**[APPS.md](APPS.md)**.

---

## 1. Mental model

### 1.1 Shenasa is a client

Shenasa never grants permissions. It hides buttons you cannot use and
explains denials. **Every operation is re-authorised by Kanidm.** A 403
is final. A server-side grant works even if the UI still looks
conservative — reload.

### 1.2 Read-only sessions vs the write window

Interactive logins are privilege-capable but **read-only** until you
prove possession again (same idea as `sudo`):

- After SSO or passkey sign-in the token maps to
  `AccessScope::ReadOnly`. **Any write is HTTP 403 before roles are
  checked.** (`process_uat_to_identity` in `server/lib/src/idm/server.rs`.)
- Click **Unlock write access** in the top bar (or on Sessions) and
  touch a passkey. The server reissues `ReadWrite` for **~10 minutes**
  (`DEFAULT_AUTH_PRIVILEGE_EXPIRY = 600s`).
- The chip shows 🔒 read-only or ✍ *Writes until HH:MM*.
- Reads always work.

This is Kanidm’s design, not a Shenasa limitation.

### 1.3 Two sign-in methods

| | SSO (OIDC) | Passkey |
| --- | --- | --- |
| How | Redirect through `/ui/oauth2`, Authorization Code + PKCE S256, state, nonce | Stepped `/v1/auth` (init → begin → cred), FIDO2 |
| REST auth afterwards | Web-session **cookie** (`credentials: 'include'`). Kanidm 1.10/1.11 does not accept OIDC access tokens on `/v1` | Genuine **UserAuthToken** as bearer |
| Needs | Public client `shenasa_admin_ui` on the server | Account name + a registered passkey |
| Sign-out | `GET /ui/logout` destroys the server session | Clears the local token (stateless bearer; valid until expiry — no revoke API) |

Both flows check `iss`, `aud`, `exp` and nonce before accepting claims.

There is no local password form, no demo mode, and no invitations page
(Kanidm has no invitations REST API).

---

## 2. First run

1. Open the deployed URL (e.g. `https://idm.example.com/admin/` — trailing
   slash required; `/admin` without it is redirected).
2. If nothing is preconfigured, enter the API URL (**must end in `/v1`**)
   on the login card, or use **Settings** after sign-in. Precedence:
   URL query > Settings (localStorage) > `js/config.js`. Only public
   values; there is no secret. `apiUrl` / redirect must be `https://` or
   loopback `http://` — `javascript:`, `data:` and remote `http` are
   dropped.
3. Sign in with SSO or a passkey.
4. Click the 🔒 chip and step up **before** the first write.
5. Settings → **Idle sign-out**: 10–15 minutes is sane (0 = off, max
   1440). Timeout signs out locally **and** on the server.

---

## 3. Page by page

Nav items appear only when your roles allow them. Deep-linking a hidden
page names the missing role instead of showing an empty shell.

### 3.1 Dashboard

Live stats (users, groups, active / not-yet-valid / expired,
passkey-only), SVG charts, your roles, and a **domain** card from
`GET /v1/domain` (omitted if you cannot read it).

**Audit logs** is not a table. Kanidm has no REST audit API. The card
points at the server journal (`docker logs shenasa-kanidm` /
`journalctl`).

### 3.2 Users (`#/users`)

Roles: list is visible to people-admins / PII readers; create / delete /
CSV import / onboard / bulk expiry need `idm_people_admins`. Bulk
add-to-group also needs group-member rights.

- Search (name / display name), filter by group, paginate (15 per page).
- **New user**: username (`^[a-z][a-z0-9-_.]{0,63}$`, starts with a
  letter, `root` and `dn=token` reserved), display name, email, optional
  valid-from / expiry.
- **Onboard wizard**: person → optional baseline groups (`idm_*` and
  `domain_admins` / `system_admins` excluded) → one-time credential
  link + QR. Same endpoints as doing it by hand.
- **CSV import**: header `name,displayname,mail`. Additive. Capped at
  **2000** data rows. Failures listed after the run.
- **CSV / JSON export** of the *current filter*. CSV cells starting
  with `= + - @` (or tab/CR) get a leading `'` (spreadsheet
  formula-injection).
- **Bulk bar** (checkboxes survive pagination):
  - *Add to group* — dry-run first (adds vs already members), then
    **one** `POST /v1/group/{id}/_attr/member` with the whole add list.
    `idm_*` groups are not offered.
  - *Set / clear expiry* — dry-run table current → new. Clear sends
    `account_expire: []` (Kanidm purge). Unchanged rows are skipped.
- PII (email) is hidden without `idm_people_pii_read`.
- Delete is a **soft** delete (recycle bin, 7 days).

### 3.3 User detail (`#/users/{name}`)

- Fields, group chips (add/remove), validity, passkey count.
- **Credential status** — `GET /v1/person/{id}/_credential/_status`.
  Types: Password, GeneratedPassword, Passkey (enrolment labels),
  PasswordMfa (TOTP labels, legacy security keys, backup-code count),
  plus the credential UUID. Empty `{creds:[]}` is honest. 403 →
  “restricted” (needs service-desk / people-admin ACPs). Secrets are
  never fetched.
- **Reset password / Passkey setup** — one-time intent
  (`GET /v1/person/{id}/_credential/_update_intent/{ttl}`) shown as a
  link and QR. The user finishes on Kanidm’s credential manager. You
  never see the secret.
- **Passkey-only** — sets `credential_type_minimum`. Refuses to arm if
  the account has no passkey (lockout guard).
- **Account recovery** — link to `<origin>/ui/recover`. There is **no**
  admin “send recovery email” API. Availability is the domain toggle
  in Settings (`domain_admins`).
- **Impersonate** — points at the audited CLI; no silent in-UI
  impersonation.

### 3.4 Groups (`#/groups`)

- Search, nested-only filter, pagination.
- Create / edit / delete ordinary groups. **No display name** — Kanidm
  group ACPs reject `displayname` (a real 403). Use **Description**.
- Capability column: builtin `idm_*` roles get a summary from the
  server ACPs; custom groups show `description`.
- **Export JSON** — `{format, version, generatedAt, groups:[{name,
  members}]}`. Input of the Reports membership diff.
- **Import membership CSV** — header `group,member,action` (`action`
  optional, `add` or `remove`). Dry-run: add / remove / no-op /
  conflict (unknown group, unknown member, bad action). Apply is one
  request per (group, action). Capped at 2000 rows.

### 3.5 Group detail

Members (persons and nested groups), add/remove, managed-by,
description, capability text. `idm_*` membership is `idm_admins` only;
system groups are `idm_access_control_admins`. Ordinary groups are
`idm_group_admins`.

### 3.6 Apps (`#/apps`) — summary

Requires `idm_oauth2_admins`. Full contract: **[APPS.md](APPS.md)**.

- One client per SSO application. **public (PKCE)** or **basic
  (secret)**.
- Create fields are **identical** for both types. The dropdown only
  chooses `POST /v1/oauth2/_public` vs `_basic`. Kanidm does **not**
  accept a secret on create; it generates one for basic clients.
- After save: landing is PATCHed as `oauth2_rs_origin`, URL becomes
  `#/apps/{id}`, basic secret is shown once.
- Detail: edit display name / landing (not type), strict-redirect
  toggle, redirect origins, scope / supplementary-scope / claim maps,
  **Reveal basic secret**. Delete kills that app’s sign-in immediately.
- Type cannot be changed later. Scope maps are not inferred — add them
  or the token will not carry `groups` / the scopes the app asked for.

### 3.7 Service accounts (`#/svcaccounts`)

Requires `idm_service_account_admins`. One account per robot, never a
shared human.

- **New**: name, display name, **managed-by group** (server-required).
- **API tokens**:
  - List: label, read-only / read-write, issued, expiry (`never` if
    unset).
  - **Issue**: label, optional expiry date (empty = never — rotate on a
    schedule instead), **Read-write (unchecked = read-only)**,
    **Shorter token string** (same rights, shorter encoding for picky
    `Authorization` headers).
  - The full token is shown **exactly once** (copy + QR). It cannot be
    read back. Lose it → issue another and delete the old one.
  - Delete cuts that integration immediately.

### 3.8 Recycle bin (`#/recycle`)

`GET /v1/recycle_bin`, revive `POST /v1/recycle_bin/{uuid}/_revive`.
Needs `idm_recycle_bin_admins`. Retention **7 days**
(`RECYCLEBIN_MAX_AGE`). No manual purge API exists — there is no purge
button on purpose.

### 3.9 Sessions (`#/sessions`)

Current session only (`GET /v1/self/_uat`): id, issued, expiry,
purpose, write-window state + the same unlock control. No list/revoke
of other sessions (no REST surface).

### 3.10 Reports (`#/reports`)

Visible to `idm_people_admins`. Computed in the browser from live
reads. Nothing is stored on the server.

1. **Accounts expiring within N days** — from `account_expire`. CSV
   export uses real newlines and the formula-injection guard.
2. **Passkey adoption per group** — one `_credential/_status` per
   person member (concurrency 4). 403s counted as restricted, not
   probed further. Nested groups skipped and reported.
3. **Membership diff** — two group JSON exports chosen locally, never
   uploaded.

### 3.11 Profile (`#/profile`)

Your identity, auth method, groups. Email edit needs
`idm_people_self_mail_write`. Passkeys and password changes go to
Kanidm’s own credential manager / `/ui/reset` — credentials never pass
through Shenasa.

### 3.12 Settings (`#/settings`)

Requires sign-in.

- Connection: `apiUrl` (…`/v1`), derived OAuth origin (read-only),
  OIDC client id / scope / redirect. **Test connection** fetches that
  client’s discovery document (proves the client exists).
- Theme, idle timeout, optional **locale pack** code (`locales/<code>.json`;
  core stays English).
- Live **Kanidm version** + supported / not supported / not detected.
- **Domain settings** (only `domain_admins` — **not** `idm_admins`):
  domain display name, allow account self-recovery. `PUT
  /v1/domain/_attr/{attr}` with a bare string array; booleans are
  `"true"` / `"false"`.
- Reset clears local overrides.

---

## 4. Everyday operations

### 4.1 Onboard a person

1. Unlock write access.
2. Users → **Onboard wizard** (or New user + groups + reset link).
3. Hand the link/QR over a second channel. They enrol their own
   passkey.
4. For T0/T1: require a passkey, then arm **passkey-only** once ≥1
   key is registered.

### 4.2 Lost password / lost passkey

Same reset-intent as 4.1. Issuing a new link is safe.

### 4.3 Offboard

1. Unlock write access.
2. Users → **Delete** (account stops immediately).
3. Mistake → Recycle bin → **Revive** within 7 days.
4. After 7 days the server purges. Export first if you need a record.

### 4.4 Grant or revoke admin powers

1. Pick the **tier** first (§5), then the role group.
2. Only `idm_admins` edits `idm_*` membership; only
   `idm_access_control_admins` touches system groups.
3. Add/remove the person on the group page. Effect is immediate on the
   server; the user sees it at next sign-in / token refresh.

### 4.5 Register an SSO application

See **[APPS.md](APPS.md) §5**. Short version: unlock → Apps → New
client (public vs basic) → copy basic secret if any → add every exact
`redirect_uri` → add scope maps → point the app at
`/oauth2/openid/<id>/.well-known/openid-configuration`.

### 4.6 Issue a robot token

Service accounts → open the account → **Issue API token**. Leave
read-write **off** unless the integration writes. Copy once.

---

## 5. RBAC & tiering

Builtin ACPs: `server/lib/src/migration_data/dl14/access.rs` (dl15 is
additive). Shenasa’s gates match these.

### 5.1 Builtin roles

| Role group | Grants (summary) | Membership edited by |
| --- | --- | --- |
| `idm_access_control_admins` | Access control; **system-level** groups | itself / system |
| `idm_admins` | Entry-manager of `idm_*` **role groups** — and nothing else by default. Not people, not groups, not PII | `idm_admins` |
| `idm_people_admins` | Create/modify/delete persons | `idm_admins` |
| `idm_people_pii_read` | Read PII | `idm_admins` |
| `idm_people_self_mail_write` | Change own email | `idm_admins` |
| `idm_group_admins` | Ordinary groups and their members | `idm_admins` |
| `idm_service_desk` | Credential-reset intents | `idm_admins` |
| `idm_recycle_bin_admins` | List/revive recycle bin | `idm_admins` |
| `idm_oauth2_admins` | OAuth2/OIDC clients | `idm_admins` |
| `idm_service_account_admins` | Service accounts and API tokens | `idm_admins` |
| `domain_admins` | Domain display name + recovery toggle. `idm_admins` is **not** nested here | system / `system_admins` |
| `idm_schema_admins`, `idm_high_privilege`, … | System/schema | `idm_access_control_admins` |

**`idm_admins` is not all-powerful.** A 403 for an `idm_admins` member
doing people work is correct — also grant `idm_people_admins`. And
step up first (§1.2).

### 5.2 Recommended tiers

| Tier | Purpose | Groups | Account style |
| --- | --- | --- | --- |
| **T0** | Protect the IdM | `idm_access_control_admins`, `idm_schema_admins`; `idm_admin` recovery offline | Dedicated `a-` accounts, passkey-only, hardware keys |
| **T1** | Role curation + people/groups | `idm_admins` plus people/group admins as needed | Dedicated `a-` accounts, passkey-only |
| **T2** | Helpdesk, apps, recycle, PII read | `idm_service_desk`, `idm_oauth2_admins`, `idm_recycle_bin_admins`, `idm_people_pii_read` | Daily account OK for helpdesk; passkey recommended |
| **T3** | Workforce | Ordinary `app-*` / `dept-*` | Daily accounts |

### 5.3 Hard rules

1. Separate admin identities from daily ones.
2. Passkey-only for T0/T1 after ≥1 hardware key (keep a spare enrolled).
3. Least privilege, additive grants.
4. Never nest an ordinary group *into* an `idm_*` role group.
5. Recycle-bin admin is its own grant — revive restores privileges too.
6. OAuth2 admin ≠ people admin. Keep `idm_oauth2_admins` tiny; keep
   strict redirect on.
7. `idm_access_control_admins` is break-glass. 2–3 named humans.
8. Protect `idm_admin` recovery (printed by bootstrap; rotated on each
   setup run).
9. Recertify `idm_*` membership quarterly (Groups → Export JSON +
   Reports diff).
10. Do not bypass the write window.

### 5.4 Example (~2000 users)

| Duty | Group(s) |
| --- | --- |
| Platform / ACP / schema | `idm_access_control_admins`, `idm_schema_admins` |
| Role curation + lifecycle | `idm_admins` + `idm_people_admins` + `idm_group_admins` |
| Resets, on-call revive | `idm_service_desk` (+ `idm_recycle_bin_admins`) |
| App onboarding | `idm_oauth2_admins` |
| HR reporting | `idm_people_pii_read` via a service account |
| Business access | `dept-*`, `app-*` with a written Description |

### 5.5 403 decision tree

```
HTTP 403 on a write?
├─ Chip shows 🔒 read-only?
│   └─ YES → Unlock write access, retry.
└─ Chip shows ✍ writes active?
    ├─ Persons / PII?            → idm_people_admins (+ pii_read)
    ├─ Ordinary group?           → idm_group_admins
    ├─ idm_* role membership?    → idm_admins
    ├─ System group / schema?    → idm_access_control_admins
    ├─ Recycle bin?              → idm_recycle_bin_admins
    ├─ OAuth2 clients?           → idm_oauth2_admins
    ├─ Service accounts / tokens?→ idm_service_account_admins
    └─ Domain settings?          → domain_admins
```

---

## 6. Operator hygiene

- Idle sign-out 10–15 min on every admin workstation.
- Prefer **Sign out** over closing the tab.
- Lock the OS while a write window is open (bearer-equivalent).
- Do not share admin accounts.
- Check Sessions occasionally (token id, purpose, window).

## 7. Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| 401 right after SSO | Old build sent the OIDC access token to `/v1`. Upgrade. |
| 403 on *every* write, roles correct | Read-only session → Unlock write access. |
| Buttons missing | Reload once; else you lack the role (§5.5). |
| `m.mirzamohammadi` rejected | Old validator; dots are legal. |
| Passkey prompt never appears | No WebAuthn, non-HTTPS, or clock skew. |
| Signed back in instantly after sign-out | Old build kept the server cookie. Redeploy + Ctrl+F5. |
| Blank page at `/admin` | Need `/admin/`. v1.3 configs redirect. |
| Apps dropdown “does nothing” | Fields are supposed to stay the same. [APPS.md](APPS.md). |
| SSO redirect mismatch after creating a client | Origin missing or not exact. Add the callback. Clients created before this release did not auto-PATCH origin. |
| Need audit events | No REST API — server journal. |
| Settings 403 / missing domain editor | `domain_admins`, not `idm_admins`. |
