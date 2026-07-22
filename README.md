# KovaPresets (desktop)

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

## Beyond presets

- **One-tap scenario re-enter**: after an apply while the game runs, the toast
  offers "Re-enter now" - it relaunches your last-played scenario (name read
  from the newest file in the game's `stats/` folder) via the official
  `steam://…jump-to-scenario` deep link, the same one play links on the web
  use. Only a full scenario load makes KovaaK's re-read `weaponsettings.ini` -
  the in-game Reset Session bind just resets the timer, so key-pressing is
  useless (and synthetic input sits badly with KovaaK's external-tool policy;
  the app sends none). The checkbox under the preset list turns on **auto
  re-enter after hotkey applies**.
- **Tray**: closing the window hides to the tray so global hotkeys keep working.
  Right-click the tray icon to apply any preset or quit; left-click reopens.
- **Import/export**: the share button on a preset row exports it to a
  `.kovapreset.json` file (hotkey stripped); "Import" above the list merges a
  shared file in.
- **Launch**: a topbar button starts KovaaK's via `steam://rungameid/824270`
  when it's closed.

## Layout

- `src/core/kovaaks.js` - pure-Node file logic (detect / read / diff / apply). Unit-testable.
- `src/core/presets.js` - local JSON preset store (`userData/presets.json`).
- `src/main.js` - Electron main; owns all fs/game access, exposes IPC.
- `src/preload.js` - `contextBridge` IPC surface.
- `src/renderer/*` - the UI (no build step; plain HTML/CSS/JS).

## Roadmap

- v1 (now): capture current setup → save presets → click to apply → live re-read,
  plus tray quick-apply, preset import/export, and one-tap / auto scenario re-enter.
- v2: sync presets from your Kova account (pull uploaded crosshair/sound/theme
  assets, bundle referenced files into the game folders on apply).
- later: package as an installer (electron-builder) with auto-update.
