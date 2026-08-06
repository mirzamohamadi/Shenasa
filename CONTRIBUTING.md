# Contributing to Shenasa

Thanks for helping improve Shenasa! This project has a deliberately strict
architecture — please keep it intact.

## Hard constraints

- **Vanilla HTML/CSS/JS only.** No frameworks (React/Vue/Angular), no
  bundlers, no transpilers, no runtime npm dependencies.
- Plain scripts loaded with `<script src>` in order; modules attach helpers
  to `window` (no `import`/`export`).
- ES5-friendly plain functions for broad browser support.
- No external fonts/CDNs; the UI must work offline (system font stack).
- English-only UI (LTR), strings centralised in `js/i18n.js` behind `t()`.
- The app talks to a **real Kanidm server**. Never add demo modes, mock
  backends, or test users to production code (tests inject a fake API).
- OIDC/OAuth2/WebAuthn endpoints stay at the **origin root**, never `/v1`.

## Development workflow

```sh
npm install        # dev-only (jsdom)
npm run check      # syntax lint + jsdom smoke tests — must pass
npm start          # local static server on :8080
bash test/integration.sh   # real-Kanidm end-to-end test (needs docker)
```

Before committing:

1. `npm run check` is green.
2. New UI strings go through `t()` in `js/i18n.js`.
3. All user-provided values reach HTML only through `Ui.esc()`.
4. New buttons are RBAC-gated with the `Store.can*` helpers.
5. New shell/CI changes keep `shellcheck`-clean behaviour where practical.

## Code style

- 2-space indentation, single quotes, semicolons, `'use strict'` IIFEs.
- Comments at file headers explain the *why* (see existing modules).
- Errors are normalised to `ApiError {status, message, code}` and surfaced
  via `Ui.handleError` — don't invent parallel error paths.

## Testing expectations

- Add/extend `test/smoke.test.js` for behaviour changes (pure-logic tests
  must not require jsdom so `npm run check` works offline).
- Keep the deploy-guard tests honest: security headers present, no TLS
  verification bypass in `deploy/`.
- If you touch `js/qrcode.js`, re-verify against a reference encoder
  (see the header comment for the approach) before merging.

## Pull requests

- Small, focused PRs with a description of user-visible changes.
- Update `CHANGELOG.md` (Unreleased section) and docs when relevant.
- CI must be green: lint+test (Node 20/22), image build, integration, audit.

## Security issues

Do **not** open public issues — see [SECURITY.md](SECURITY.md).
