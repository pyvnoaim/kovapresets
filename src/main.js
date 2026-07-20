// Electron main process. Owns all filesystem/game access; the renderer talks to
// it only through the IPC surface in preload.js. Core logic is in core/kovaaks.js.
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const k = require('./core/kovaaks')
const store = require('./core/presets')

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#111114',
    title: 'KovaPreset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.removeMenu()
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

function requireInstall() {
  const install = k.findInstall()
  if (!install) throw new Error("KovaaK's install not found. Is it installed via Steam?")
  return install
}

const userData = () => app.getPath('userData')
const pendingFile = () => path.join(userData(), 'pending.json')

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
  if (primaryRaw != null || palette != null || ui != null) {
    if (running) {
      // stash raw primary restore as a pending full-file write via parsed fields
      const pending = readPending() || {}
      if (primaryRaw != null) pending.primaryRaw = primaryRaw
      if (palette != null) pending.palette = palette
      if (ui != null) pending.ui = ui
      setPending(pending)
      queued = true
    } else {
      if (primaryRaw != null)
        fs.writeFileSync(
          path.join(install, 'Saved', 'SaveGames', 'PrimaryUserSettings.json'),
          primaryRaw
        )
      if (palette != null) k.applyPalette(install, palette)
      if (ui != null) k.applyUi(install, ui)
    }
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
      globalShortcut.register(preset.hotkey, () => {
        try {
          const result = doApplyPreset(preset)
          if (win && !win.isDestroyed())
            win.webContents.send('hotkey-applied', { name: preset.name, ...result })
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

// ---- IPC ----------------------------------------------------------------------
ipcMain.handle('state', () => {
  const install = k.findInstall()
  if (!install) return { install: null }
  return {
    install,
    gameRunning: k.isGameRunning(),
    active: k.readActive(install),
    options: k.listOptions(install),
    presets: loadPresetsMigrated(install),
    pending: !!readPending(),
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
  flushPendingIfPossible()
  registerHotkeys()
  setInterval(flushPendingIfPossible, 4000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
