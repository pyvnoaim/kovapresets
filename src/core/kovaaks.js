// Core KovaaK's preset logic. Pure Node (no Electron), reused by main.js and
// unit-testable via selftest.js. Two settings files, and they behave differently
// while the game runs - which dictates the whole apply model:
//
//   weaponsettings.ini  (crosshair + combat sounds)
//       The game RE-READS this on scenario entry, so edits apply LIVE. Plain INI;
//       writes preserve BOM + CRLF and touch only our keys.
//
//   PrimaryUserSettings.json  (theme + event sounds)
//       The game OWNS this in memory and rewrites it while running (it clobbers
//       external edits within seconds) and only loads it at launch. So theme edits
//       must land while the game is CLOSED; they take effect next launch. We store
//       the full resolved field set (incl. the material index) captured from the
//       file itself, so applying restores a self-consistent theme.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// --- weaponsettings.ini: live keys ---
const WEAPON_KEYS = [
  'CrosshairFile',
  'CrosshairColor',
  'CrosshairScale',
  'BodyHitSound',
  'HeadHitSound',
  'ShootSound',
  'EnableMissSound',
  'MissSound',
  'MissPitchShiftPerDeg',
  // per-file sens override - weaponsettings reloads on scenario entry, so this
  // is the LIVE half of scenario-specific sens presets (global sens + DPI live
  // in PrimaryUserSettings and only apply on launch/quit-flush)
  'OverrideSens',
  'HorizontalSens',
  'VerticalSens',
  'SensScale',
  'OverrideSensScaleString',
  'ZoomSensMultiplier',
]

// --- PrimaryUserSettings.json: the managed theme + event-sound fields, by
// section. Short names here; the full key is `${SECTION_PREFIX[section]}::${name}`. ---
const PRIMARY_MANAGED = {
  stringSettings: [
    'WallMaterial',
    'FloorMaterial',
    'CeilingMaterial',
    'RampMaterial',
    'CurrentThemeName',
    'KillConfirmedSound',
    'SpawnSound',
    'MBSGoodSound',
    'MBSOkaySound',
    'MBSBadSound',
    'MBSChangeNowSound',
    'SensScaleString',
  ],
  floatSettings: [
    'WallRoughness', 'WallMetallic', 'WallFullBright', 'WallTextureScale',
    'FloorRoughness', 'FloorMetallic', 'FloorFullBright', 'FloorTextureScale',
    'CeilingRoughness', 'CeilingMetallic', 'CeilingFullBright', 'CeilingTextureScale',
    'RampRoughness', 'RampMetallic', 'RampFullBright', 'RampTextureScale',
    'EnemyRoughness', 'EnemyMetalic', 'EnemyFullBright',
    'EnemyGlowUpHead', 'EnemyGlowUpBody',
    'EnemyGlowUpHeadOnHit', 'EnemyGlowUpBodyOnHit',
    'EnemyGlowUpHeadOnLookAt', 'EnemyGlowUpBodyOnLookAt',
    // sound pitch/volume (hit, crit/headshot, enemy)
    'HitPitch', 'HitVolume', 'CritPitch', 'CritVolume', 'EnemyPitch', 'EnemyVolume',
    // global sensitivity (the in-game settings values; DPI sits in integerSettings)
    'XSens', 'YSens',
  ],
  // WallMat/FloorMat are the material INDEX the game actually renders from; keep
  // them alongside the material string so a captured theme stays consistent.
  integerSettings: ['SkyPreset', 'CloudCover', 'WallMat', 'FloorMat', 'DPI', 'SensitivityScaleTargetEnum'],
  booleanSettings: [
    'OverrideEnemyHeadColor',
    'OverrideEnemyBodyColor',
    'ChangeEnemyColorOnHit',
    'ChangeEnemyColorOnLookAt',
    'SolidSkyColor',
    'ShowSunInSkybox',
    'SolidTextureSkyColor',
    'EnemyAttacksColoredByBody',
  ],
  vectorSettings: [
    'WallColor', 'FloorColor', 'CeilingColor', 'RampColor',
    'EnemyHeadColor', 'EnemyHeadColorOnHit', 'EnemyHeadColorOnLookAt',
    'EnemyBodyColor', 'EnemyBodyColorOnHit', 'EnemyBodyColorOnLookAt',
  ],
  colorSettings: ['SkyColor'],
}
const SECTION_PREFIX = {
  stringSettings: 'EStringSettingId',
  floatSettings: 'EFloatSettingId',
  integerSettings: 'EIntegerSettingId',
  booleanSettings: 'EBooleanSettingId',
  vectorSettings: 'EVectorSettingId',
  colorSettings: 'EColorSettingId',
}

// ---- install detection --------------------------------------------------------
function steamRoot() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\SOFTWARE\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8',
    })
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/)
    if (m) return m[1].trim().replace(/\//g, '\\')
  } catch {
    // fall through to guesses
  }
  return null
}

function libraryPaths() {
  const roots = new Set()
  const guesses = [
    steamRoot(),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
  ].filter(Boolean)
  for (const g of guesses) {
    if (fs.existsSync(g)) roots.add(g)
    const vdf = path.join(g, 'steamapps', 'libraryfolders.vdf')
    if (fs.existsSync(vdf)) {
      const txt = fs.readFileSync(vdf, 'utf8')
      for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'))
    }
  }
  return [...roots]
}

function findInstall() {
  for (const root of libraryPaths()) {
    const p = path.join(root, 'steamapps', 'common', 'FPSAimTrainer', 'FPSAimTrainer')
    if (fs.existsSync(path.join(p, 'Saved', 'SaveGames'))) return p
  }
  return null
}

function paths(install) {
  const sg = path.join(install, 'Saved', 'SaveGames')
  return {
    weapon: path.join(sg, 'weaponsettings.ini'),
    primary: path.join(sg, 'PrimaryUserSettings.json'),
    themes: path.join(sg, 'Themes'),
    crosshairs: path.join(install, 'crosshairs'),
    sounds: path.join(install, 'sounds'),
    // HUD window positions/scales - lives with the other SaveGames files.
    ui: path.join(sg, 'UI.json'),
    // The UI palette is UE per-user config, NOT in the game folder.
    palette: path.join(
      process.env.LOCALAPPDATA || '',
      'FPSAimTrainer',
      'Saved',
      'Config',
      'WindowsNoEditor',
      'Palette.ini'
    ),
  }
}

// ---- reading ------------------------------------------------------------------
function readWeapon(install) {
  const p = paths(install)
  const raw = fs.existsSync(p.weapon) ? fs.readFileSync(p.weapon, 'utf8') : ''
  const out = {}
  for (const k of WEAPON_KEYS) {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm'))
    out[k] = m ? m[1].trim() : ''
  }
  return out
}

function readPrimaryObject(install) {
  const p = paths(install)
  try {
    return JSON.parse(fs.readFileSync(p.primary, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

// The managed theme/event-sound fields, nested by section, straight from the file.
function readPrimary(install) {
  const obj = readPrimaryObject(install)
  const out = {}
  for (const [section, names] of Object.entries(PRIMARY_MANAGED)) {
    out[section] = {}
    const src = obj?.[section] || {}
    for (const name of names) {
      const full = `${SECTION_PREFIX[section]}::${name}`
      if (full in src) out[section][name] = src[full]
    }
  }
  return out
}

// Palette.ini and UI.json are captured/applied as whole files - they're small,
// self-contained, and have no partial-field semantics worth modelling.
function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// The scenarios the player played most recently, newest first, deduped: the
// game writes "<scenario> - <mode> - <timestamp> Stats.csv" when a run ends,
// and an apply mid-session virtually always happens between runs. Timestamp is
// parsed from the filename - no per-file stat calls over years of runs.
// [0] is the scenario to re-enter; [1] doubles as the "parking" hop target
// (jumping to the scenario you're already in doesn't reload it, so re-enter
// bounces through a different one first).
function recentScenariosFromStats(install, count = 2) {
  try {
    const newest = new Map() // scenario -> newest ts
    for (const f of fs.readdirSync(path.join(install, 'stats'))) {
      const m = f.match(/^(.*) - .+ - (\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}) Stats\.csv$/)
      if (m && (!newest.has(m[1]) || m[2] > newest.get(m[1]))) newest.set(m[1], m[2])
    }
    return [...newest.entries()]
      .sort((a, b) => (a[1] < b[1] ? 1 : -1))
      .slice(0, count)
      .map(([scenario]) => scenario)
  } catch {
    return []
  }
}

// Full snapshot = exactly what a preset stores.
function readActive(install) {
  const p = paths(install)
  return {
    weapon: readWeapon(install),
    primary: readPrimary(install),
    palette: readFileOrNull(p.palette),
    ui: readFileOrNull(p.ui),
  }
}

function applyPalette(install, raw) {
  if (raw == null) return false
  const p = paths(install)
  if (readFileOrNull(p.palette) === raw) return false
  fs.writeFileSync(p.palette, raw)
  return true
}

function applyUi(install, raw) {
  if (raw == null) return false
  const p = paths(install)
  if (readFileOrNull(p.ui) === raw) return false
  fs.writeFileSync(p.ui, raw)
  return true
}

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && exts.some((e) => f.toLowerCase().endsWith(e)))
    .sort((a, b) => a.localeCompare(b))
}

function listOptions(install) {
  const p = paths(install)
  const soundFileList = listFiles(p.sounds, ['.ogg', '.wav', '.mp3'])
  // name (extensionless, how the game refers to sounds) -> actual filename,
  // so the renderer can build playable preview URLs
  const soundFiles = {}
  for (const f of soundFileList) soundFiles[f.replace(/\.[^.]+$/, '')] = f
  return {
    crosshairs: listFiles(p.crosshairs, ['.png']),
    sounds: soundFileList.map((f) => f.replace(/\.[^.]+$/, '')),
    soundFiles,
    themes: listFiles(p.themes, ['.json'])
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(p.themes, f), 'utf8')).themeName || ''
        } catch {
          return f.replace(/\.json$/i, '')
        }
      })
      .filter((n) => n.trim())
      .sort((a, b) => a.localeCompare(b)),
  }
}

// Build a primary snapshot (theme visual fields) from a theme file by name, for
// the preset builder. Maps the theme JSON to the same nested shape readPrimary
// returns. Note: theme files carry no material INDEX (WallMat), only the material
// string - the game resolves the index from the string at launch, which is fine
// since theme changes apply on launch anyway.
function primaryFromTheme(install, themeName) {
  const dir = paths(install).themes
  if (!fs.existsSync(dir)) return null
  let t = null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if ((j.themeName || '').toLowerCase() === themeName.toLowerCase()) {
        t = j
        break
      }
    } catch {
      // skip unreadable theme file
    }
  }
  if (!t) return null

  const out = {
    stringSettings: {},
    floatSettings: {},
    integerSettings: {},
    booleanSettings: {},
    vectorSettings: {},
    colorSettings: {},
  }
  const put = (sec, key, val) => {
    if (val !== undefined) out[sec][key] = val
  }

  put('stringSettings', 'CurrentThemeName', t.themeName)
  put('integerSettings', 'SkyPreset', t.skyPresetId)
  put('integerSettings', 'CloudCover', t.cloudCoverId)
  put('booleanSettings', 'SolidSkyColor', t.solidSkyColor)
  put('booleanSettings', 'ShowSunInSkybox', t.sunVisible)
  put('colorSettings', 'SkyColor', t.skyColor)
  for (const s of ['wall', 'floor', 'ceiling', 'ramp']) {
    const C = s[0].toUpperCase() + s.slice(1)
    put('stringSettings', `${C}Material`, t[`${s}Material`])
    put('floatSettings', `${C}Roughness`, t[`${s}Roughness`])
    put('floatSettings', `${C}Metallic`, t[`${s}Metallic`])
    put('floatSettings', `${C}FullBright`, t[`${s}FullBright`])
    put('floatSettings', `${C}TextureScale`, t[`${s}TextureScale`])
    put('vectorSettings', `${C}Color`, t[`${s}Tint`])
  }
  put('booleanSettings', 'OverrideEnemyHeadColor', t.overrideEnemyHeadColor)
  put('booleanSettings', 'OverrideEnemyBodyColor', t.overrideEnemyBodyColor)
  put('booleanSettings', 'ChangeEnemyColorOnHit', t.changeEnemyColorOnHit)
  put('booleanSettings', 'ChangeEnemyColorOnLookAt', t.changeEnemyColorOnLookAt)
  put('floatSettings', 'EnemyRoughness', t.enemyColorRoughness)
  put('floatSettings', 'EnemyMetalic', t.enemyColorMetallic)
  put('floatSettings', 'EnemyFullBright', t.enemyColorFullBright)
  put('vectorSettings', 'EnemyHeadColor', t.enemyHeadColor)
  put('vectorSettings', 'EnemyHeadColorOnHit', t.enemyHeadColorOnHit)
  put('vectorSettings', 'EnemyHeadColorOnLookAt', t.enemyHeadColorOnLookAt)
  put('vectorSettings', 'EnemyBodyColor', t.enemyBodyColor)
  put('vectorSettings', 'EnemyBodyColorOnHit', t.enemyBodyColorOnHit)
  put('vectorSettings', 'EnemyBodyColorOnLookAt', t.enemyBodyColorOnLookAt)
  put('floatSettings', 'EnemyGlowUpHead', t.enemyGlowUpHead)
  put('floatSettings', 'EnemyGlowUpBody', t.enemyGlowUpBody)
  put('floatSettings', 'EnemyGlowUpHeadOnHit', t.enemyGlowUpHeadOnHit)
  put('floatSettings', 'EnemyGlowUpBodyOnHit', t.enemyGlowUpBodyOnHit)
  put('floatSettings', 'EnemyGlowUpHeadOnLookAt', t.enemyGlowUpHeadOnLookAt)
  put('floatSettings', 'EnemyGlowUpBodyOnLookAt', t.enemyGlowUpBodyOnLookAt)
  return out
}

// ---- live theme via the proxy theme file --------------------------------------
// Discovery (2026-07-20): the game re-reads the CURRENTLY SELECTED theme's
// definition file from disk when the in-game menu is opened, and applies it
// live. (The settings file, by contrast, is only read at launch.) So the app
// owns one proxy theme file, "KovaPreset", the user selects once in-game;
// applying a preset rewrites that file's contents and the next menu-open makes
// it live. No memory writes, no UI automation.
// '!' sorts before digits and letters, so the proxy sits at the top of the
// game's alphabetically-ordered theme list.
const PROXY_THEME = '!KovaPreset'

// Inverse of primaryFromTheme: build a theme-file object from the preset's
// primary-shaped fields. Only fields the preset actually has are written.
function themeFileFromPrimary(primary) {
  const s = primary.stringSettings || {}
  const f = primary.floatSettings || {}
  const i = primary.integerSettings || {}
  const b = primary.booleanSettings || {}
  const v = primary.vectorSettings || {}
  const c = primary.colorSettings || {}
  const t = { themeName: PROXY_THEME }
  const put = (key, val) => {
    if (val !== undefined) t[key] = val
  }
  for (const surf of ['wall', 'floor', 'ceiling', 'ramp']) {
    const C = surf[0].toUpperCase() + surf.slice(1)
    put(`${surf}Material`, s[`${C}Material`])
    put(`${surf}Roughness`, f[`${C}Roughness`])
    put(`${surf}Metallic`, f[`${C}Metallic`])
    put(`${surf}FullBright`, f[`${C}FullBright`])
    put(`${surf}TextureScale`, f[`${C}TextureScale`])
    put(`${surf}Tint`, v[`${C}Color`])
  }
  put('overrideEnemyHeadColor', b.OverrideEnemyHeadColor)
  put('overrideEnemyBodyColor', b.OverrideEnemyBodyColor)
  put('changeEnemyColorOnHit', b.ChangeEnemyColorOnHit)
  put('changeEnemyColorOnLookAt', b.ChangeEnemyColorOnLookAt)
  put('enemyColorRoughness', f.EnemyRoughness)
  put('enemyColorMetallic', f.EnemyMetalic)
  put('enemyColorFullBright', f.EnemyFullBright)
  put('enemyHeadColor', v.EnemyHeadColor)
  put('enemyHeadColorOnHit', v.EnemyHeadColorOnHit)
  put('enemyHeadColorOnLookAt', v.EnemyHeadColorOnLookAt)
  put('enemyBodyColor', v.EnemyBodyColor)
  put('enemyBodyColorOnHit', v.EnemyBodyColorOnHit)
  put('enemyBodyColorOnLookAt', v.EnemyBodyColorOnLookAt)
  put('enemyGlowUpHead', f.EnemyGlowUpHead)
  put('enemyGlowUpBody', f.EnemyGlowUpBody)
  put('enemyGlowUpHeadOnHit', f.EnemyGlowUpHeadOnHit)
  put('enemyGlowUpBodyOnHit', f.EnemyGlowUpBodyOnHit)
  put('enemyGlowUpHeadOnLookAt', f.EnemyGlowUpHeadOnLookAt)
  put('enemyGlowUpBodyOnLookAt', f.EnemyGlowUpBodyOnLookAt)
  put('skyPresetId', i.SkyPreset)
  put('cloudCoverId', i.CloudCover)
  put('solidSkyColor', b.SolidSkyColor)
  put('sunVisible', b.ShowSunInSkybox)
  put('skyColor', c.SkyColor)
  return t
}

// Write the preset's theme into the proxy theme file. Safe at any time - the
// game only reads it on menu-open (and at launch when it's the selected theme).
function writeProxyTheme(install, primary) {
  const t = themeFileFromPrimary(primary)
  const dir = paths(install).themes
  const file = path.join(dir, `${PROXY_THEME}.json`)
  fs.writeFileSync(file, JSON.stringify(t, null, '\t'))
  // drop the pre-rename proxy so the menu doesn't show a stale duplicate
  try {
    fs.unlinkSync(path.join(dir, 'KovaPreset.json'))
  } catch {}
  return file
}

// Is the proxy currently the selected theme (i.e. is live switching armed)?
function proxyThemeSelected(install) {
  const primary = readPrimary(install)
  return primary.stringSettings?.CurrentThemeName === PROXY_THEME
}

// ---- change detection ---------------------------------------------------------
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function weaponDiffers(install, weapon) {
  if (!weapon) return false
  const cur = readWeapon(install)
  return WEAPON_KEYS.some((k) => weapon[k] != null && weapon[k] !== cur[k])
}

function primaryDiffers(install, primary) {
  if (!primary) return false
  const cur = readPrimary(install)
  for (const section of Object.keys(PRIMARY_MANAGED))
    for (const [name, val] of Object.entries(primary[section] || {})) {
      // The selected-theme label is pinned to the proxy on apply, so comparing
      // it would make every preset read as "differs" forever.
      if (name === 'CurrentThemeName') continue
      if (!eq(val, cur[section]?.[name])) return true
    }
  return false
}

// ---- writing ------------------------------------------------------------------
// weaponsettings.ini - live. Targeted line replace, formatting preserved.
function applyWeapon(install, weapon) {
  if (!weapon) return false
  const p = paths(install)
  let raw = fs.readFileSync(p.weapon, 'utf8')
  const before = raw
  for (const k of WEAPON_KEYS) {
    if (weapon[k] == null) continue
    // single line only (imported presets are untrusted - no ini-line injection),
    // and a function replacement so "$&" in a value isn't expanded by replace()
    const val = String(weapon[k]).replace(/[\r\n]/g, '')
    const re = new RegExp(`^${k}=.*$`, 'm')
    if (re.test(raw)) raw = raw.replace(re, () => `${k}=${val}`)
  }
  if (raw !== before) fs.writeFileSync(p.weapon, raw)
  return raw !== before
}

// PrimaryUserSettings.json - only safe while the game is closed (caller enforces).
// Parse / set managed fields / stringify; preserves every other key + BOM.
function applyPrimary(install, primary) {
  if (!primary) return false
  const p = paths(install)
  const rawIn = fs.readFileSync(p.primary, 'utf8')
  const hadBom = rawIn.startsWith('﻿')
  const obj = JSON.parse(rawIn.replace(/^﻿/, ''))
  for (const [section, names] of Object.entries(PRIMARY_MANAGED)) {
    for (const name of names) {
      if (primary[section]?.[name] === undefined) continue
      if (!obj[section]) obj[section] = {}
      obj[section][`${SECTION_PREFIX[section]}::${name}`] = primary[section][name]
    }
  }
  fs.writeFileSync(p.primary, (hadBom ? '﻿' : '') + JSON.stringify(obj, null, '\t'))
  return true
}

// Screen resolution the HUD coordinates are expressed in, from the game's
// GameUserSettings.ini (UE per-user config in LOCALAPPDATA).
function readResolution() {
  const file = path.join(
    process.env.LOCALAPPDATA || '',
    'FPSAimTrainer',
    'Saved',
    'Config',
    'WindowsNoEditor',
    'GameUserSettings.ini'
  )
  const raw = readFileOrNull(file) || ''
  const x = raw.match(/^ResolutionSizeX=(\d+)/m)
  const y = raw.match(/^ResolutionSizeY=(\d+)/m)
  return { x: x ? parseInt(x[1], 10) : 1920, y: y ? parseInt(y[1], 10) : 1080 }
}

// ---- game process -------------------------------------------------------------
function isGameRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq FPSAimTrainer.exe', '/NH'], {
      encoding: 'utf8',
    })
    return /FPSAimTrainer\.exe/i.test(out)
  } catch {
    return false
  }
}

module.exports = {
  WEAPON_KEYS,
  PRIMARY_MANAGED,
  findInstall,
  recentScenariosFromStats,
  readActive,
  readWeapon,
  readPrimary,
  primaryFromTheme,
  listOptions,
  weaponDiffers,
  primaryDiffers,
  applyWeapon,
  applyPrimary,
  applyPalette,
  applyUi,
  readResolution,
  isGameRunning,
  PROXY_THEME,
  writeProxyTheme,
  proxyThemeSelected,
}
