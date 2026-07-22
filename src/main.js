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
const k = require('./core/kovaaks')
const store = require('./core/presets')

const STEAM_APP_ID = '824270' // KovaaK's

let win = null
let tray = null
let quitting = false

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#111114',
    title: 'KovaPresets',
    icon: path.join(__dirname, 'assets', 'tray.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.removeMenu()
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
  const install = k.findInstall()
  if (!install) throw new Error("KovaaK's install not found. Is it installed via Steam?")
  return install
}

const userData = () => app.getPath('userData')
const pendingFile = () => path.join(userData(), 'pending.json')

// ---- app settings (small flags, not presets) -----------------------------------
const SETTINGS_DEFAULTS = { autoRestart: false, trayTipShown: false }
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
  if (!k.isGameRunning()) return { ok: false, error: "KovaaK's isn't running." }
  const install = k.findInstall()
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

function flushPendingIfPossible() {
  const pending = readPending()
  if (!pending) return false
  if (k.isGameRunning()) return false
  const install = k.findInstall()
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

// ---- undo: snapshot game files before every apply -----------------------------
const MAX_BACKUPS = 10
const backupsDir = () => path.join(userData(), 'backups')

function snapshotBeforeApply(install) {
  const p = {
    weapon: path.join(install, 'Saved', 'SaveGames', 'weaponsettings.ini'),
    primary: path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
    proxy: path.join(install, 'Saved', 'SaveGames', 'Themes', `${k.PROXY_THEME}.json`),
  }
  const dir = path.join(backupsDir(), String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  const active = k.readActive(install)
  for (const [name, file] of Object.entries(p))
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `${name}.bak`))
  if (active.palette != null) fs.writeFileSync(path.join(dir, 'palette.bak'), active.palette)
  if (active.ui != null) fs.writeFileSync(path.join(dir, 'ui.bak'), active.ui)
  // prune oldest beyond the cap
  const all = fs
    .readdirSync(backupsDir())
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(a) - Number(b))
  while (all.length > MAX_BACKUPS) {
    fs.rmSync(path.join(backupsDir(), all.shift()), { recursive: true, force: true })
  }
}

function latestBackup() {
  try {
    const all = fs
      .readdirSync(backupsDir())
      .filter((d) => /^\d+$/.test(d))
      .sort((a, b) => Number(b) - Number(a))
    return all.length ? path.join(backupsDir(), all[0]) : null
  } catch {
    return null
  }
}

function undoLastApply() {
  const dir = latestBackup()
  if (!dir) return { ok: false, error: 'Nothing to undo.' }
  const install = requireInstall()
  const running = k.isGameRunning()
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
    // stash restores the running game would clobber on exit; the quit flush
    // writes them (weapon is restored live above, but re-asserted at quit too)
    const pending = readPending() || {}
    if (weapon != null) pending.weaponRaw = weapon
    if (primaryRaw != null) pending.primaryRaw = primaryRaw
    if (palette != null) pending.palette = palette
    if (ui != null) pending.ui = ui
    delete pending.weapon // raw restore supersedes a queued preset intent
    setPending(pending)
    queued = primaryRaw != null || palette != null || ui != null
  } else if (primaryRaw != null || palette != null || ui != null) {
    if (primaryRaw != null)
      fs.writeFileSync(
        path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
        primaryRaw
      )
    if (palette != null) k.applyPalette(install, palette)
    if (ui != null) k.applyUi(install, ui)
  }
  fs.rmSync(dir, { recursive: true, force: true }) // undo consumes the backup
  return { ok: true, queued }
}

// ---- preset apply (shared by IPC and hotkeys) ---------------------------------
function doApplyPreset(preset) {
  const install = requireInstall()
  const running = k.isGameRunning()
  snapshotBeforeApply(install)
  const weaponChanged = k.applyWeapon(install, preset.weapon)
  // The game rewrites weaponsettings.ini from memory on exit, so an apply it
  // never re-read (no scenario re-entry) gets reverted at quit. Queue the
  // intent; the quit flush re-asserts it.
  if (running) setPending({ ...(readPending() || {}), weapon: preset.weapon })

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
  if (wants.primary || wants.palette != null || wants.ui != null) {
    if (running) {
      const pending = readPending() || {}
      setPending({ ...pending, ...wants })
      theme = wants.primary ? (k.proxyThemeSelected(install) ? 'live' : 'arming') : 'queued'
    } else {
      if (wants.primary) k.applyPrimary(install, wants.primary)
      if (wants.palette != null) k.applyPalette(install, wants.palette)
      if (wants.ui != null) k.applyUi(install, wants.ui)
      clearPending()
      theme = 'applied'
    }
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
          const result = doApplyPreset(preset)
          // hotkey applies happen while playing, so the game already has focus -
          // the auto re-enter is just a keypress away from being fully hands-off
          let restarted = false
          if (loadSettings().autoRestart && result.running && result.weaponChanged)
            restarted = (await doRestartScenario()).ok
          if (win && !win.isDestroyed())
            win.webContents.send('hotkey-applied', { name: preset.name, ...result, restarted })
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
ipcMain.handle('state', () => {
  const install = k.findInstall()
  if (!install) return { install: null }
  const active = k.readActive(install)
  // Applies made while the game runs sit in pending.json until the game quits,
  // so the files still hold the old values. Merge the queued intent into the
  // reported state or the UI forgets what was applied (worst after an app
  // restart, when nothing else hints at it).
  const pending = readPending()
  if (pending) {
    if (pending.primary && active.primary)
      for (const [section, fields] of Object.entries(pending.primary))
        active.primary[section] = { ...(active.primary[section] || {}), ...fields }
    if (pending.palette != null) active.palette = pending.palette
    if (pending.ui != null) active.ui = pending.ui
    if (pending.weapon) active.weapon = { ...active.weapon, ...pending.weapon }
  }
  return {
    install,
    gameRunning: k.isGameRunning(),
    active,
    options: k.listOptions(install),
    presets: loadPresetsMigrated(install),
    pending: !!pending,
    resolution: k.readResolution(),
    canUndo: !!latestBackup(),
  }
})

ipcMain.handle('presets:capture', (_e, name) => {
  const install = requireInstall()
  const presets = store.load(userData())
  presets.push({ id: store.newId(), name: name || 'New preset', ...k.readActive(install) })
  store.save(userData(), presets)
  return presets
})

ipcMain.handle('presets:build', (_e, picks) => {
  const install = requireInstall()
  const active = k.readActive(install)
  const weapon = { ...active.weapon }
  if (picks.crosshair) weapon.CrosshairFile = picks.crosshair
  if (picks.crosshairColor) weapon.CrosshairColor = picks.crosshairColor
  if (picks.bodyHit != null) weapon.BodyHitSound = picks.bodyHit

  const primary = JSON.parse(JSON.stringify(active.primary))
  if (picks.theme) {
    const fromTheme = k.primaryFromTheme(install, picks.theme)
    if (fromTheme)
      for (const [section, fields] of Object.entries(fromTheme)) {
        if (!primary[section]) primary[section] = {}
        Object.assign(primary[section], fields)
      }
  }
  if (picks.killSound != null) {
    if (!primary.stringSettings) primary.stringSettings = {}
    primary.stringSettings.KillConfirmedSound = picks.killSound
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

ipcMain.handle('preset:apply', (_e, preset) => doApplyPreset(preset))

ipcMain.handle('undo:last', () => undoLastApply())

ipcMain.handle('game:restart', () => doRestartScenario())

ipcMain.handle('game:launch', () => {
  shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
  return { ok: true }
})

ipcMain.handle('settings:get', () => loadSettings())

ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch }
  saveSettings(s)
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
      palette: typeof p.palette === 'string' ? p.palette : null,
      ui: typeof p.ui === 'string' ? p.ui : null,
    })
    count++
  }
  if (!count) return { ok: false, error: 'No presets found in that file.' }
  store.save(userData(), presets)
  return { ok: true, count, presets }
})

ipcMain.handle('hud:save', (_e, uiRaw) => {
  const install = requireInstall()
  if (k.isGameRunning()) {
    const pending = readPending() || {}
    setPending({ ...pending, ui: uiRaw })
    return { status: 'queued' }
  }
  k.applyUi(install, uiRaw)
  return { status: 'applied' }
})

app.whenReady().then(() => {
  createWindow()
  createTray()
  flushPendingIfPossible()
  registerHotkeys()
  setInterval(flushPendingIfPossible, 4000)
  app.on('activate', showWindow)
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Closing the window hides to the tray (hotkeys + queued flushes stay alive);
// only the tray's Quit actually exits, so don't quit on window-all-closed.
app.on('window-all-closed', () => {})
