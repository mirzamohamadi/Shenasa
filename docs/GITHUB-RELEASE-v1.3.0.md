# GitHub publish pack — Shenasa v1.3.0

Paste-ready names, descriptions, tag, and release notes.

GitHub currently has tags `v1.0.0` and `v1.1.0` only. This tree is the
complete post-1.1.0 work. **Publish it as `v1.3.0`.** Do not also create
`v1.3.1` or a retroactive empty `v1.2.0`.

Repository: <https://github.com/mirzamohamadi/shenasa>

---

## 1. Repository About (Settings → General)

**Description** (≤ 350 characters):

```
Dependency-free admin UI for Kanidm. Vanilla-JS SPA (no build, no runtime deps): SSO (OIDC+PKCE) & passkey sign-in, step-up write unlock, RBAC-aware users/groups, OAuth2/OIDC apps, service accounts, reports, recycle bin. Source-verified for Kanidm 1.10.x & 1.11.x.
```

**Website:** your production Shenasa URL, or leave empty.

**Topics:**

```
kanidm
identity-management
admin-ui
webauthn
passkeys
fido2
oidc
oauth2
rbac
vanilla-javascript
security
```

Replace the current About text (still the v1.1.0 / Kanidm 1.10-only line).

---

## 2. Commands (from the repo root)

```sh
npm install
npm run check
bash test/integration.sh    # must print basic client + _basic_secret

git add -A
git status                  # no deploy/tls, deploy/out, node_modules

git commit -m "Shenasa v1.3.0 — operations at scale, lifecycle depth & Apps hardening" -m "$(cat <<'EOF'
Ships roadmap v1.2 + v1.3 as one public tag after v1.1.0 (v1.2 skipped).

Added since v1.1.0
- Bulk user actions (dry-run first): add-to-group, set/clear expiry.
- Group-membership CSV import with dry-run verdicts.
- Governance reports: expiring accounts, passkey adoption, membership diff.
- Onboarding wizard, credential-status card, domain settings editor.
- Optional community locale packs. k6 package. CI matrix 1.10.5 + 1.11.0.

Security
- CSP style-src 'self' only (no unsafe-inline).
- Connection URL allow-list (https or loopback http).
- Dev-server path lock-down.
- Formula-injection guard on report CSV; mail-clear purge; CSV row cap.

Apps
- Create dropdown explains public vs basic (fields stay the same).
- Basic create reveals the generated secret once.
- Create PATCHes oauth2_rs_origin from the landing URL and sets #/apps/{id}.

71/71 self-tests. Zero runtime dependencies. MIT.
EOF
)"

git tag -a v1.3.0 -m "Shenasa v1.3.0 — operations, lifecycle depth & Apps hardening (Kanidm 1.10/1.11)"

git push origin main

gh release create v1.3.0 \
  --title "Shenasa v1.3.0 — operations, lifecycle & Apps hardening (Kanidm 1.10/1.11)" \
  --notes-file docs/RELEASE-NOTES-v1.3.0.md \
  --target main

git push origin v1.3.0
```

Pushing `v1.3.0` triggers `.github/workflows/release.yml` (zip + sha256
on the GitHub Release, UI image to GHCR as `1.3.0` / `1.3`).

---

## 3. Release title

```
Shenasa v1.3.0 — operations, lifecycle & Apps hardening (Kanidm 1.10/1.11)
```

Notes file: `docs/RELEASE-NOTES-v1.3.0.md`.
