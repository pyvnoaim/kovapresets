# KovaPresets

Save your KovaaK's **crosshair, theme, sounds and sens** as presets and
switch between them with one click, or a global hotkey, without alt-tabbing out of
a run.

Windows only (KovaaK's is a Windows game). Free and open source.

> Unofficial community tool. Not affiliated with or endorsed by KovaaK's /
> FPSAimTrainer.

## Install

Paste this into PowerShell:

```powershell
irm pyvno.xyz/install.ps1 | iex
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

Beyond switching presets:

- **Global hotkeys** — bind a preset to a key combo that works while you're in game.
- **Live theme swapping** — select the bundled `!KovaPreset` theme in game once, and
  theme changes apply without restarting.
- **One-tap scenario re-enter** — reloads your current scenario through Steam so a
  change goes live immediately, optionally automatic after a hotkey apply.
- **HUD editor** — drag your in-game HUD windows on a virtual screen with snapping,
  alignment, even spacing and undo, instead of nudging them in game. Saved layouts
  apply immediately while KovaaK's is closed, or queue for its next quit.
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
| Crosshair, combat sounds | `weaponsettings.ini` |
| Theme, event sounds, sens, DPI | `PrimaryUserSettings.json` |
| Theme definitions | `Themes\<name>.json` |
| HUD window layout | `UI.json` |

Two of those reload at different times, which is why the table above lists
different "applies" moments. `weaponsettings.ini` is re-read whenever a scenario
loads. `PrimaryUserSettings.json` is only read when the game launches, but the
**selected theme's** definition file is re-read every time you open the in game
settings screen. KovaPresets uses that: it owns one proxy theme file called
`!KovaPreset`, and applying a preset rewrites it, so themes can swap live.

That scenario-entry reload does **not** cover sens, despite `weaponsettings.ini`
holding `OverrideSens`/`HorizontalSens`. Writing those externally has no effect
(verified by changing sens and crosshair in one write: on scenario entry the
crosshair changed and the sens did not). So sens presets go through the global
`XSens`/`YSens` and land on the next launch, alongside DPI.

Anything that can't go live yet is queued and written the moment the game quits,
so nothing is lost if you apply mid-session.

### On fair play

This tool only writes KovaaK's own cosmetic settings files. It sends **no
synthetic input**, does no memory access, no time scaling, and nothing that
affects scores or visibility of targets, in line with what the KovaaK's
developers allow for external tools. Scenario re-entry uses the official
`steam://` deep link, the same one that play links on the web use.

## Development

Patches welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules.

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
- `scripts/release.js` — the release driver (see below).

### Releasing

```bash
npm version patch                 # makes the "1.0.6" commit and the v1.0.6 tag
npm run release                    # push, create the release, build, upload, verify
npm run release -- --dry-run       # run every check and change nothing
```

Write `release-notes/<version>.md` first if you want written notes; otherwise
GitHub generates them from the commits. The app shows the release body in its
update prompt, so it's worth filling in.

`npm run release` deliberately creates the GitHub release **before** building.
electron-builder's publisher starts one uploader per artifact and each tries to
*create* the release, so the loser fails with `422 already_exists` and aborts the
publish — leaving a live release holding only some of its assets, with a
`latest.yml` still pointing at the previous version. That shipped a broken
auto-update twice (v1.0.4, v1.0.5, the former also ending up with two releases on
one tag). Creating it up front means the uploaders only ever upload, and the
script re-checks afterwards that the installer, blockmap and `latest.yml` all
actually landed. If an upload dies half way, `npm run release:publish-only`
retries just the build-and-upload against the existing release.

Requires the GitHub CLI, authenticated (`gh auth login`) — the script takes the
token from it and hands it to electron-builder. It pushes the commit and tag
before creating the release: publishing a non-draft release for a tag GitHub
doesn't have yet fails with "Published releases must have a valid tag". Once
`latest.yml` lands, installed copies pick the update up within a few hours.

## License

MIT, see [LICENSE](LICENSE).
