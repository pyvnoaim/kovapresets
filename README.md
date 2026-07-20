# KovaPreset (desktop)

Switch KovaaK's **theme / crosshair / sound** presets from one window, live while
the game is open. Electron app, separate from the Kova web project (like `bot/`).

## Run

```bash
cd desktop
npm install
npm start          # launch the app
npm run core:test  # read-only smoke test of the KovaaK's file logic (no GUI)
```

## How it works

KovaaK's stores the active look/feel as plain text under
`<SteamLibrary>\steamapps\common\FPSAimTrainer\FPSAimTrainer\Saved\SaveGames\`:

| What | File | Keys |
|---|---|---|
| Crosshair + combat sounds | `weaponsettings.ini` | `CrosshairFile`, `CrosshairColor`, `CrosshairScale`, `BodyHitSound`, `HeadHitSound`, `ShootSound` |
| Theme + event sounds | `PrimaryUserSettings.json` | `CurrentThemeName`, `KillConfirmedSound`, `SpawnSound`, `MBS*Sound` |

A **preset** is just a saved snapshot of those values. Applying one rewrites only
those keys (BOM + CRLF + everything else preserved). KovaaK's **re-reads
`weaponsettings.ini` on scenario entry**, so crosshair/sound swaps go live if you
re-enter the scenario. The game rewrites these files on exit and when you change a
setting in-game, so while a preset is applied, don't edit those settings inside
KovaaK's or it'll clobber the file.

Install auto-detection reads the Steam path from the registry and parses
`libraryfolders.vdf`, so a game on any drive is found.

## Layout

- `src/core/kovaaks.js` — pure-Node file logic (detect / read / diff / apply). Unit-testable.
- `src/core/presets.js` — local JSON preset store (`userData/presets.json`).
- `src/main.js` — Electron main; owns all fs/game access, exposes IPC.
- `src/preload.js` — `contextBridge` IPC surface.
- `src/renderer/*` — the UI (no build step; plain HTML/CSS/JS).

## Roadmap

- v1 (now): capture current setup → save presets → click to apply → live re-read.
- v2: sync presets from your Kova account (pull uploaded crosshair/sound/theme
  assets, bundle referenced files into the game folders on apply).
- later: one-tap "re-enter scenario" so applying is fully hands-off.
