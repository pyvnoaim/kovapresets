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
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')
const k = require('./core/kovaaks')
const store = require('./core/presets')
const logger = require('./core/log')
const log = logger.log

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
// Authoritative answer, for the two paths where a stale "not running" silently
// eats the write rather than merely delaying it: apply and flush. The poll can
// report false for up to one tick after the game starts, and an apply landing in
// that window writes PrimaryUserSettings.json directly and clears pending - so
// the game's rewrite from launch-time memory drops the sens/DPI/theme with
// nothing left queued to re-assert it. Launch the game, alt-tab, click a preset
// is the normal usage pattern, which made it look intermittent. ~50ms tasklist
// call on a user action only; every other reader still gets the cached value.
function gameRunningNow() {
  gameRunningCache = k.isGameRunning()
  return gameRunningCache
}
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
  // Renderer errors land in the log too - a blank preset list in a user report
  // otherwise leaves nothing to go on.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) log('renderer error', message, `${String(sourceId).split(/[\\/]/).pop()}:${line}`)
  })
  // The preload bridge is attached to the WINDOW, not the page, so anything
  // that loads here inherits it. The app has no in-app links or popups, so
  // pinning the window to index.html costs nothing and means one escaping slip
  // in a game-supplied string (crosshair/theme/scenario names) can't reach it.
  // External links go through shell.openExternal, which these don't affect.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Block anything that tries to leave index.html - nothing here legitimately
  // navigates. Compared against a STABLE precomputed URL, not the live
  // getURL(): reload goes through win:reload (webContents.reload(), which never
  // fires this), so the only navigations that reach here are the page trying to
  // leave - and matching getURL() was fragile (empty during a transient load,
  // or a different file:// casing on Windows) and could wrongly block a reload.
  const indexFile = path.join(__dirname, 'renderer', 'index.html')
  const indexUrl = pathToFileURL(indexFile).toString()
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== indexUrl) e.preventDefault()
  })
  win.loadFile(indexFile)
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
// applyMode ('manual' | 'reenter' | 'restart') is deliberately NOT defaulted here:
// it has to stay undefined for an existing config so applyMode() can migrate the
// old autoRestart boolean onto the 'reenter' rung. Defaulting it would merge a
// 'manual' over every existing user and silently turn their auto re-enter off.
const SETTINGS_DEFAULTS = { autoRestart: false, trayTipShown: false, onboarded: false }
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

// Full game restart - the only thing that makes sens and DPI take effect, since
// the game reads PrimaryUserSettings.json at launch and nothing else re-reads it
// (verified: it rewrites that file from memory on settings interactions but never
// reads it back, and the weaponsettings sens fields are ignored on the
// scenario-entry reload). Close -> flush the queued fields while closed -> one
// deep link, which Steam uses to BOTH launch the game and jump to the scenario.
const CLOSE_POLL_MS = 500
const CLOSE_TIMEOUT_MS = 20000

function closeGame() {
  // WM_CLOSE, not /F: a graceful close lets the game write its own state, and the
  // pending flush lands after it exits so our values win. A force kill risks
  // losing the player's unsaved stats for no benefit.
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'FPSAimTrainer.exe'], { windowsHide: true }, () => resolve())
  })
}

function waitForExit() {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      execFile(
        'tasklist',
        ['/FI', 'IMAGENAME eq FPSAimTrainer.exe', '/NH'],
        { windowsHide: true },
        (err, out) => {
          if (err || !/FPSAimTrainer\.exe/i.test(String(out))) return resolve(true)
          if (Date.now() - started > CLOSE_TIMEOUT_MS) return resolve(false)
          setTimeout(tick, CLOSE_POLL_MS)
        }
      )
    }
    tick()
  })
}

// A restart takes tens of seconds and the hotkeys stay live throughout, so a
// second press must not start an overlapping close/relaunch pair - that could
// kill the copy Steam just started, or double-launch.
let restartInFlight = false

async function doRestartGame() {
  if (restartInFlight) return { ok: false, error: 'A restart is already in progress.' }
  if (!gameRunning()) return { ok: false, error: "KovaaK's isn't running." }
  restartInFlight = true
  try {
    return await restartGameInner()
  } finally {
    restartInFlight = false
  }
}

async function restartGameInner() {
  const install = findInstall()
  // Read the scenario BEFORE closing - it comes from the stats history, which the
  // game only appends to, but resolving it up front keeps the ordering obvious.
  const [scenario] = install ? k.recentScenariosFromStats(install) : []
  await closeGame()
  if (!(await waitForExit())) {
    log('restart: game did not close within timeout')
    return { ok: false, error: "KovaaK's didn't close - it may be showing a prompt. Close it and the queued settings apply automatically." }
  }
  gameRunningCache = false
  // now that the game is gone, the queued sens/DPI/theme can actually land
  flushPendingIfPossible()
  log('restart: relaunching', scenario || '(no scenario)')
  if (!scenario) {
    shell.openExternal(`steam://run/${STEAM_APP_ID}`)
    return { ok: true, scenario: null }
  }
  // no parking hop needed: a fresh launch loads the scenario for the first time
  shell.openExternal(scenarioLink(scenario, true))
  return { ok: true, scenario }
}

// What an apply should do to make itself take effect. Replaces the old
// autoRestart boolean; 'reenter' is its equivalent.
const APPLY_MODES = new Set(['manual', 'reenter', 'restart'])
function applyMode() {
  const s = loadSettings()
  if (APPLY_MODES.has(s.applyMode)) return s.applyMode
  return s.autoRestart ? 'reenter' : 'manual'
}

// Run the configured follow-up after an apply. `result` is doApplyPreset's.
// Only escalates when there's something for that step to make live: re-entry is
// pointless without a weaponsettings change, and a restart is only worth its
// ~40s when a game-owned field is actually queued.
async function runApplyFollowUp(result) {
  if (!result.running) return { mode: 'manual' }
  const mode = applyMode()
  // Restart ONLY for fields that genuinely need a launch (result.queued). A
  // crosshair/sound-only change is fully covered by a scenario re-entry, so
  // escalating to a ~40s relaunch for it would be pure cost - hence `queued`
  // here and not `queued || weaponChanged`.
  if (mode === 'restart' && result.queued) {
    const r = await doRestartGame()
    return { mode: 'restart', ok: r.ok, error: r.error, scenario: r.scenario }
  }
  if ((mode === 'reenter' || mode === 'restart') && result.weaponChanged) {
    const r = await doRestartScenario()
    return { mode: 'reenter', ok: r.ok, error: r.error, scenario: r.scenario }
  }
  return { mode: 'manual' }
}

// ---- pending (game-owned files queued while the game runs) --------------------
function setPending(pending) {
  // atomic: pending.json holds the whole queued intent - a torn write would
  // drop it, or worse flush half of it into the game's files on quit
  k.writeFileAtomic(pendingFile(), JSON.stringify(pending))
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
let lastFlushError = ''
function flushPendingIfPossible() {
  try {
    const r = flushPending()
    lastFlushError = ''
    return r
  } catch (e) {
    // log each DISTINCT failure once, not once per 4s tick for hours
    const msg = String(e?.message || e)
    if (msg !== lastFlushError) {
      lastFlushError = msg
      log('flush failed (will retry)', e)
    }
    return false
  }
}

function flushPending() {
  // No queue at all is the overwhelmingly common tick - skip on a bare stat.
  if (!fs.existsSync(pendingFile())) return false
  const pending = readPending()
  if (!pending) return false
  // Cached first, authoritative second, and the order matters for cost: this runs
  // on a 4s timer for as long as a queue exists (hours, if the game is up), and
  // the authoritative check is a BLOCKING tasklist spawn on the main process.
  // Only the cache saying "closed" is dangerous - that's the one direction where
  // being wrong writes into a live game - so only that path pays, and it happens
  // once, because the flush it guards clears the queue.
  if (gameRunning()) return false
  if (gameRunningNow()) return false
  const install = findInstall()
  if (!install) return false
  const p = k.paths(install)
  if (pending.primaryRaw != null)
    // undo restore: put the exact captured file back
    k.writeFileAtomic(p.primary, pending.primaryRaw)
  else if (pending.primary) {
    // Re-label the proxy BEFORE pointing CurrentThemeName at the new name: the
    // two are matched against each other, and a crash between them is only
    // recoverable in this order. A file whose name nothing selects is inert; a
    // selection naming no file empties the game's theme dropdown.
    // (applyPrimary walks PRIMARY_MANAGED only, so proxyName rides along inert.)
    //
    // The re-label FAILING is the case that strands us: the Themes folder lives
    // inside the game install, so a Steam "verify integrity" can delete the
    // proxy between the apply and this flush. Rebuild it from the queued intent
    // rather than letting CurrentThemeName name a theme that doesn't exist.
    if (pending.primary.proxyName) {
      if (!k.setProxyThemeName(install, pending.primary.proxyName))
        k.writeProxyTheme(install, pending.primary, pending.primary.proxyName)
    }
    k.applyPrimary(install, pending.primary)
  }
  if (pending.ui != null) k.applyUi(install, pending.ui)
  // re-assert the weapon intent the game's exit-write may have reverted
  if (pending.weaponRaw != null) k.writeFileAtomic(p.weapon, pending.weaponRaw)
  else if (pending.weapon) k.applyWeapon(install, pending.weapon)
  log('pending flushed', Object.keys(pending))
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
  const p = k.paths(install)
  const files = { weapon: p.weapon, primary: p.primary, proxy: p.proxy, ui: p.ui }
  const dir = baselineDir()
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, file] of Object.entries(files))
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, `${name}.bak`))
}

function deactivatePresets() {
  if (!hasBaseline()) return { ok: false, error: 'Nothing to restore.' }
  const dir = baselineDir()
  const install = requireInstall()
  const p = k.paths(install)
  const running = gameRunning()
  const read = (n) => {
    const f = path.join(dir, n)
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
  }
  // weapon + proxy theme are safe to write any time
  const weapon = read('weapon.bak')
  if (weapon != null) k.writeFileAtomic(p.weapon, weapon)
  const proxy = read('proxy.bak')
  if (proxy != null) k.writeFileAtomic(p.proxy, proxy)
  // game-owned files follow the closed-game rule
  const primaryRaw = read('primary.bak')
  const ui = read('ui.bak')
  let queued = false
  if (running) {
    // A restore supersedes EVERYTHING queued - start from an empty pending, or
    // a leftover intent with no baseline counterpart (e.g. a queued HUD layout
    // when no UI.json existed at capture) would re-apply part of it after the
    // restore, on game quit.
    const pending = {}
    if (weapon != null) pending.weaponRaw = weapon
    if (primaryRaw != null) pending.primaryRaw = primaryRaw
    if (ui != null) pending.ui = ui
    setPending(pending)
    queued = primaryRaw != null || ui != null
  } else {
    clearPending() // same reasoning - drop any not-yet-flushed preset intents
    if (primaryRaw != null) k.writeFileAtomic(p.primary, primaryRaw)
    if (ui != null) k.applyUi(install, ui)
  }
  fs.rmSync(dir, { recursive: true, force: true }) // restored - next apply recaptures
  log('restored original setup', { running, queued })
  return { ok: true, queued }
}

// ---- preset apply (shared by IPC and hotkeys) ---------------------------------
function doApplyPreset(preset) {
  const install = requireInstall()
  const running = gameRunningNow()
  captureBaselineIfMissing(install)
  const weaponChanged = k.applyWeapon(install, preset.weapon)

  const activePrimary = k.readPrimary(install)
  // Sens and DPI have no live route at all - the game reads them only at launch
  // (see setSensPick). Unlike the theme, no in-game gesture picks them up, so a
  // changed value would otherwise sit there silently doing nothing. Report which
  // ones changed so the UI can say so instead of the player discovering it.
  // Carries the VALUE, not just the field name: the other way to apply these is
  // to type them into the game's own settings screen (which does take effect
  // immediately), so the UI can only offer that if it can tell you what to type.
  // Number.isFinite guards both ends: an imported/corrupt preset carrying a
  // non-numeric sens would otherwise surface as a literal "sens NaN" in the UI,
  // since NaN !== anything makes the difference check always true.
  const launchOnly = []
  const changedNum = (want, cur) =>
    Number.isFinite(Number(want)) && Number(want) !== Number(cur)
  const wantSens = preset.primary?.floatSettings?.XSens
  if (wantSens !== undefined && changedNum(wantSens, activePrimary.floatSettings?.XSens))
    launchOnly.push({ field: 'sens', value: Number(wantSens) })
  const wantDpi = preset.primary?.integerSettings?.DPI
  if (wantDpi !== undefined && changedNum(wantDpi, activePrimary.integerSettings?.DPI))
    launchOnly.push({ field: 'DPI', value: Number(wantDpi) })

  // primaryDiffers compares against PrimaryUserSettings.json ON DISK - except for
  // theme fields while the proxy is selected, which it compares against the proxy
  // file, because that's what the game is actually rendering (see the note there).
  // The settings file is only the truth while the game is CLOSED - a running game
  // owns those fields in memory and rewrites the file from them. So this answers
  // "is there a change to report", NOT "is there anything to write": a preset
  // whose sens already matches disk still has to be re-asserted after the game
  // quits, or the game's own rewrite puts the launch-time value back and the pick
  // silently does nothing. That was the other half of the intermittent sens - the
  // half a fresh running-check can't fix.
  const primaryChanged = k.primaryDiffers(install, preset.primary)
  let primaryIntent = null
  if (preset.primary) {
    primaryIntent = JSON.parse(JSON.stringify(preset.primary))
    if (!primaryIntent.stringSettings) primaryIntent.stringSettings = {}
    if (primaryChanged) {
      // The proxy's name mirrors the preset's theme so overlays and the in-game
      // menu read something meaningful - but the name is the game's selection
      // key, bound in memory at launch, so it can only move while the game is
      // CLOSED (see the PROXY_THEME notes in kovaaks.js). Running: rewrite the
      // contents under the EXISTING name, and queue the new one for the quit
      // flush. Closed: both move together, right now.
      const wantName = k.proxyThemeName(preset.primary.stringSettings?.CurrentThemeName)
      k.writeProxyTheme(install, preset.primary, running ? k.readProxyName(install) : wantName)
      primaryIntent.stringSettings.CurrentThemeName = wantName
      // The flush re-labels the file to match; without this the queued
      // CurrentThemeName would land on a proxy still carrying the old name and
      // the game would boot with an empty theme selection.
      primaryIntent.proxyName = wantName
    } else {
      // Nothing visibly differs, so don't touch theme SELECTION. On the proxy
      // that's because it already renders this preset's theme (the check reads
      // the proxy file, not the stale settings one); off it, the proxy still
      // holds whatever the last apply wrote and pinning the game to it here
      // would hand the player a different preset's theme. Either way this intent
      // exists purely to survive the game's exit rewrite.
      delete primaryIntent.stringSettings.CurrentThemeName
    }
  }
  const wantPrimary = primaryChanged ? primaryIntent : null

  let theme = 'nochange'
  if (running) {
    // The game rewrites weaponsettings.ini from memory on exit, so an apply it
    // never re-read (no scenario re-entry) gets reverted at quit. Queue the
    // intent; the quit flush re-asserts it.
    //
    // REPLACE the queue, don't merge into it: a preset is a total intent, and a
    // field this preset leaves alone (nothing to write, the disk already
    // matches) would otherwise keep the PREVIOUS preset's queued value and land
    // that on game quit - e.g. apply a dark preset, then a light one whose theme
    // equals the on-disk one, and the dark theme still applies at quit.
    //
    // The exception is a field presets carry NOTHING for: a HUD layout saved
    // from the editor mid-session (pending.ui) is its own intent and stands.
    const prev = readPending() || {}
    const next = { weapon: preset.weapon, primary: primaryIntent }
    if (prev.ui != null) next.ui = prev.ui
    setPending(next)
    if (wantPrimary) theme = k.proxyThemeSelected(install) ? 'live' : 'arming'
  } else if (wantPrimary) {
    k.applyPrimary(install, wantPrimary)
    clearPending()
    theme = 'applied'
  }
  // `queued` = game-owned fields (theme/sens/DPI) waiting on the game to close.
  // Only a full restart makes those live, so it gates that escalation.
  const queued = running && !!wantPrimary
  const result = { weaponChanged, theme, running, queued, launchOnly }
  log('apply', preset.name || '(unnamed)', result)
  return result
}

// ---- global hotkeys -----------------------------------------------------------
// Apply + configured follow-up + renderer toast, shared by the two background
// surfaces (global hotkey, tray click). Both happen while the game has focus,
// so the follow-up is what makes the apply hands-off, and errors have nowhere
// to surface - the window may be hidden.
async function applyAndNotify(preset) {
  try {
    const result = doApplyPreset(preset)
    const followUp = await runApplyFollowUp(result)
    if (win && !win.isDestroyed())
      win.webContents.send('hotkey-applied', { name: preset.name, ...result, followUp })
  } catch {
    // install missing mid-session - nothing sane to do in the background
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const presets = store.load(userData())
  for (const preset of presets) {
    if (!preset.hotkey) continue
    try {
      globalShortcut.register(preset.hotkey, () => {
        // Re-read by id instead of closing over the loaded object: only
        // delete/setHotkey re-register, so editing a preset (build/update/
        // updateWeapon/rename) would otherwise leave the hotkey applying the
        // preset as it looked when hotkeys were last registered.
        const fresh = store.load(userData()).find((x) => x.id === preset.id)
        if (fresh) applyAndNotify(fresh)
      })
    } catch {
      // invalid accelerator string - ignore, the UI validates on record
    }
  }
}

// Overlay one primary-shaped object's fields onto another, section by section.
function overlayPrimary(base, overlay) {
  for (const [section, fields] of Object.entries(overlay)) {
    if (!base[section]) base[section] = {}
    Object.assign(base[section], fields)
  }
}

// ---- presets migration (v1 flat shape -> nested) ------------------------------
function loadPresetsMigrated(install) {
  const presets = store.load(userData())
  let changed = false
  for (const p of presets) {
    if (!p.primary || p.primary.stringSettings) continue
    const flat = p.primary
    const base = JSON.parse(JSON.stringify(k.readPrimary(install)))
    const fromTheme = flat.CurrentThemeName ? k.primaryFromTheme(install, flat.CurrentThemeName) : null
    if (fromTheme) overlayPrimary(base, fromTheme)
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
  // Presets built while sens was thought to apply live carry only the
  // weaponsettings override (OverrideSens=true), which the game ignores - so
  // their sens silently did nothing. Move the value they already hold onto the
  // route that works (XSens/YSens) and clear the override, which would otherwise
  // shadow it at launch. The scale falls back to the live one, which is how that
  // unpinned number was already being read, so no speeds change.
  let active = null
  for (const p of presets) {
    const h = p.weapon?.HorizontalSens
    if (String(p.weapon?.OverrideSens).toLowerCase() !== 'true' || h == null || h === '') continue
    const sens = Number(h)
    if (!Number.isFinite(sens) || sens <= 0) continue
    if (!active) active = { primary: k.readPrimary(install) }
    p.primary = p.primary || {}
    k.setSensPick(p.weapon, p.primary, sens, k.sensScaleOf(p.primary, active))
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
    click: () => applyAndNotify(p),
  }))
  return Menu.buildFromTemplate([
    ...(items.length ? items : [{ label: 'No presets yet', enabled: false }]),
    { type: 'separator' },
    // The window can go unopened for days, so the staged update needs a route
    // that doesn't depend on anyone looking at it.
    ...(updateReady
      ? [{ label: `Restart to update to ${updateReady}`, click: () => installUpdate() }]
      : []),
    { label: 'Open KovaPresets', click: showWindow },
    // support surface: "sens didn't apply" reports come with a file to look at
    ...(logger.logPath()
      ? [{ label: 'Open log file', click: () => shell.showItemInFolder(logger.logPath()) }]
      : []),
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
  const { active } = readActiveMerged(install)
  presets.push({ id: store.newId(), name: name || 'New preset', weapon: active.weapon, primary: active.primary })
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

// Sens/DPI both need a positive number; an empty field means "keep current".
const validPick = (v) => v != null && Number.isFinite(Number(v)) && Number(v) > 0

// Overlay the builder's picks onto a weapon+primary pair, mutating both - the
// shared half of preset create (onto a snapshot of the active setup) and preset
// edit (onto the preset's own data). Empty pick = keep. `activeForScale` gives
// a sens pick its scale when `primary` carries none of its own.
function applyPicks(install, weapon, primary, picks, activeForScale) {
  if (picks.crosshair) weapon.CrosshairFile = picks.crosshair
  if (picks.crosshairScale > 0) weapon.CrosshairScale = String(picks.crosshairScale)
  if (picks.crosshairColor) weapon.CrosshairColor = picks.crosshairColor
  if (picks.bodyHit != null) weapon.BodyHitSound = picks.bodyHit
  if (picks.theme) {
    const fromTheme = k.primaryFromTheme(install, picks.theme)
    if (fromTheme) {
      overlayPrimary(primary, fromTheme)
      dropStaleMaterialIndices(primary)
    }
  }
  if (picks.killSound != null) {
    if (!primary.stringSettings) primary.stringSettings = {}
    primary.stringSettings.KillConfirmedSound = picks.killSound
  }
  if (validPick(picks.dpi)) {
    if (!primary.integerSettings) primary.integerSettings = {}
    primary.integerSettings.DPI = Math.round(Number(picks.dpi))
  }
  // after the theme overlay, so a theme pick can't drop the sens fields
  if (validPick(picks.sens))
    k.setSensPick(weapon, primary, Number(picks.sens), k.sensScaleOf(primary, activeForScale))
}

ipcMain.handle('presets:build', (_e, picks) => {
  const install = requireInstall()
  const { active } = readActiveMerged(install)
  const weapon = { ...active.weapon }
  const primary = JSON.parse(JSON.stringify(active.primary))
  applyPicks(install, weapon, primary, picks, active)
  const presets = store.load(userData())
  presets.push({ id: store.newId(), name: picks.name || 'New preset', weapon, primary })
  store.save(userData(), presets)
  return presets
})

// Edit an existing preset: same picks shape as presets:build, but applied on
// top of the preset's own data.
ipcMain.handle('presets:update', (_e, id, picks) => {
  const install = requireInstall()
  const presets = store.load(userData())
  const p = presets.find((x) => x.id === id)
  if (!p) return presets
  if (picks.name) p.name = String(picks.name).slice(0, 80)
  p.weapon = p.weapon || {}
  p.primary = p.primary || {}
  applyPicks(install, p.weapon, p.primary, picks, readActiveMerged(install).active)
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
ipcMain.handle('preset:apply', async (_e, id) => {
  const preset = store.load(userData()).find((p) => p.id === id)
  if (!preset) throw new Error('That preset no longer exists.')
  const result = doApplyPreset(preset)
  return { ...result, followUp: await runApplyFollowUp(result) }
})

ipcMain.handle('presets:deactivate', () => deactivatePresets())

ipcMain.handle('game:restart', () => doRestartScenario())
ipcMain.handle('game:restartFull', () => doRestartGame())

// Diagnostics for the health panel + first-run wizard. Uses the cached install
// (findInstall) and write-probes the settings folders, so it's a user-driven
// call, never on the state poll path.
ipcMain.handle('health:check', () => k.checkHealth(findInstall()))

// Create the !KovaPreset proxy theme file up front (first-run "arm live themes"
// step), so it shows in KovaaK's theme list before any preset has been applied.
// Seeded from the current setup, so selecting it changes nothing until a preset
// with a theme is applied. No-op if it already exists.
ipcMain.handle('proxy:ensure', () => {
  const install = findInstall()
  if (!install) return { ok: false, error: "KovaaK's install not found." }
  try {
    const p = k.paths(install)
    fs.mkdirSync(p.themes, { recursive: true })
    if (fs.existsSync(p.proxy)) return { ok: true, existed: true }
    k.writeProxyTheme(install, k.readPrimary(install))
    return { ok: true, existed: false }
  } catch {
    return { ok: false, error: 'Could not create the proxy theme file.' }
  }
})

ipcMain.handle('game:launch', () => {
  shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
  return { ok: true }
})

ipcMain.handle('win:minimize', () => win?.minimize())
ipcMain.handle('win:devtools', () => win?.webContents.toggleDevTools())
ipcMain.handle('win:close', () => win?.close()) // routes through close-to-tray
// Programmatic reload: it never fires will-navigate, so the guard below can't
// block it - unlike a renderer location.reload(), whose URL-string match is
// fragile (Windows file:// casing, transient getURL()).
ipcMain.handle('win:reload', () => win?.webContents.reload())

// applyMode goes out RESOLVED (the stored value may be absent pre-migration, see
// applyMode()) so the renderer never re-implements the autoRestart fallback.
ipcMain.handle('settings:get', () => ({ ...loadSettings(), applyMode: applyMode() }))

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
  // ids are local and hotkeys are personal - neither belongs in a shared file
  // (imports ignore them too). Dead fields from older stores never get here:
  // store.load strips them.
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
  if (!k.validUi(uiRaw)) return { status: 'invalid' }
  // The HUD editor writes UI.json directly, so "Restore original setup" must
  // have the pre-KovaPresets layout on file before the first save lands.
  captureBaselineIfMissing(install)
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
    log('update downloaded', info.version)
    // The tray is the only surface guaranteed to be visible - the window is
    // usually hidden when this fires, which is exactly how a staged update used
    // to go unmentioned indefinitely.
    if (tray && !tray.isDestroyed()) tray.setToolTip(`KovaPresets - update ${info.version} ready`)
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
function installUpdate() {
  if (!updateReady) return { ok: false }
  quitting = true // the window's close handler otherwise just hides to the tray
  require('electron-updater').autoUpdater.quitAndInstall()
  return { ok: true }
}
ipcMain.handle('update:install', () => installUpdate())

app.whenReady().then(() => {
  logger.init(userData())
  log('---- app start', app.getVersion(), app.isPackaged ? 'packaged' : 'dev', '----')
  createWindow()
  createTray()
  initAutoUpdate()
  flushPendingIfPossible()
  registerHotkeys()
  setInterval(flushPendingIfPossible, 4000)
  setInterval(pollGameRunning, 3000)
  // legacy storage from the removed per-apply undo system
  fs.rmSync(path.join(userData(), 'backups'), { recursive: true, force: true })
  // The "Start with Windows" setting is gone, but anyone who had it on still has
  // a registered login item - and with the toggle removed there'd be no way to
  // turn it off. Clear it once, and drop the dead setting key.
  if (app.isPackaged && app.getLoginItemSettings().openAtLogin)
    app.setLoginItemSettings({ openAtLogin: false })
  const s = loadSettings()
  if ('launchOnStartup' in s) {
    delete s.launchOnStartup
    saveSettings(s)
  }
  app.on('activate', showWindow)
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => globalShortcut.unregisterAll())

// Closing the window hides to the tray (hotkeys + queued flushes stay alive);
// only the tray's Quit actually exits, so don't quit on window-all-closed.
app.on('window-all-closed', () => {})
