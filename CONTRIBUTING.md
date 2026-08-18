# Contributing

Thanks for looking. This is a small app and it stays small on purpose.

## Setup

```bash
npm install
npm start          # run the app
npm run core:test  # smoke test of the file logic, no GUI, no writes
```

Node 22. Works on macOS/Linux for everything except actually driving the game:
`npm run core:test` skips the live checks when there's no KovaaK's install, and
`src/core/kovaaks.js` is plain Node so it can be reasoned about anywhere. Any
change that touches how the game reads a file has to be tried on Windows with
KovaaK's installed before it ships.

## Ground rules

- **No build step, no framework.** The renderer is plain HTML/CSS/JS served
  straight from `src/renderer/`. Keep it that way.
- **No new dependencies** without saying why in the PR. The app ships with one
  runtime dependency and that is a feature.
- **All filesystem and game access lives in main.** `src/preload.js` is the whole
  renderer→main surface; the renderer never touches `fs` or `child_process`.
- **Writes go through `src/core/fsatomic.js`.** The game re-reads these files at
  moments we don't control, so a torn write is a real bug, not a theoretical one.
- **Don't guess at game behaviour, verify it.** The comments in `kovaaks.js`
  record what was tested in game (which files reload when, what the game ignores).
  If you find one of them is wrong, fix the comment in the same PR.
- **Adding a theme field?** Add one row to `THEME_FIELDS` in `kovaaks.js` and both
  directions (theme file → preset, preset → proxy theme file) come free. The
  round-trip check in `selftest.js` fails if a row only maps one way.

## Style

Two-space indent, single quotes, no semicolons — match the file you're in.
`.editorconfig` covers the mechanical part.

`npm run lint` is ESLint's recommended set, split by environment: main and core
get Node globals, the renderer gets browser globals only. That split is the
point — it's what catches a `require` that wandered into the renderer, where it
would be undefined at runtime. There's no formatter, so lint failures are real
findings, not style noise.

`renderer.js` and `hud.js` are two `<script>` tags sharing one global scope, so
the handful of names that cross between them are listed in `eslint.config.js`.
Add a name there if you introduce another one.

## Pull requests

- Branch off `main`, one topic per PR.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`, `feat!:` for
  breaking).
- CI runs `npm run core:test` on Linux and Windows; it has to be green.
- Say what you tested, and whether you tested it against a real KovaaK's install.

## Layout

| Path | What |
|---|---|
| `src/core/kovaaks.js` | Pure Node file logic: detect / read / diff / apply |
| `src/core/presets.js` | The local preset store |
| `src/core/fsatomic.js` | Atomic writes |
| `src/main.js` | Electron main, owns filesystem and game access |
| `src/preload.js` | The entire renderer↔main IPC surface |
| `src/renderer/` | The UI |
| `scripts/release.js` | Release driver — see README |

`TODO.md` is the roadmap; the README explains how releases work and why the
release script does things in the order it does.
