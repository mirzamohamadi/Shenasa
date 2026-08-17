# GO-LIVE checklist — public GitHub publish (v1.3.0)

Publishing Shenasa v1.3.0 to **github.com/mirzamohamadi/shenasa**.
Paste-ready names and notes: `docs/GITHUB-RELEASE-v1.3.0.md`.

## 1. Pre-flight (local)

- [ ] `npm install && npm run check` is green (71 tests at time of writing).
- [ ] On a Docker host: `bash test/integration.sh` — must print
      `creating basic OAuth2 client` and
      `public + basic OAuth2 and SSO endpoints OK`.
- [ ] No secrets in the working tree. Real credentials may only live in
      `deploy/out/`, `deploy/tls/` (git-ignored).
- [ ] `git check-ignore -v deploy/tls/key.pem` succeeds.
- [ ] `package.json` version is `1.3.0`; CHANGELOG `[1.3.0]` is dated;
      README compatibility table says v1.3.0.
- [ ] `js/config.js` defaults are `idm.example.com` placeholders.

## 2. Repository About (web UI)

- [ ] Description = the 350-char block in `docs/GITHUB-RELEASE-v1.3.0.md`
      (replace the leftover v1.1.0 / Kanidm 1.10-only line).
- [ ] Topics: `kanidm`, `identity-management`, `admin-ui`, `webauthn`,
      `passkeys`, `fido2`, `oidc`, `oauth2`, `rbac`, `vanilla-javascript`,
      `security`.
- [ ] Protect `main` (PR + CI green, no force-push).
- [ ] Security: Dependabot alerts, private vulnerability reporting
      (SECURITY.md is in place).

## 3. Commit, tag, release

Follow **`docs/GITHUB-RELEASE-v1.3.0.md` §2** exactly.

- [ ] One commit on `main`.
- [ ] Annotated tag `v1.3.0` — do **not** also push `v1.3.1` or `v1.2.0`.
- [ ] `git push origin main`, then `gh release create` (or the web UI),
      then `git push origin v1.3.0`.
- [ ] Confirm `release.yml` attached `shenasa-admin-v1.3.0.zip` + `.sha256`.
- [ ] Confirm GHCR image `ghcr.io/mirzamohamadi/shenasa-ui:1.3.0` if the
      workflow ran.

## 4. Production host (after the tag exists)

- [ ] `bash deploy/setup.sh idm.example.com` (or two-domain). On a 1.10.x
      host, re-pin `kanidm/server:1.10.5` first — the zip defaults to
      1.11.0 and Kanidm cannot downgrade.
- [ ] Replace the quickstart CA with publicly trusted certificates.
- [ ] Store the **new** `idm_admin` password (bootstrap rotates it).
- [ ] Verify: discovery document, SSO round-trip, write unlock, one Apps
      create (public + basic), recycle revive.
- [ ] Create operator accounts; assign role groups; register passkeys.
- [ ] Enable `online_backup` in `server.toml` and test a restore once.

## 5. Ongoing

- [ ] Pin `kanidm/server` image digests in production compose files.
- [ ] Review `idm_*` membership quarterly (Groups → Export JSON + Reports
      diff).
- [ ] Keep CHANGELOG current; bump `package.json` per release.
- [ ] Rotate `idm_admin`; keep it out of chat/email.
