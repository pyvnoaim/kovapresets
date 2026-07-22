# KovaPresets

Save your KovaaK's **crosshair, theme, sounds, sens and HUD layout** as presets and
switch between them with one click, or a global hotkey, without alt-tabbing out of
a run.

Windows only (KovaaK's is a Windows game). Free and open source.

> Unofficial community tool. Not affiliated with or endorsed by KovaaK's /
> FPSAimTrainer.

## Install

Paste this into PowerShell:

```powershell
irm https://pyvno.xyz/install.ps1 | iex
```

That grabs the newest release and runs it. No admin rights needed, KovaPresets
installs for your user only, and it finds your KovaaK's install through Steam by
itself. From then on the app updates itself, so you only ever run this once.

Prefer clicking? Download the **KovaPresets Setup exe** from the
[releases page](https://github.com/pyvnoaim/kovapresets/releases/latest) instead.
Windows SmartScreen will warn you the first time you run a downloaded copy,
because the installer isn't code-signed yet, click **More info → Run anyway**.

## What it does

A preset is a snapshot of how your game looks and sounds. Applying one rewrites
only the matching keys in KovaaK's own settings files, leaving everything else
untouched.

| What a preset holds | Applies |
|---|---|
| Crosshair (file, color, scale) | On your next scenario load |
| Hit / kill sounds | On your next scenario load |
| Scenario sens override + DPI | Sens on scenario load, DPI on next launch |
| Theme (walls, floor, sky, enemy colors) | Live, once you open the game's settings screen |
| HUD window layout, palette | When the game next starts or quits |

Beyond switching presets:

- **Global hotkeys** — bind a preset to a key combo that works while you're in game.
- **Live theme swapping** — select the bundled `!KovaPreset` theme in game once, and
  theme changes apply without restarting.
- **One-tap scenario re-enter** — reloads your current scenario through Steam so a
  change goes live immediately, optionally automatic after a hotkey apply.
- **HUD editor** — drag your in-game HUD windows on a virtual screen with snapping,
  alignment, even spacing and undo, instead of nudging them in game.
- **Import / export** — share a preset as a `.kovapreset.json` file.
- **Restore original setup** — puts every setting back to how it was before
  KovaPresets ever touched it.
- **Tray resident** — closing the window keeps hotkeys alive in the tray, and it can
  start with Windows.

## How it works

KovaaK's keeps its settings as plain text under
`<SteamLibrary>\steamapps\common\FPSAimTrainer\FPSAimTrainer\Saved\SaveGames\`.
KovaPresets reads and writes those same files, nothing more:

| What | File |
|---|---|
| Crosshair, combat sounds, per-scenario sens | `weaponsettings.ini` |
| Theme, event sounds, global sens, DPI | `PrimaryUserSettings.json` |
| Theme definitions | `Themes\<name>.json` |
| HUD window layout | `UI.json` |

Two of those reload at different times, which is why the table above lists
different "applies" moments. `weaponsettings.ini` is re-read whenever a scenario
loads. `PrimaryUserSettings.json` is only read when the game launches, but the
**selected theme's** definition file is re-read every time you open the in game
settings screen. KovaPresets uses that: it owns one proxy theme file called
`!KovaPreset`, and applying a preset rewrites it, so themes can swap live.

Anything that can't go live yet is queued and written the moment the game quits,
so nothing is lost if you apply mid-session.

### On fair play

This tool only writes KovaaK's own cosmetic settings files. It sends **no
synthetic input**, does no memory access, no time scaling, and nothing that
affects scores or visibility of targets, in line with what the KovaaK's
developers allow for external tools. Scenario re-entry uses the official
`steam://` deep link, the same one that play links on the web use.

## Development

```bash
npm install
npm start          # run the app
npm run core:test  # read-only smoke test of the file logic, no GUI
npm run dist       # build the Windows installer into dist/
```

- `src/core/kovaaks.js` — pure Node file logic (detect / read / diff / apply), no Electron.
- `src/core/presets.js` — the local preset store.
- `src/main.js` — Electron main; owns all filesystem and game access.
- `src/preload.js` — the entire renderer to main IPC surface.
- `src/renderer/*` — the UI, plain HTML/CSS/JS with no build step.

Releasing: bump `version` in `package.json`, then `npm run release` with a
`GH_TOKEN` in your environment. That builds the installer, publishes it to GitHub
Releases along with the `latest.yml` manifest, and every installed copy picks the
update up within a few hours.

## License

MIT, see [LICENSE](LICENSE).
