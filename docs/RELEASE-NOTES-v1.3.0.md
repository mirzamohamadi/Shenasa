**Shenasa v1.3.0** is the first public tag after **v1.1.0**. It ships the
roadmap *Operations at scale* and *Deeper lifecycle* work in one release
(the v1.2 tag is skipped). Still a static vanilla-JS SPA: no framework,
no build step, no runtime npm packages, no CDNs.

Verified Kanidm range is unchanged: **1.10.x** and **1.11.x**.

### Features since v1.1.0

- **Bulk user actions (dry-run first)** — multi-select, add-to-group in
  one batched `POST /v1/group/{id}/_attr/member`, set/clear expiry.
  Clear is Kanidm’s empty-array purge. `idm_*` role groups are excluded
  from bulk add.
- **Group membership CSV import** — dry-run classifies add / remove /
  no-op / conflict, then applies one request per (group, action).
- **Reports** (`#/reports`) — accounts expiring within N days (+ CSV),
  passkey adoption per group (403-tolerant), client-side diff of two
  group JSON exports. Nothing is stored on the server.
- **Onboarding wizard** — person → baseline groups → first-sign-in link
  with QR.
- **Credential status card** — live types/labels/UUID from
  `GET /v1/person/{id}/_credential/_status`. No secrets.
- **Domain settings** (`domain_admins` only) — display name and the
  account-recovery toggle. There is still **no** admin “send recovery
  email” API; the user page links to `/ui/recover`.
- **Optional locale packs** (`locales/<code>.json`). Audited core stays
  English-only.

### Security since v1.1.0

- **CSP** `style-src 'self'` only. `'unsafe-inline'` is gone from the
  meta tag and every deploy config.
- **URL allow-list** — `apiUrl` / `oidcRedirectUri` accept only `https://`
  or loopback `http://`. `javascript:`, `data:`, `file:`, remote `http`
  cannot become navigation sinks.
- Dev server refuses `..`, bad `%`, and hidden path segments (`.git`,
  `.env`).
- Report CSV uses real newlines and the same formula-injection guard as
  the users export (`= + - @` prefixed).
- Clearing a person’s email sends Kanidm’s purge form (`[]`), not a
  silent no-op.
- User/group CSV imports capped at 2000 rows.

### Apps (read if you run SSO apps)

This is **not** a Kanidm incompatibility. Create never takes a secret.
The dropdown only selects `POST /v1/oauth2/_public` vs `_basic`.

What was wrong in v1.1.0:

- The type dropdown did not change any help, so it looked dead.
- After save the URL stayed on `#/apps`; the secret card lives on the
  **detail** page, not a tab on the form.
- Create did not write `oauth2_rs_origin`. With strict redirect on,
  authorize rejected the callback until an operator added the landing
  URL by hand.

What this release does:

- Live note under the type control.
- After basic create, the generated secret is shown once (same modal as
  **Reveal basic secret**).
- Create PATCHes `oauth2_rs_origin` from the landing URL and navigates to
  `#/apps/{id}`.

You still have to add scope maps and any callback that is not the
landing URL. Operator detail: [docs/APPS.md](https://github.com/mirzamohamadi/shenasa/blob/v1.3.0/docs/APPS.md).

### Also fixed

- Service-account **Issue API token** checkboxes rendered raw JavaScript
  instead of labels. They now read **Read-write (unchecked = read-only)**
  and **Shorter token string**.
- Malformed `%` in the query string or hash no longer crashes boot.
- Opening `/admin` (no trailing slash) no longer renders a blank page.

### Compatibility

| Shenasa | Kanidm | Status |
| --- | --- | --- |
| v1.3.0 | 1.10.x / 1.11.x | Supported |
| v1.3.0 | ≤ 1.9.x | Unsupported |
| v1.3.0 | ≥ 1.12.x | Unverified |

Settings shows the live `X-KANIDM-VERSION` badge.

### Upgrade from v1.1.0

```sh
# On a 1.10.x host, set the compose pin back to kanidm/server:1.10.5
# before setup — the zip defaults to 1.11.0 and Kanidm cannot downgrade.
unzip shenasa-admin-v1.3.0.zip
cd shenasa-admin-v1.3.0
bash deploy/setup.sh idm.example.com
```

`setup.sh` is idempotent and **rotates the `idm_admin` recovery
password** when bootstrap re-runs. Store the new password. Then
Ctrl+F5 and **Sign out** once.

### Fresh install

```sh
unzip shenasa-admin-v1.3.0.zip
cd shenasa-admin-v1.3.0
bash deploy/setup.sh idm.example.com
```

71/71 self-tests · `bash test/integration.sh` against a real
`kanidm/server:1.11.0` (public + basic OAuth2) · MIT.

Docs: [USER-GUIDE](https://github.com/mirzamohamadi/shenasa/blob/v1.3.0/docs/USER-GUIDE.md) ·
[Apps](https://github.com/mirzamohamadi/shenasa/blob/v1.3.0/docs/APPS.md) ·
[CHANGELOG](https://github.com/mirzamohamadi/shenasa/blob/v1.3.0/CHANGELOG.md) ·
[SECURITY](https://github.com/mirzamohamadi/shenasa/blob/v1.3.0/SECURITY.md)
