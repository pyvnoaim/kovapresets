# TODO

## Now: verify the stream overlay on Windows

Built on macOS, so the file logic is proven against a fake tree but never against
a real install. Check, in a browser tab before OBS (faster loop):

- [ ] **The FOV row appears.** It's the one field I couldn't confirm exists.
      `PRIMARY_MANAGED` deliberately doesn't carry FOV (adding it there would change
      what every preset captures and writes), so `overlay.js` scans the raw settings
      object for a key whose short name is `FOV`. If the row never shows, KovaaK's
      keeps FOV somewhere else and the scan needs pointing at it.
- [ ] Enemy body / head colours render (only when the in-game override is ticked).
- [ ] The mask-tinted crosshair looks right against a real PNG.
- [ ] A change made **in game** reaches the overlay, and roughly how fast. The open
      question is whether KovaaK's flushes per change or on closing the settings
      screen; the overlay can't be more live than that flush.
- [ ] Port 4713 is free on a normal machine (it falls back to an ephemeral port,
      which works but costs the user a re-copy).

Then: `release-notes/2.1.0.md`, `npm version minor`, `npm run release`.

## Next: KovaPresets -> KovaDesktop

It's already a multi-tool app - `core/kovaaks.js` is a shared file layer, and
presets / HUD / overlay are three tools on top of it with namespaced IPC
(`presets:` / `hud:` / `overlay:`). What's missing is chrome that admits it.

**Do not rebuild from scratch.** The asset in this repo is the verified file
semantics in `kovaaks.js`, not the code: that `OverrideSens` does nothing on the
scenario reload, that a `[weapon]` section shadows the global block, that the game
rewrites `PrimaryUserSettings.json` from launch-time memory, that the proxy theme
is the only live-swap route. Each of those is a day spent proving it in game. A
rebuild rediscovers them the hard way.

- [ ] `productName: 'KovaDesktop'`, and **keep `appId: app.kova.presets`**. It's the
      NSIS upgrade key, so keeping it is what makes installed copies update into the
      new name instead of stranding on a dead feed. The install folder and shortcut
      still move, so old copies can linger - this is a deliberate release with a
      note, not a quiet edit.
- [ ] Repo rename. GitHub redirects, but electron-builder's `publish.repo` has to be
      updated and the auto-updater's download URLs then rely on that redirect.
      **Test an update from an old install before shipping it**, don't assume.
- [ ] `install.ps1` at pyvno.xyz points at the new release asset name.
- [ ] Left nav in `index.html`. Views already toggle on `.hidden`, so this is a
      two-view toggle becoming an N-view one.
- [ ] Leave `renderer.js` (1.5k lines) alone until a tool's UI actually outgrows it.
      Split per tool when it hurts, not on principle.

Ship the rename + nav with the three tools that exist, as one release. Adding new
tools first is how the rename stalls.

## Then: new tools

- [ ] **Autoclipper.** Clip on PB via obs-websocket, with a threshold (percentile,
      playlist, rank achieved, or just every PB). Cheapest new tool here: watching
      the stats folder for a PB is the same `fs.watch` the overlay already runs, so
      obs-websocket is the only genuinely new piece.
- [ ] **Chat commands** (`!sens`, `!theme`, `!crosshair`, `!sounds`). Answers come
      straight off the snapshot the overlay already serves, so this is a Twitch
      connection rather than a feature. `!theme` handing out a download needs the
      asset URLs on kova's side, so it's a two-repo change.

## Loose ends

- [ ] Overlay: resolution comes from `GameUserSettings.ini` under `%LOCALAPPDATA%`,
      outside the watched folder, so it refreshes on the next change to anything else
      rather than immediately. Watch that folder too if it ever matters.
- [ ] Overlay: the crosshair is mask-tinted, which is exact for white/alpha PNGs but
      renders a self-coloured PNG as a flat silhouette. `renderer.js` already has a
      canvas multiply to swap in if anyone ships one.
- [ ] List KovaPresets on kova's `/projects` directory.
