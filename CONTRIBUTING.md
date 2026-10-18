# Contributing to CraftRCON

Thanks for helping. This page covers how to set up, how to add a language and the one rule every pull
request must follow: **raise `VERSION`**.

## Set up

You need Node.js 22.13 or later (the panel uses the built-in `node:sqlite`; on Node 22 it prints an
`ExperimentalWarning`, which the `npm` scripts and the service hide with
`--disable-warning=ExperimentalWarning`).

```bash
npm ci
npm test            # the panel tests (node:test)
npm run test:shell  # the installer's shell unit tests (needs bash)
npm run fake-mc     # a fake Minecraft server: RCON on 25575 (password "dev"), game port 25565
npm start           # the panel (use CRAFTRCON_CONFIG to point to a config file, see src/config.js)
```

Rules of the project:

- No native dependencies and no build step. The interface is plain ES modules served as they are, with
  Preact and htm included in `public/vendor/` (never loaded from a CDN).
- The RCON password must never reach the browser: no API response includes it, not even encrypted.
- Every visible string of the interface comes from `locales/<lang>.json`, and every message of the
  installer from `scripts/lib/messages.<lang>.sh`. Do not hard-code text.
- Tests use `node:test` and `node:assert/strict`, and their output must be clean (no warnings, no stray
  logs). Add a test with every fix or feature.
- Shell scripts must pass `shellcheck` (see `.shellcheckrc`) and keep working with `set -Eeuo pipefail`.
- Write code, identifiers, comments and commit messages in English.

## The `VERSION` rule

`VERSION` holds the version of the project (`MAJOR.MINOR.PATCH`, for example `0.1.0`).
`sudo ./update.sh` decides what to do by comparing it with the installed version, so every change that
reaches `main` must **raise it**. The `version-bump` CI check fails a pull request whose `VERSION` is not
higher than the one on `main`.

- Bug fix or small change: raise the patch number (`0.1.0` to `0.1.1`).
- New feature: raise the minor number (`0.1.1` to `0.2.0`).
- Incompatible change: raise the major number.

`main` must always be installable: database migrations (`src/db/migrations/NNN_name.sql`) must apply on
top of any earlier version of `main`, and never edit a migration that was already released; add a new one.

## Add a language

The interface and the installer are translated separately. Take Spanish as the example of a finished
translation (`es`) and replace `fr` with your language code.

### The interface

1. Copy `locales/en.json` to `locales/fr.json` and translate every value. Keep the keys and the
   `{placeholders}` exactly as they are. Minecraft's own replies are never translated.
2. Register the language in `LANGUAGES` in `public/js/i18n.js`:

   ```js
   export const LANGUAGES = [
     { code: 'en', name: 'English' },
     { code: 'es', name: 'Español' },
     { code: 'fr', name: 'Français' },
   ];
   ```

   Nothing else in the code needs to change: the language selectors read that list.
3. Add the language to the list asserted by `test/i18n.test.js` ("LANGUAGES registers ..."), and extend
   `test/locales.test.js` so that it also compares `fr.json` with `en.json` (same keys, same
   placeholders).
4. Run `npm test`.

### The installer

1. Copy `scripts/lib/messages.en.sh` to `scripts/lib/messages.fr.sh` and translate the text inside the
   quotes. Every `MSG_` key of `messages.en.sh` must exist, and the values are `printf` formats: keep `%s`
   and write `%%` for a literal percent sign. `test/shell/test_common.sh` fails if the keys differ.
2. Accept the code in the two places that list the languages: `set_lang` in `scripts/lib/common.sh` and the
   `--lang` option in `scripts/lib/flow.sh` (both have `en | es)`). Update the "use en or es" and
   `--lang en|es` texts in `messages.*.sh`.
3. Run `npm run test:shell`, and try `sudo ./install.sh --lang fr` or `CRAFTRCON_LANG=fr`.

### The documentation (optional)

Translate `README.md` as `README.<lang>.md` and link it from the language line at the top of each README.

## Pull requests

- Keep each pull request small and about one thing, with tests.
- Raise `VERSION` (see above).
- If you touch the installer or the updater, run `npm run test:shell`, and, if you have Docker, the
  container tests on at least one distribution:

  ```bash
  bash test/shell/install-in-container.sh debian12   # also ubuntu24, rocky9, fedora
  bash test/shell/update-in-container.sh debian12
  ```

  The CI runs both on all four distributions, plus `shellcheck` and the panel tests on Node 22.13 and 24.
- If you change a dependency, run `npm run vendor`: the CI checks that `public/vendor/` matches the
  lockfile.
