# Shenasa locale packs (optional, community-maintained)

Shenasa's audited core ships **English-only**. A deployment may optionally
load ONE community language pack as an external JSON file. Packs are **pure
data**: they can only override existing translation keys, can only contain
strings, and are fetched same-origin under the existing CSP
(`connect-src 'self'`). The English-only source-guard test keeps passing —
packs are not code and are not required.

## How it works

1. Create `locales/<code>.json` next to `index.html` (e.g. `locales/de.json`
   or `locales/fa.json`). `<code>` must match
   `^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$` (e.g. `en`, `de`, `fa`, `pt-BR`).
2. The file is a flat object mapping Shenasa translation keys to strings:

   ```json
   {
     "nav.users": "Benutzer",
     "nav.groups": "Gruppen",
     "common.save": "Speichern",
     "users.title": "Benutzer"
   }
   ```

   - Only keys that already exist in `js/i18n.js` (`window.ShenaStrings`)
     are honoured — unknown keys are ignored.
   - Only string values are honoured — numbers, objects, `null` are ignored.
   - `{placeholder}` variables (e.g. `{n}`, `{name}`) must be kept verbatim.
   - Missing keys fall back to English at runtime.
3. Set the pack code in **Settings → Language pack** (stored in the
   `shenasa.config` localStorage as `locale`), or pre-seed it in
   `window.SHENASA_CONFIG` via `js/config.js` / `?locale=` query parameter.
4. Reload. The pack is fetched once at boot (`GET locales/<code>.json`);
   if the fetch fails (404, invalid JSON), Shenasa silently stays on
   English and Settings shows a note.

## Security notes

- Pack JSON is never `eval`'d; it goes through `JSON.parse` and a strict
  key/value allowlist (`ShenaI18n.applyPack`).
- Translated strings pass through the same `Ui.esc()` HTML escaping as
  English strings, so a pack cannot inject markup, scripts or attributes.
- Packs do not change layout direction (`<html dir>` stays `ltr`); RTL
  packs are rendered LTR today (tracked for a future release).

## Contributing a pack

Open an issue/PR at <https://github.com/mirzamohamadi/shenasa> with your
`locales/<code>.json`. Packs that cover 100% of the current keys (list them
with `Object.keys(ShenaStrings)` in the browser console) are linked from
the README's community section.
