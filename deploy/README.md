# Deploying Shenasa with Kanidm

This directory brings up a **real Kanidm server plus the Shenasa UI**. There
are two phases; phase 2 depends on phase 1.

- **Phase 1 — Deploy Kanidm** (server, TLS, database, systemd/container)
- **Phase 2 — Integrate Shenasa** (OAuth2 client, static hosting, sign-in)

The fastest path is `setup.sh`, which does both phases in one command.

```
bash deploy/setup.sh idm.example.com                     # Topology A (single-origin)
bash deploy/setup.sh idm.example.com shenasa.example.com # Topology B (two-domain)
```

## Topology A — single-origin (recommended default)

Kanidm and Shenasa share one domain; the SPA lives under `/admin/`:

| piece | URL |
| --- | --- |
| Kanidm | `https://idm.example.com` |
| Shenasa UI | `https://idm.example.com/admin/` |
| REST API (`apiUrl`) | `https://idm.example.com/v1` |
| OIDC redirect | `https://idm.example.com/admin/` |

No CORS is involved: the browser only ever talks to one origin.

## Topology B — two-domain

Kanidm on `idm.example.com`, Shenasa on `shenasa.example.com`.
**Recommended setup:** the SPA vhost also reverse-proxies `/v1`, `/oauth2`,
`/_session` and `/.well-known` (see `Caddyfile.example` /
`nginx/two-domain.conf.example`), so the browser still talks to a single
origin (`apiUrl=https://shenasa.example.com/v1`) and **no CORS is needed**.
If you instead point the SPA directly at `https://idm.example.com/v1`, that
route goes cross-origin and **needs CORS**: both example configs pin
`Access-Control-Allow-Origin` to the exact SPA origin, answer preflight
`OPTIONS`, and combine it with `Allow-Credentials` — never use `*` with
credentials.

| piece | URL |
| --- | --- |
| Kanidm | `https://idm.example.com` |
| Shenasa UI | `https://shenasa.example.com` |
| REST API (`apiUrl`) | `https://shenasa.example.com/v1` (proxied) or `https://idm.example.com/v1` (CORS) |
| OIDC redirect | `https://shenasa.example.com/` |

---

## Phase 1 — Deploy Kanidm

1. **Prerequisites**: a host with Docker + Compose v2, a public DNS name
   (`idm.example.com`) pointing at it, ports 80/443 (and optionally 636 for
   LDAPS) reachable.
2. **TLS**: Kanidm only speaks TLS. Provide `deploy/tls/chain.pem` and
   `deploy/tls/key.pem` (publicly trusted for production). If absent,
   `setup.sh` generates a **local CA** for evaluation — browsers must trust
   `deploy/tls/ca.pem` until you install real certificates.
3. **Configuration**: `out/server.toml` is rendered from
   `server.toml.example` (bind `0.0.0.0:8443`, LDAP `0.0.0.0:3636`, domain,
   origin, `db_path`, TLS paths). Nothing in these configs disables TLS
   verification.
4. **Start**: `docker compose -f deploy/docker-compose.yml up -d` (or
   `make up`). Watch with `make logs`.

## Phase 2 — Integrate Shenasa

1. `bootstrap.sh` recovers the `idm_admin` password
   (`kanidmd recover-account` inside the container), logs in over the REST
   step-based auth flow, and creates the **public OAuth2 client**
   `shenasa_admin_ui`:
   - public client → **PKCE only, no secret**;
   - redirect/landing URL → the SPA URL of your topology;
   - scope maps for the role groups (`openid,profile,email,groups` — the
     `groups` scope emits group SPNs that become UI roles).
2. The SPA is staged in `deploy/ui/` with a default `js/config.js` pointing
   at the rendered domains, and served by Caddy (single-origin vhost under
   `/admin/`, or its own vhost in two-domain mode).
3. Create users and put them in the role groups, e.g. via the Kanidm web UI
   or CLI (`kanidm group add-members idm_people_admins jane@idm.example.com`),
   or with the optional provisioning:
   `bash deploy/seed.sh --operators-group --operator jane --email jane@…`.
4. Sign in at the Shenasa URL with **Sign in with SSO** or
   **Sign in with passkey**.

## One-command setup (details)

`setup.sh <idm-domain> [ui-domain] [--seed]`:

1. prepares `deploy/{out,tls,ui}`;
2. generates a local CA + leaf if `tls/chain.pem` is missing;
3. renders `out/server.toml` and `out/Caddyfile`;
4. stages the SPA into `deploy/ui` and rewrites its default config for the
   domains;
5. `docker compose up -d` and waits for readiness;
6. runs `bootstrap.sh` (and `seed.sh` when `--seed`).

Re-running it is safe; existing TLS material and configuration are kept.

## Verification checklist

- [ ] `curl --cacert deploy/tls/ca.pem https://idm.example.com/` returns the
      Kanidm web UI (skip `--cacert` with public certificates).
- [ ] `https://idm.example.com/oauth2/openid/shenasa_admin_ui/.well-known/openid-configuration`
      returns the discovery document **and** its `authorization_endpoint`
      starts with `https://idm.example.com/ui/oauth2` (origin root,
      not `/v1`).
- [ ] Opening the Shenasa URL → login card offers **SSO** and **passkey**;
      no username/password form.
- [ ] SSO redirects to Kanidm, returns with `?code`, the SPA exchanges it at
      `<origin>/oauth2/token` (check DevTools → Network — never
      `/v1/oauth2/token`).
- [ ] The dashboard shows live numbers; Users/Groups reflect server data.
- [ ] A user **without** role groups sees buttons disabled (server would
      still reject attempts).
- [ ] Sign-out returns to the login page AND the Kanidm session is closed
      (a fresh SSO click asks for credentials again — check
      `docker logs shenasa-kanidm` for the logout event).
- [ ] `bash test/integration.sh` passes on a docker host.

### Audit logs

Kanidm 1.10 does not expose audit events over its REST API (Shenasa
therefore has no audit page). Every server event is logged with an
operation UUID — read them with:

```sh
docker logs -f shenasa-kanidm            # live audit/event stream
docker logs shenasa-kanidm --since 1h | grep -i <operation-id-or-user>
```

### Which role can change which group (403s are by design)

- `idm_group_admins` → ordinary groups only (never the built-in idm_* ones).
- `idm_admins` → membership of the built-in `idm_*` role groups
  (they are `entry_managed_by: idm_admins`).
- system-level groups (`idm_high_privilege`, `idm_access_control_admins`,
  `idm_schema_admins`, `idm_recycle_bin_admins`,
  `idm_oauth2_admins`) → only `idm_access_control_admins` /
  system admins (e.g. recovered via `kanidmd recover-account admin`).
- recycle bin (list + revive) → `idm_recycle_bin_admins`.

## Performance & scale (enterprise workloads)

Kanidm handles thousands of accounts and dozens of applications on modest
hardware — the hot paths are Rust/async with an in-memory entry cache in
front of LMDB. Shenasa itself is a **static SPA: it never sits in the
token path** and adds zero latency to your SSO traffic. Reference points
for ~2,000 users and ~50 applications:

1. **The biggest lever is application-side, not server-side.** OAuth2
   access tokens are self-contained JWS (JWT) tokens. Applications should
   **cache and re-use them until `exp`** and validate them locally
   (against the JWKS from the discovery document) per request — not fetch
   a new token per API call. Per-request token exchange wastes CPU on
   PKCE verification and one signature per token on both sides; with token
   caching, the majority of SSO traffic disappears before it reaches
   Kanidm.
2. **Sizing**: a general rule is 4 vCPU / 8 GB RAM for this scale —
   plenty of headroom. Set `thread_count` explicitly so the worker pool
   matches the container's vCPU limit (the default heuristic reads the
   host's parallelism). Keep `log_level = "info"` (`trace` slows hot
   paths).
3. **Health checks**: `GET /status` is the built-in liveness/readiness
   endpoint — wire it into your LB/monitoring (also useful for uptime
   alerts).
4. **Client IPs in audit logs**: enable `trust_x_forward_for = true` only
   because the sole ingress is the proxy (this deployment binds 8443 to
   localhost); otherwise leave it off to prevent IP spoofing.
5. **Disable what you don't use**: comment out `ldapbindaddress` if no
   legacy app needs LDAP(S).
6. **Backups & recovery**: enable `online_backup` (nightly, 7 versions)
   — it is also your quick-restore lane. Kanidm 1.10's multi-node
   replication exists but is flagged by upstream as a development feature
   in this release; design HA as *backup + fast redeploy* today and adopt
   replicas when your version marks them production-ready.
7. **Load testing**: exercise the token endpoint before go-live with a
   tool like `k6`/`wrk2` against
   `https://idm.example.com/oauth2/token` (authorization-code exchanges)
   and `/oauth2/openid/<client>/.well-known/openid-configuration` to
   establish your real headroom with your client mix.

Performance-relevant knobs (verified against `server/core/src/config.rs`
of v1.10.5): `thread_count`, `db_fs_type`, `trust_x_forward_for`,
`log_level`; all are also settable via `KANIDM_*` environment variables.
Do NOT touch `db_arc_size` (internal cache sizing, upstream warns against
changing it).

## Running Kanidm 1.11 (default pin) — and staying on 1.10

Shenasa is verified compatible with **both** Kanidm 1.10.x and 1.11.x (the
two releases expose identical `/v1` route sets; their builtin ACP and auth
constants match — evidence in the README compatibility table). The deploy
layer pins `kanidm/server:1.11.0` by default; to stay on the battle-tested
1.10 line, pin `kanidm/server:1.10.5` instead (Docker Hub tags have no `v`
prefix). Kanidm upgrades are **one-way**: the first boot of a newer version
migrates the database and **downgrades are not supported upstream**.

Upgrading an existing 1.10 deployment to 1.11:

1. Read the [1.11.0 release notes](https://github.com/kanidm/kanidm/releases/tag/v1.11.0)
   and the upstream upgrade documentation.
2. **Back up the database volume** — at minimum stop the stack and copy
   the volume first. All compose commands run from `deploy/` (the compose
   file lives there, not in the project root), and the data volume is
   named `<compose-dir>_kanidm_data` — with these scripts that is
   **`deploy_kanidm_data`** (confirm with `docker volume ls`):

   ```sh
   cd deploy && docker compose stop kanidm
   docker run --rm -v deploy_kanidm_data:/data -v "$HOME":/backup alpine \
     tar czf /backup/kanidm-data-pre-1.11.tgz -C /data .
   tar tzf "$HOME"/kanidm-data-pre-1.11.tgz | head   # must list kanidm.db…
   cd deploy && docker compose start kanidm
   ```

   ⚠️ Point `-v` at the volume that actually exists: Docker silently
   **creates an empty volume** for a misspelled name and you would back up
   nothing (a ~100-byte tar is an empty archive — always `tar tzf` it).
3. Edit `deploy/docker-compose.yml`: `kanidm/server:1.10.5` →
   `kanidm/server:1.11.0` (Docker Hub tags have no `v` prefix).
4. From `deploy/`: `docker compose pull kanidm && docker compose up -d`
   and watch `docker compose logs -f kanidm` until the migration
   completes.
5. Verify: **Settings** in Shenasa shows the detected server version with
   a green *supported* badge (read from the `X-KANIDM-VERSION` header), or
   `curl -sI https://<your-domain>/ | grep -i x-kanidm-version`.

Shenasa needs **no config change** for 1.11 — the UI talks to the same
endpoints and detects the version automatically.

⚠️ **Re-running `setup.sh` after re-unzipping a release zip** resets
`deploy/docker-compose.yml` to the zip's default pin. If your server has
already been upgraded beyond that tag, `setup.sh` **aborts** with a clear
`refusing to DOWNGRADE` error instead of crash-looping Kanidm against a
newer database (`MG0010DowngradeNotAllowed`). Fix: re-pin the compose file
to the tag your deployment last ran, then re-run. The same guard also
diagnoses the situation from the container logs if the readiness wait
times out.

## Files

| file | purpose |
| --- | --- |
| `docker-compose.yml` | Kanidm + Caddy (or bring your own images) |
| `server.toml.example` | Kanidm configuration template |
| `Caddyfile.example` / `Caddyfile.ui` | reverse-proxy + SPA serving with hardened headers |
| `nginx/*.conf.example` | nginx equivalents (single-origin + two-domain with CORS) |
| `Dockerfile.ui` | static SPA image (`docker build -f deploy/Dockerfile.ui .`) |
| `setup.sh` | one-command org setup |
| `bootstrap.sh` | recover admin, create the OAuth2 client |
| `seed.sh` | optional operator provisioning (**no fake data by default**) |
| `../test/integration.sh` | real-Kanidm end-to-end verification |
