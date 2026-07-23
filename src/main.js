// Electron main process. Owns all filesystem/game access; the renderer talks to
// it only through the IPC surface in preload.js. Core logic is in core/kovaaks.js.
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  shell,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const k = require('./core/kovaaks')
const store = require('./core/presets')

const STEAM_APP_ID = '824270' // KovaaK's

// One instance only: a second `npm start` focuses the existing window instead
// of silently stacking another copy in the tray (the X hides to tray, so
// "close then start again" would otherwise pile up instances).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

let win = null
let tray = null
let quitting = false

// ---- hot-path caches ------------------------------------------------------------
// The renderer polls `state` every 5s; without these that meant a synchronous
// tasklist spawn (blocks the main process), a Steam-library re-scan, and a
// re-read of ~55 theme JSONs per tick.
let installCache = null // a found install doesn't move while the app runs
function findInstall(rescan) {
  if (rescan) installCache = null
  if (!installCache) installCache = k.findInstall()
  return installCache
}

// game-running is polled ASYNC on a timer; readers get the cached answer
// synchronously, so apply/flush logic stays sync and nothing blocks on spawns.
// Worst case the answer is ~3s stale, which every consumer tolerates (a late
// flush waits one 4s tick; an apply mid-transition queues and gets flushed).
let gameRunningCache = k.isGameRunning()
const gameRunning = () => gameRunningCache
function pollGameRunning() {
  execFile(
    'tasklist',
    ['/FI', 'IMAGENAME eq FPSAimTrainer.exe', '/NH'],
    { windowsHide: true },
    (err, out) => {
      gameRunningCache = !err && /FPSAimTrainer\.exe/i.test(String(out))
    }
  )
}

let optionsCache = null // { install, at, value }
const OPTIONS_TTL_MS = 30_000
function listOptionsCached(install, rescan) {
  if (rescan || !optionsCache || optionsCache.install !== install || Date.now() - optionsCache.at > OPTIONS_TTL_MS)
    optionsCache = { install, at: Date.now(), value: k.listOptions(install) }
  return optionsCache.value
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#111114',
    title: 'KovaPresets',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    // started as a login item: boot straight into the tray, no window flash
    show: !process.argv.includes('--hidden'),
    // Riot-client-style chrome: fully frameless, the app's own topbar is the
    // drag region and renders its own caption buttons (the Windows overlay
    // buttons drew oversized/missing hover states at this bar height).
    // minimize + close only - no maximize, incl. via titlebar double-click.
    frame: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.removeMenu()
  // The preload bridge is attached to the WINDOW, not the page, so anything
  // that loads here inherits it. The app has no in-app links or popups, so
  // pinning the window to index.html costs nothing and means one escaping slip
  // in a game-supplied string (crosshair/theme/scenario names) can't reach it.
  // External links go through shell.openExternal, which these don't affect.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Same-URL navigation is Ctrl+R/F5 (the renderer calls location.reload(),
  // which is renderer-initiated and does reach this event) - anything else is
  // the page trying to leave index.html, which nothing here legitimately does.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // Close hides to the tray so global hotkeys keep working; quit via the tray menu.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    const s = loadSettings()
    if (!s.trayTipShown && tray) {
      tray.displayBalloon({
        title: 'KovaPresets is still running',
        content: 'Hotkeys stay active. Right-click the tray icon to apply presets or quit.',
      })
      saveSettings({ ...s, trayTipShown: true })
    }
  })
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow()
  else {
    win.show()
    win.focus()
  }
}

function requireInstall() {
  const install = findInstall()
  if (!install) throw new Error("KovaaK's install not found. Is it installed via Steam?")
  return install
}

const userData = () => app.getPath('userData')
const pendingFile = () => path.join(userData(), 'pending.json')

// ---- app settings (small flags, not presets) -----------------------------------
const SETTINGS_DEFAULTS = { autoRestart: false, trayTipShown: false, launchOnStartup: false }
const settingsFile = () => path.join(userData(), 'settings.json')
function loadSettings() {
  try {
    return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
}

// ---- scenario re-enter ----------------------------------------------------------
// Relaunches the current scenario via the same steam:// jump-to-scenario deep
// link the kova website's snipe button uses. Only a full scenario load re-reads
// weaponsettings.ini - the in-game ResetSession bind just resets the timer
// (verified: pressing it leaves the old crosshair), so keypressing is useless.
// "Current scenario" = newest stats CSV, written every time a run ends.
//
// Jumping to the scenario the player is ALREADY IN doesn't reload it (verified
// in-game), and that's the main case - so we park in the previous scenario
// first, then jump back. The second jump is a real scenario change = full load.
const REENTER_HOP_MS = 2500
const scenarioLink = (name, challenge) =>
  `steam://run/${STEAM_APP_ID}/?action=jump-to-scenario;name=${encodeURIComponent(name)}${challenge ? ';mode=challenge' : ''}`

async function doRestartScenario() {
  if (!gameRunning()) return { ok: false, error: "KovaaK's isn't running." }
  const install = findInstall()
  const [scenario, parking] = install ? k.recentScenariosFromStats(install) : []
  if (!scenario)
    return { ok: false, error: 'No finished run found yet - re-enter the scenario by hand.' }
  // mode=challenge on the final jump so the next run counts on the leaderboard.
  // It also starts the run instantly - the URI API has no "challenge but idle"
  // option, so the player presses their own reset bind when ready (a reset or
  // abandoned run costs nothing, boards keep the best score).
  if (parking) {
    shell.openExternal(scenarioLink(parking, false))
    setTimeout(() => shell.openExternal(scenarioLink(scenario, true)), REENTER_HOP_MS)
  } else {
    // only one scenario in the whole history: a direct jump reloads nothing if
    // the player is already in it, but it's all we have
    shell.openExternal(scenarioLink(scenario, true))
  }
  return { ok: true, scenario, hopped: !!parking }
}

// ---- pending (game-owned files queued while the game runs) --------------------
function setPending(pending) {
  fs.writeFileSync(pendingFile(), JSON.stringify(pending))
}
function readPending() {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))
  } catch {
    return null
  }
}
function clearPending() {
  try {
    fs.unlinkSync(pendingFile())
  } catch {}
}

// Runs on a bare 4s interval, so it must never throw: applyWeapon/applyPrimary
// read the settings files unguarded, and a Steam "verify files" or a moved
// library makes them vanish mid-session. Swallow and retry next tick - pending
// stays on disk, so nothing is lost.
function flushPendingIfPossible() {
  try {
    return flushPending()
  } catch {
    return false
  }
}

function flushPending() {
  const pending = readPending()
  if (!pending) return false
  if (gameRunning()) return false
  const install = findInstall()
  if (!install) return false
  if (pending.primaryRaw != null)
    // undo restore: put the exact captured file back
    fs.writeFileSync(
      path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
      pending.primaryRaw
    )
  else if (pending.primary) k.applyPrimary(install, pending.primary)
  if (pending.palette != null) k.applyPalette(install, pending.palette)
  if (pending.ui != null) k.applyUi(install, pending.ui)
  // re-assert the weapon intent the game's exit-write may have reverted
  if (pending.weaponRaw != null)
    fs.writeFileSync(path.join(install, 'Saved', 'SaveGames', 'weaponsettings.ini'), pending.weaponRaw)
  else if (pending.weapon) k.applyWeapon(install, pending.weapon)
  clearPending()
  if (win && !win.isDestroyed()) win.webContents.send('changed')
  return true
}

// ---- baseline: the user's own setup, captured before the first apply -----------
// One snapshot, taken only when none exists, so "Restore original setup" always
// returns to the state before KovaPresets touched anything - not one step back
// like the old per-apply undo. Cleared on restore; the next apply recaptures.
const baselineDir = () => path.join(userData(), 'baseline')
const hasBaseline = () => fs.existsSync(path.join(baselineDir(), 'weapon.bak'))

function captureBaselineIfMissing(install) {
  if (hasBaseline()) return
  const p = {
    weapon: path.join(install, 'Saved', 'SaveGames', 'weaponsettings.ini'),
    primary: path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
    proxy: path.join(install, 'Saved', 'SaveGames', 'Themes', `${k.PROXY_THEME}.json`),
  }
  const dir = baselineDir()
  fs.mkdirSync(dir, { recursive: true })
  const active = k.readActive(install)
  for (const [name, file] of Object.entries(p))
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `${name}.bak`))
  if (active.palette != null) fs.writeFileSync(path.join(dir, 'palette.bak'), active.palette)
  if (active.ui != null) fs.writeFileSync(path.join(dir, 'ui.bak'), active.ui)
}

function deactivatePresets() {
  if (!hasBaseline()) return { ok: false, error: 'Nothing to restore.' }
  const dir = baselineDir()
  const install = requireInstall()
  const running = gameRunning()
  const read = (n) => {
    const f = path.join(dir, n)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
  }
  // weapon + proxy theme are safe to write any time
  const weapon = read('weapon.bak')
  if (weapon != null)
    fs.writeFileSync(path.join(install, 'Saved', 'SaveGames', 'weaponsettings.ini'), weapon)
  const proxy = read('proxy.bak')
  if (proxy != null)
    fs.writeFileSync(
      path.join(install, 'Saved', 'SaveGames', 'Themes', `${k.PROXY_THEME}.json`),
      proxy
    )
  // game-owned files follow the closed-game rule
  const primaryRaw = read('primary.bak')
  const palette = read('palette.bak')
  const ui = read('ui.bak')
  let queued = false
  if (running) {
    // A restore supersedes EVERYTHING queued - start from an empty pending, or
    // a leftover preset intent with no baseline counterpart (e.g. a queued
    // palette when no palette file existed at capture) would re-apply part of
    // the preset after the restore, on game quit.
    const pending = {}
    if (weapon != null) pending.weaponRaw = weapon
    if (primaryRaw != null) pending.primaryRaw = primaryRaw
    if (palette != null) pending.palette = palette
    if (ui != null) pending.ui = ui
    setPending(pending)
    queued = primaryRaw != null || palette != null || ui != null
  } else {
    clearPending() // same reasoning - drop any not-yet-flushed preset intents
    if (primaryRaw != null)
      fs.writeFileSync(
        path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
        primaryRaw
      )
    if (palette != null) k.applyPalette(install, palette)
    if (ui != null) k.applyUi(install, ui)
  }
  fs.rmSync(dir, { recursive: true, force: true }) // restored - next apply recaptures
  return { ok: true, queued }
}

// ---- preset apply (shared by IPC and hotkeys) ---------------------------------
function doApplyPreset(preset) {
  const install = requireInstall()
  const running = gameRunning()
  captureBaselineIfMissing(install)
  const weaponChanged = k.applyWeapon(install, preset.weapon)

  const active = k.readActive(install)
  let primaryWant = null
  if (k.primaryDiffers(install, preset.primary)) {
    k.writeProxyTheme(install, preset.primary)
    primaryWant = JSON.parse(JSON.stringify(preset.primary))
    if (!primaryWant.stringSettings) primaryWant.stringSettings = {}
    primaryWant.stringSettings.CurrentThemeName = k.PROXY_THEME
  }
  const wants = {
    primary: primaryWant,
    palette: preset.palette != null && preset.palette !== active.palette ? preset.palette : null,
    ui: preset.ui != null && preset.ui !== active.ui ? preset.ui : null,
  }

  let theme = 'nochange'
  if (running) {
    // The game rewrites weaponsettings.ini from memory on exit, so an apply it
    // never re-read (no scenario re-entry) gets reverted at quit. Queue the
    // intent; the quit flush re-asserts it.
    //
    // REPLACE the queue, don't merge into it: a preset is a total intent, and a
    // field this preset leaves alone (wants.X null because the disk already
    // matches) would otherwise keep the PREVIOUS preset's queued value and land
    // that on game quit - e.g. apply a dark preset, then a light one whose theme
    // equals the on-disk one, and the dark theme still applies at quit.
    //
    // The exception is a field the preset carries NOTHING for: it has no
    // opinion, so whatever else queued it stands - e.g. a HUD layout saved from
    // the editor mid-session, then a preset with no `ui` applied on top.
    const prev = readPending() || {}
    const next = { weapon: preset.weapon, ...wants }
    if (preset.palette == null && prev.palette != null) next.palette = prev.palette
    if (preset.ui == null && prev.ui != null) next.ui = prev.ui
    setPending(next)
    if (wants.primary) theme = k.proxyThemeSelected(install) ? 'live' : 'arming'
    else if (wants.palette != null || wants.ui != null) theme = 'queued'
  } else if (wants.primary || wants.palette != null || wants.ui != null) {
    if (wants.primary) k.applyPrimary(install, wants.primary)
    if (wants.palette != null) k.applyPalette(install, wants.palette)
    if (wants.ui != null) k.applyUi(install, wants.ui)
    clearPending()
    theme = 'applied'
  }
  return { weaponChanged, theme, running }
}

// ---- global hotkeys -----------------------------------------------------------
function registerHotkeys() {
  globalShortcut.unregisterAll()
  const presets = store.load(userData())
  for (const preset of presets) {
    if (!preset.hotkey) continue
    try {
      globalShortcut.register(preset.hotkey, async () => {
        try {
          // Re-read by id instead of closing over the loaded object: only
          // delete/setHotkey re-register, so editing a preset (build/update/
          // updateWeapon/rename) would otherwise leave the hotkey applying the
          // preset as it looked when hotkeys were last registered.
          const fresh = store.load(userData()).find((x) => x.id === preset.id)
          if (!fresh) return
          const result = doApplyPreset(fresh)
          // hotkey applies happen while playing, so the game already has focus -
          // the auto re-enter is just a keypress away from being fully hands-off
          let restarted = false
          if (loadSettings().autoRestart && result.running && result.weaponChanged)
            restarted = (await doRestartScenario()).ok
          if (win && !win.isDestroyed())
            win.webContents.send('hotkey-applied', { name: fresh.name, ...result, restarted })
        } catch {
          // install missing mid-session - nothing sane to do from a hotkey
        }
      })
    } catch {
      // invalid accelerator string - ignore, the UI validates on record
    }
  }
}

// ---- presets migration (v1 flat shape -> nested) ------------------------------
function loadPresetsMigrated(install) {
  const presets = store.load(userData())
  let changed = false
  for (const p of presets) {
    if (!p.primary || p.primary.stringSettings) continue
    const flat = p.primary
    const base = JSON.parse(JSON.stringify(k.readActive(install).primary))
    const fromTheme = flat.CurrentThemeName ? k.primaryFromTheme(install, flat.CurrentThemeName) : null
    if (fromTheme)
      for (const [section, fields] of Object.entries(fromTheme)) {
        if (!base[section]) base[section] = {}
        Object.assign(base[section], fields)
      }
    for (const key of [
      'CurrentThemeName',
      'KillConfirmedSound',
      'SpawnSound',
      'MBSGoodSound',
      'MBSOkaySound',
      'MBSBadSound',
      'MBSChangeNowSound',
    ])
      if (flat[key] !== undefined) base.stringSettings[key] = flat[key]
    p.primary = base
    changed = true
  }
  if (changed) store.save(userData(), presets)
  return presets
}

// ---- tray -----------------------------------------------------------------------
// The menu is built fresh on every right-click (there's no "before show" hook on
// Windows), so it always reflects the current preset list.
function trayMenu() {
  const presets = store.load(userData())
  const items = presets.slice(0, 12).map((p) => ({
    label: p.hotkey ? `${p.name}  (${p.hotkey})` : p.name,
    click: async () => {
      try {
        const result = doApplyPreset(p)
        let restarted = false
        if (loadSettings().autoRestart && result.running && result.weaponChanged)
          restarted = (await doRestartScenario()).ok
        if (win && !win.isDestroyed())
          win.webContents.send('hotkey-applied', { name: p.name, ...result, restarted })
      } catch {
        // install missing - the window surfaces this, a tray click can't
      }
    },
  }))
  return Menu.buildFromTemplate([
    ...(items.length ? items : [{ label: 'No presets yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Open KovaPresets', click: showWindow },
    { label: 'Quit', click: () => app.quit() },
  ])
}

function createTray() {
  // the website's favicon (multi-frame .ico) - Windows picks the right size itself
  tray = new Tray(path.join(__dirname, 'assets', 'tray.ico'))
  tray.setToolTip('KovaPresets')
  tray.on('click', showWindow)
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()))
}

// ---- IPC ----------------------------------------------------------------------
// Applies made while the game runs sit in pending.json until the game quits,
// so the files still hold the old values. Merge the queued intent into the
// reported state or the UI forgets what was applied (worst after an app
// restart, when nothing else hints at it). Capture/build read through this
// too, so they snapshot what the user SEES as active, not stale disk state.
function readActiveMerged(install) {
  const active = k.readActive(install)
  const pending = readPending()
  if (pending) {
    if (pending.primary && active.primary)
      for (const [section, fields] of Object.entries(pending.primary))
        active.primary[section] = { ...(active.primary[section] || {}), ...fields }
    if (pending.palette != null) active.palette = pending.palette
    if (pending.ui != null) active.ui = pending.ui
    if (pending.weapon) active.weapon = { ...active.weapon, ...pending.weapon }
  }
  return { active, pending: !!pending }
}

ipcMain.handle('state', (_e, opts) => {
  const install = findInstall(opts?.rescan)
  if (!install) return { install: null }
  const { active, pending } = readActiveMerged(install)
  return {
    install,
    gameRunning: gameRunning(),
    active,
    // What the proxy theme file actually holds - the renderer matches theme
    // identity against this while the game is on the proxy, because the game
    // rewrites PrimaryUserSettings.json from launch-time memory and its theme
    // fields go stale the moment a preset is applied live.
    proxyPrimary: k.readProxyPrimary(install),
    updateReady,
    options: listOptionsCached(install, opts?.rescan),
    presets: loadPresetsMigrated(install),
    pending: !!pending,
    resolution: k.readResolution(),
    canRestore: hasBaseline(),
  }
})

ipcMain.handle('presets:capture', (_e, name) => {
  const install = requireInstall()
  const presets = store.load(userData())
  presets.push({ id: store.newId(), name: name || 'New preset', ...readActiveMerged(install).active })
  store.save(userData(), presets)
  return presets
})

// Theme files carry material STRINGS but not the WallMat/FloorMat INDEX
// fields, so overlaying a theme pick would leave the previous theme's indices
// riding along and fighting the new materials on the launch path. Drop them -
// the game re-derives and rewrites them itself when it loads the theme.
function dropStaleMaterialIndices(primary) {
  if (!primary.integerSettings) return
  delete primary.integerSettings.WallMat
  delete primary.integerSettings.FloorMat
}

ipcMain.handle('presets:build', (_e, picks) => {
  const install = requireInstall()
  const { active } = readActiveMerged(install)
  const weapon = { ...active.weapon }
  if (picks.crosshair) weapon.CrosshairFile = picks.crosshair
  if (picks.crosshairScale > 0) weapon.CrosshairScale = String(picks.crosshairScale)
  if (picks.crosshairColor) weapon.CrosshairColor = picks.crosshairColor
  if (picks.bodyHit != null) weapon.BodyHitSound = picks.bodyHit
  const sens = Number(picks.sens)
  if (picks.sens != null && Number.isFinite(sens) && sens > 0) {
    // scenario sens override: lives in weaponsettings.ini, so it goes live on
    // scenario entry; the scale stays whatever the player already uses
    weapon.OverrideSens = 'true'
    weapon.HorizontalSens = String(sens)
    weapon.VerticalSens = String(sens)
  }

  const primary = JSON.parse(JSON.stringify(active.primary))
  if (picks.theme) {
    const fromTheme = k.primaryFromTheme(install, picks.theme)
    if (fromTheme) {
      for (const [section, fields] of Object.entries(fromTheme)) {
        if (!primary[section]) primary[section] = {}
        Object.assign(primary[section], fields)
      }
      dropStaleMaterialIndices(primary)
    }
  }
  if (picks.killSound != null) {
    if (!primary.stringSettings) primary.stringSettings = {}
    primary.stringSettings.KillConfirmedSound = picks.killSound
  }
  const dpi = Number(picks.dpi)
  if (picks.dpi != null && Number.isFinite(dpi) && dpi > 0) {
    if (!primary.integerSettings) primary.integerSettings = {}
    primary.integerSettings.DPI = Math.round(dpi)
  }

  const presets = store.load(userData())
  presets.push({
    id: store.newId(),
    name: picks.name || 'New preset',
    weapon,
    primary,
    palette: active.palette,
    ui: active.ui,
  })
  store.save(userData(), presets)
  return presets
})

// Edit an existing preset: same picks shape as presets:build, but applied on
// top of the preset's own data (empty pick = keep). Palette/HUD stay untouched.
ipcMain.handle('presets:update', (_e, id, picks) => {
  const install = requireInstall()
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (!p) return presets
  if (picks.name) p.name = String(picks.name).slice(0, 80)
  p.weapon = p.weapon || {}
  if (picks.crosshair) p.weapon.CrosshairFile = picks.crosshair
  if (picks.crosshairScale > 0) p.weapon.CrosshairScale = String(picks.crosshairScale)
  if (picks.crosshairColor) p.weapon.CrosshairColor = picks.crosshairColor
  if (picks.bodyHit != null) p.weapon.BodyHitSound = picks.bodyHit
  const sens = Number(picks.sens)
  if (picks.sens != null && Number.isFinite(sens) && sens > 0) {
    p.weapon.OverrideSens = 'true'
    p.weapon.HorizontalSens = String(sens)
    p.weapon.VerticalSens = String(sens)
  }
  p.primary = p.primary || {}
  if (picks.theme) {
    const fromTheme = k.primaryFromTheme(install, picks.theme)
    if (fromTheme) {
      for (const [section, fields] of Object.entries(fromTheme)) {
        if (!p.primary[section]) p.primary[section] = {}
        Object.assign(p.primary[section], fields)
      }
      dropStaleMaterialIndices(p.primary)
    }
  }
  if (picks.killSound != null) {
    if (!p.primary.stringSettings) p.primary.stringSettings = {}
    p.primary.stringSettings.KillConfirmedSound = picks.killSound
  }
  const dpi = Number(picks.dpi)
  if (picks.dpi != null && Number.isFinite(dpi) && dpi > 0) {
    if (!p.primary.integerSettings) p.primary.integerSettings = {}
    p.primary.integerSettings.DPI = Math.round(dpi)
  }
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:delete', (_e, id) => {
  const presets = store.load(userData()).filter((p) => p.id !== id)
  store.save(userData(), presets)
  registerHotkeys()
  return presets
})

ipcMain.handle('presets:rename', (_e, id, name) => {
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (p) p.name = name
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:updateWeapon', (_e, id, patch) => {
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (p) p.weapon = { ...p.weapon, ...patch }
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:duplicate', (_e, id) => {
  const presets = store.load(userData())
  const i = presets.findIndex((x) => x.id === id)
  if (i >= 0) {
    const copy = JSON.parse(JSON.stringify(presets[i]))
    copy.id = store.newId()
    copy.name = `${copy.name} copy`
    delete copy.hotkey // hotkeys stay unique to the original
    presets.splice(i + 1, 0, copy)
    store.save(userData(), presets)
  }
  return presets
})

ipcMain.handle('presets:reorder', (_e, orderedIds) => {
  const presets = store.load(userData())
  presets.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id))
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:setHotkey', (_e, id, hotkey) => {
  const presets = store.load(userData())
  for (const p of presets) {
    if (p.id === id) p.hotkey = hotkey || undefined
    else if (hotkey && p.hotkey === hotkey) p.hotkey = undefined // steal = move
  }
  store.save(userData(), presets)
  registerHotkeys()
  return presets
})

// By id, not by object: what gets written to the game's files is whatever the
// store holds, so the renderer can't define it. Same lookup the hotkey path
// does, so both apply exactly the same thing.
ipcMain.handle('preset:apply', (_e, id) => {
  const preset = store.load(userData()).find((p) => p.id === id)
  if (!preset) throw new Error('That preset no longer exists.')
  return doApplyPreset(preset)
})

ipcMain.handle('presets:deactivate', () => deactivatePresets())

ipcMain.handle('game:restart', () => doRestartScenario())

ipcMain.handle('game:launch', () => {
  shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
  return { ok: true }
})

ipcMain.handle('win:minimize', () => win?.minimize())
ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools())
ipcMain.handle('win:close', () => win?.close()) // routes through close-to-tray

ipcMain.handle('settings:get', () => loadSettings())

ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch }
  saveSettings(s)
  // registering the dev electron.exe as a login item would be nonsense - the
  // setting still saves, and takes effect from an installed build
  if ('launchOnStartup' in patch && app.isPackaged)
    app.setLoginItemSettings({
      openAtLogin: !!s.launchOnStartup,
      args: ['--hidden'], // boot into the tray, not a window on the desktop
    })
  return s
})

// ---- preset import/export (share a preset as a JSON file) ----------------------
ipcMain.handle('presets:export', async (_e, id) => {
  const presets = store.load(userData())
  const chosen = id ? presets.filter((p) => p.id === id) : presets
  if (!chosen.length) return { ok: false, error: 'Nothing to export.' }
  const base = id ? (chosen[0].name || 'preset').replace(/[<>:"/\\|?*]+/g, '').trim() : 'kova-presets'
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${base || 'preset'}.kovapreset.json`,
    filters: [{ name: 'KovaPreset', extensions: ['json'] }],
  })
  if (canceled || !filePath) return { ok: false, canceled: true }
  // ids are local, hotkeys are personal - neither belongs in a shared file
  const out = chosen.map(({ id: _id, hotkey: _hk, ...rest }) => rest)
  fs.writeFileSync(filePath, JSON.stringify({ kovapreset: 1, presets: out }, null, 2))
  return { ok: true, count: out.length }
})

ipcMain.handle('presets:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'KovaPreset', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return { ok: false, canceled: true }
  let data
  try {
    data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
  } catch {
    return { ok: false, error: "That file isn't valid JSON." }
  }
  const incoming = Array.isArray(data?.presets) ? data.presets : Array.isArray(data) ? data : null
  if (!incoming) return { ok: false, error: "That file doesn't look like a KovaPreset export." }
  const presets = store.load(userData())
  let count = 0
  for (const p of incoming) {
    if (!p || typeof p !== 'object' || (!p.weapon && !p.primary)) continue
    presets.push({
      id: store.newId(),
      name: String(p.name || 'Imported preset').slice(0, 80),
      weapon: p.weapon && typeof p.weapon === 'object' ? p.weapon : {},
      primary: p.primary && typeof p.primary === 'object' ? p.primary : {},
      palette: store.validPalette(p.palette) ? p.palette : null,
      ui: store.validUi(p.ui) ? p.ui : null,
    })
    count++
  }
  if (!count) return { ok: false, error: 'No presets found in that file.' }
  store.save(userData(), presets)
  return { ok: true, count, presets }
})

ipcMain.handle('hud:save', (_e, uiRaw) => {
  const install = requireInstall()
  // hudSerialize() always produces valid JSON, so this only ever fires on a
  // renderer bug - but a corrupt UI.json breaks the player's in-game HUD, and
  // that's not worth trusting a caller for.
  if (!store.validUi(uiRaw)) return { status: 'invalid' }
  if (gameRunning()) {
    const pending = readPending() || {}
    setPending({ ...pending, ui: uiRaw })
    return { status: 'queued' }
  }
  k.applyUi(install, uiRaw)
  return { status: 'applied' }
})

// ---- auto-update ---------------------------------------------------------------
// Releases live on this repo's GitHub Releases; electron-updater reads the
// published latest.yml, downloads in the background and verifies the installer
// against its sha512 before offering it. Only a packaged build carries the
// update metadata, so a dev run skips all of it.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000 // the app can sit in the tray for days
let updateReady = null // version string once an update is downloaded and staged

function initAutoUpdate() {
  if (!app.isPackaged) return
  const { autoUpdater } = require('electron-updater')
  autoUpdater.autoDownload = true
  // if the user never clicks "restart now", the staged update still installs
  // the next time they quit from the tray
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info.version
  })
  // offline, rate-limited, or no release yet - just try again on the next tick
  autoUpdater.on('error', () => {})
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  check()
  setInterval(check, UPDATE_POLL_MS)
}

// The renderer polls state every few seconds, so the staged-update flag rides
// along there instead of a push event - it can't be missed by a window that
// was hidden (--hidden startup) or reloaded when the event fired.
ipcMain.handle('update:install', () => {
  if (!updateReady) return { ok: false }
  quitting = true // the window's close handler otherwise just hides to the tray
  require('electron-updater').autoUpdater.quitAndInstall()
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()
  createTray()
  initAutoUpdate()
  flushPendingIfPossible()
  registerHotkeys()
  setInterval(flushPendingIfPossible, 4000)
  setInterval(pollGameRunning, 3000)
  // legacy storage from the removed per-apply undo system
  fs.rmSync(path.join(userData(), 'backups'), { recursive: true, force: true })
  app.on('activate', showWindow)
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Closing the window hides to the tray (hotkeys + queued flushes stay alive);
// only the tray's Quit actually exits, so don't quit on window-all-closed.
app.on('window-all-closed', () => {})
