# GO-LIVE checklist — private GitHub publish

Publishing Shenasa to a **private** GitHub repository, step by step.

## 1. Pre-flight (local)

- [ ] `npm install && npm run check` passes (lint + smoke tests).
- [ ] `bash test/integration.sh` passes on a docker host.
- [ ] No secrets in the working tree:
      `grep -rinE 'password|secret|token|private.?key' js/config.js css/ index.html`
      should show only inert words; real credentials may only ever live in
      `deploy/out/`, `deploy/tls/` (git-ignored).
- [ ] `git status` clean of generated artifacts
      (`deploy/out/`, `deploy/ui/`, `deploy/tls/`, `dist/`, `node_modules/`).
- [ ] `.gitignore` present; confirm `git check-ignore deploy/tls/key.pem`.
- [ ] README quick-start values match your domains, and `js/config.js`
      defaults are the intended public ones.

## 2. Repository setup

- [ ] Create the repo as **private** (web UI → New → Private). Do **not**
      publish TLS keys, `idm_admin` credentials, or recovered passwords.
- [ ] Branch protection on `main`: require PR reviews, require CI checks
      (lint-test, integration, security-audit) to pass before merge.
- [ ] Enable Dependabot alerts and secret scanning (Security tab → Code
      security and analysis).
- [ ] Add topics/description; set the homepage to your Shenasa URL.

## 3. First push

```sh
git init -b main
git add .
git commit -m "Shenasa 0.1.0 — Kanidm admin UI"
git remote add origin git@github.com:<org>/shenasa.git
git push -u origin main
```

- [ ] CI workflow appears under Actions and goes green on `main`.
- [ ] Tag the release: `git tag -a v0.1.0 -m "0.1.0" && git push origin v0.1.0`.
- [ ] Create a GitHub Release from the tag; attach
      `dist/shenasa-ui-0.1.0.tar.gz` (`make release`).

## 4. Production deployment

- [ ] `bash deploy/setup.sh idm.example.com` (single-origin) — or the
      two-domain variant — on the target host.
- [ ] Install **publicly trusted certificates** (replace the quickstart CA).
- [ ] Verify with the checklist in `deploy/README.md` (discovery document,
      SSO round-trip, RBAC gating).
- [ ] Create operator accounts; assign role groups; register passkeys.
- [ ] Schedule Kanidm backups (`online_backup` in `server.toml`) and test a
      restore once.

## 5. Ongoing

- [ ] Pin `kanidm/server` image digests in production compose files.
- [ ] Review access quarterly (role-group membership).
- [ ] Keep `CHANGELOG.md` current; bump `package.json` version per release.
- [ ] Rotate the `idm_admin` password; keep it out of chat/email.
