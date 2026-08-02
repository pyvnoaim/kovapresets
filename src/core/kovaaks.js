// Core KovaaK's preset logic. Pure Node (no Electron), reused by main.js and
// unit-testable via selftest.js. Two settings files, and they behave differently
// while the game runs - which dictates the whole apply model:
//
//   weaponsettings.ini  (crosshair + combat sounds)
//       The game RE-READS this on scenario entry, so edits apply LIVE. Plain INI;
//       writes preserve BOM + CRLF and touch only our keys.
//
//       The file has a global block, then optional per-weapon `[name]` sections
//       the game writes when you set a per-weapon override in Game Options ->
//       Weapons -> <weapon>. A section with UseDefaults=false SHADOWS the global
//       block completely for scenarios using that weapon - see weaponGlobalEnd.
//
//   PrimaryUserSettings.json  (theme + event sounds)
//       The game OWNS this in memory and only loads it at launch, so theme edits
//       must land while the game is CLOSED; they take effect next launch. We store
//       the full resolved field set (incl. the material index) captured from the
//       file itself, so applying restores a self-consistent theme.
//
//       It does NOT poll-clobber external edits (verified 2026-07-25: an edit sat
//       untouched for 12s). It rewrites the file from memory on settings
//       interactions - opening the settings screen was enough - so a live edit
//       survives only until the player next touches settings, and is never read
//       back. Don't mistake that write for the game picking the edit up.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { writeFileAtomic } = require('./fsatomic')

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
  // Per-file sens override. Captured and restored so presets preserve whatever
  // the player has, but NOT the route sens presets use: the game ignores these
  // on the scenario-entry reload (verified - see setSensPick). Sens presets go
  // through XSens/YSens in PrimaryUserSettings and apply on the next launch.
  'OverrideSens',
  'HorizontalSens',
  'VerticalSens',
  'SensScale',
  'OverrideSensScaleString',
  'ZoomSensMultiplier',
]

// Compiled once - readWeapon runs on every state poll, applyWeapon on every
// apply, and both need the same line-anchored match per key.
const WEAPON_RE = new Map(WEAPON_KEYS.map((k) => [k, new RegExp(`^${k}=(.*)$`, 'm')]))

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
    saveGames: sg,
    weapon: path.join(sg, 'weaponsettings.ini'),
    primary: path.join(sg, 'PrimaryUserSettings.json'),
    themes: path.join(sg, 'Themes'),
    proxy: path.join(sg, 'Themes', `${PROXY_THEME}.json`),
    crosshairs: path.join(install, 'crosshairs'),
    sounds: path.join(install, 'sounds'),
    // HUD window positions/scales - lives with the other SaveGames files.
    ui: path.join(sg, 'UI.json'),
  }
}

// ---- reading ------------------------------------------------------------------
// Where the global block ends, i.e. the first per-weapon `[name]` section (or EOF).
// Every read/write below is scoped to that slice on purpose: the same keys repeat
// verbatim inside each section, so an unscoped /^Key=/m would silently start
// hitting section values the moment the field order or section count changed.
function weaponGlobalEnd(raw) {
  const m = raw.match(/^\[[^\]\r\n]+\]/m)
  return m ? m.index : raw.length
}

// The file is BOM-prefixed, and a BOM sits BEFORE the first key - so /^Key=/m
// cannot match a key on line 1 (the line starts with U+FEFF, not the letter).
// Today the game happens to write an unmanaged key (TracerVisible) first, which
// is the only reason that has never bitten; it would silently read as "" and
// silently fail to write. Split the BOM off for matching and put it back on write.
const BOM = '﻿'
const splitBom = (raw) =>
  raw.startsWith(BOM) ? { bom: BOM, body: raw.slice(BOM.length) } : { bom: '', body: raw }

// Per-weapon sections that OVERRIDE the global block (UseDefaults=false). These
// are the player's own per-weapon overrides; we never write them, but a preset's
// crosshair/sound/sens will not reach scenarios whose weapon has one, so callers
// surface them rather than letting a preset look silently broken.
function shadowingWeaponSections(install) {
  const p = paths(install)
  if (!fs.existsSync(p.weapon)) return []
  const { body: raw } = splitBom(fs.readFileSync(p.weapon, 'utf8'))
  // Split on line-anchored headers rather than "up to the next [": a VALUE
  // containing a bracket (a sound or crosshair filename can) would otherwise cut
  // a section short and hide its UseDefaults line.
  let current = null
  const bodies = new Map()
  for (const line of raw.slice(weaponGlobalEnd(raw)).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]\r\n]+)\]\s*$/)
    if (header) {
      current = header[1]
      bodies.set(current, [])
    } else if (current) bodies.get(current).push(line)
  }
  const out = []
  for (const [name, lines] of bodies)
    if (!lines.some((l) => /^UseDefaults=true\s*$/.test(l))) out.push(name)
  return out
}

function readWeapon(install) {
  const p = paths(install)
  const { body } = splitBom(fs.existsSync(p.weapon) ? fs.readFileSync(p.weapon, 'utf8') : '')
  const raw = body.slice(0, weaponGlobalEnd(body))
  const out = {}
  for (const k of WEAPON_KEYS) {
    const m = raw.match(WEAPON_RE.get(k))
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

// UI.json is captured/applied as a whole file - it's small,
// self-contained, and has no partial-field semantics worth modelling.
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
function recentScenariosFromStats(install) {
  try {
    const newest = new Map() // scenario -> newest run ts (see statsFileScenario)
    for (const f of fs.readdirSync(path.join(install, 'stats'))) {
      const p = statsFileScenario(f)
      if (p && (!newest.has(p.scenario) || p.ts > newest.get(p.scenario))) newest.set(p.scenario, p.ts)
    }
    return [...newest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([scenario]) => scenario)
  } catch {
    return []
  }
}

// "<scenario> - <mode> - YYYY.MM.DD-HH.MM.SS Stats.csv" -> { scenario, ts }.
// The timestamp is the game's local time; parse it to epoch ms so it compares
// against file mtimes.
function statsFileScenario(filename) {
  const m = String(filename || '').match(
    /^(.*) - .+ - (\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}) Stats\.csv$/
  )
  if (!m) return null
  const [, scenario, y, mo, d, h, mi, s] = m
  return { scenario, ts: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime() }
}

// Full on-disk snapshot: weapon + primary are the preset shape; ui (the raw
// UI.json text) rides along for the HUD editor and baseline capture.
function readActive(install) {
  const p = paths(install)
  return {
    weapon: readWeapon(install),
    primary: readPrimary(install),
    ui: readFileOrNull(p.ui),
  }
}

function applyUi(install, raw) {
  if (raw == null) return false
  const p = paths(install)
  if (readFileOrNull(p.ui) === raw) return false
  writeFileAtomic(p.ui, raw)
  return true
}

// hud:save writes the HUD editor's serialized layout back to the game VERBATIM,
// and a corrupt UI.json breaks the in-game HUD - so the shape is checked at the
// IPC boundary rather than trusting the caller.
const MAX_UI_RAW = 512 * 1024 // the file is a few KB in practice

function validUi(s) {
  if (typeof s !== 'string' || s.length > MAX_UI_RAW) return false
  try {
    return JSON.parse(s) !== null
  } catch {
    return false
  }
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
  return themeToPrimary(t)
}

// Theme-file object -> primary-settings shape (the subset a theme can carry).
function themeToPrimary(t) {
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

// The proxy's name doubles as a readout of which theme it currently mirrors, so
// overlays (and the in-game menu) show something meaningful instead of a bare
// "!KovaPreset". Verified in-game 2026-07-29, and the constraints are tight:
//
//   - The game takes the menu label from the file's `themeName` FIELD, not the
//     filename: a file still called !KovaPreset.json displayed as
//     "!KovaPreset (mirroring test)". So the filename stays fixed forever and
//     only the field moves - no per-preset files, no collisions with the
//     player's own themes, no stale duplicates to sweep up.
//   - That same field is the SELECTION IDENTITY. CurrentThemeName is matched
//     against it, not against the filename. Change one without the other and
//     the match fails: the theme dropdown renders EMPTY and the selection is
//     lost. The two must always move together.
//   - CurrentThemeName lives in PrimaryUserSettings, which the game owns in
//     memory and rewrites from it on any settings interaction - including the
//     menu-open that triggers live theme swap. An external edit while the game
//     runs is therefore erased at the worst possible moment (measured: written
//     19:05:28, clobbered back 19:05:46 on settings-open).
//
// Hence the rule the callers implement: the proxy's NAME only ever changes
// while the game is CLOSED (an apply with no game, or the pending flush at
// quit). While the game runs, applies rewrite the proxy's CONTENTS only and
// leave the name alone - the game re-reads the file it selected at launch, so
// renaming mid-session would break live swap. The cost is that the name is
// accurate at launch and goes stale if you swap presets mid-session: the
// visuals change, the label doesn't. That is a deliberate trade - there is no
// arrangement that gives both, because the selection is bound in memory at
// launch and only disk-before-launch can move it.
const PROXY_SEP = ' - '
// Keep it short: this string is a row in the game's theme dropdown, and the
// mirrored name is already prefixed. Quotes/backslashes need no escaping here -
// it goes out through JSON.stringify - but newlines would wreck the row.
function proxyThemeName(mirrored) {
  let label = String(mirrored || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  // A preset captured while the proxy was already selected carries the proxy's
  // own name. Unwrap it to the theme it mirrors instead of collapsing to the
  // bare name, or re-applying such a preset would silently drop the readout.
  if (label.startsWith(PROXY_THEME + PROXY_SEP)) label = label.slice((PROXY_THEME + PROXY_SEP).length)
  if (!label || label === PROXY_THEME || label === 'KovaPreset') return PROXY_THEME
  return `${PROXY_THEME}${PROXY_SEP}${label.slice(0, 40)}`
}

// Every name the proxy can go by, including the two legacy ones ('KovaPreset'
// predates the '!' prefix). Callers must never test CurrentThemeName against
// PROXY_THEME with ===, or a proxy carrying a mirrored name reads as a foreign
// theme and the whole live-swap path silently disengages.
const isProxyThemeName = (name) =>
  name === PROXY_THEME || name === 'KovaPreset' || String(name || '').startsWith(PROXY_THEME + PROXY_SEP)

// The proxy file's contents in primary-settings shape - what the game is
// actually rendering while the proxy theme is selected. Single fixed-name file
// read (no directory scan), cheap enough for the state poll path.
function readProxyPrimary(install) {
  try {
    return themeToPrimary(JSON.parse(fs.readFileSync(paths(install).proxy, 'utf8')))
  } catch {
    return null
  }
}

// Inverse of primaryFromTheme: build a theme-file object from the preset's
// primary-shaped fields. Only fields the preset actually has are written.
function themeFileFromPrimary(primary, name) {
  const s = primary.stringSettings || {}
  const f = primary.floatSettings || {}
  const i = primary.integerSettings || {}
  const b = primary.booleanSettings || {}
  const v = primary.vectorSettings || {}
  const c = primary.colorSettings || {}
  const t = { themeName: name || PROXY_THEME }
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

// The name the proxy file currently goes by. This is the game's selection key
// while it runs, so a mid-session content rewrite has to carry it forward
// verbatim rather than recomputing it - see the PROXY_THEME notes.
function readProxyName(install) {
  try {
    const t = JSON.parse(fs.readFileSync(paths(install).proxy, 'utf8'))
    if (isProxyThemeName(t.themeName)) return t.themeName
  } catch {
    // fall through
  }
  // No readable proxy (deleted by hand, or a Steam "verify integrity" wiped the
  // Themes folder). Recreating it under the BASE name would break live swap for
  // the rest of the session, because the game is still selecting whatever it
  // read at launch. CurrentThemeName on disk is exactly that: while the game
  // runs it rewrites the file from memory, so it holds the launch-time pick.
  try {
    const selected = readPrimary(install).stringSettings?.CurrentThemeName
    if (isProxyThemeName(selected)) return selected
  } catch {
    // fall through
  }
  return PROXY_THEME
}

// Write the preset's theme into the proxy theme file. Contents are safe to write
// at any time - the game only reads them on menu-open (and at launch when it's
// the selected theme). `name` is NOT: pass the existing readProxyName() while
// the game runs, and the new one only when it's closed.
function writeProxyTheme(install, primary, name) {
  const t = themeFileFromPrimary(primary, name)
  const p = paths(install)
  writeFileAtomic(p.proxy, JSON.stringify(t, null, '\t'))
  // drop the pre-rename proxy so the menu doesn't show a stale duplicate
  try {
    fs.unlinkSync(path.join(p.themes, 'KovaPreset.json'))
  } catch {}
  return p.proxy
}

// Re-label the proxy without touching its visuals - the game-quit flush, where
// the queued CurrentThemeName finally lands and the two have to end up equal.
// Returns false if there's no proxy file yet, so the caller doesn't strand
// CurrentThemeName pointing at a name nothing answers to.
function setProxyThemeName(install, name) {
  const file = paths(install).proxy
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'))
    t.themeName = name || PROXY_THEME
    writeFileAtomic(file, JSON.stringify(t, null, '\t'))
    return true
  } catch {
    return false
  }
}

// Is the proxy currently the selected theme (i.e. is live switching armed)?
function proxyThemeSelected(install) {
  const primary = readPrimary(install)
  return isProxyThemeName(primary.stringSettings?.CurrentThemeName)
}

// ---- sens picks ---------------------------------------------------------------
// Sens goes through PrimaryUserSettings (XSens/YSens), NOT the weaponsettings
// override - so it lands on the game's next launch, exactly like DPI.
//
// Verified in-game (2026-07-25), because the naming strongly suggests otherwise:
// writing OverrideSens=true + HorizontalSens externally does NOTHING, even
// though the game demonstrably re-reads the file. The same write also bumped
// CrosshairScale as a control: on scenario entry the crosshair changed and the
// sens did not. So weaponsettings' scenario-entry reload covers crosshair and
// sounds but not sens - the sens fields are bound at launch and rewritten from
// memory. There is no live route for sens; don't reintroduce one on the strength
// of the field names.
//
// Consequence: OverrideSens must be forced OFF. Left on (older versions of this
// app set it, and a player may have flipped it themselves) the per-weapon
// override wins at launch and silently shadows the XSens we just set, so the
// pick would appear to do nothing. HorizontalSens/VerticalSens are written to
// match purely so the game's weapon-settings UI doesn't show a stale number;
// with the override off they're inert.
//
// The scale must be pinned alongside the value or the same number means a
// different speed. `SensScale` is deliberately left alone: it mirrors the legacy
// SensitivityScaleTargetEnum rather than the modern scale string - the two
// routinely disagree (e.g. "Quake/Source" while the player is on cm/360) - and
// it rides along verbatim from the capture.
function setSensPick(weapon, primary, sens, scale) {
  weapon.OverrideSens = 'false'
  weapon.HorizontalSens = String(sens)
  weapon.VerticalSens = String(sens)
  if (scale) weapon.OverrideSensScaleString = scale
  if (!primary.floatSettings) primary.floatSettings = {}
  primary.floatSettings.XSens = sens
  primary.floatSettings.YSens = sens
  if (scale) {
    if (!primary.stringSettings) primary.stringSettings = {}
    primary.stringSettings.SensScaleString = scale
  }
}

// The scale a sens number should be read in: the preset's own, else the one the
// player currently uses in-game.
const sensScaleOf = (primary, active) =>
  primary?.stringSettings?.SensScaleString || active?.primary?.stringSettings?.SensScaleString || ''

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
  // While the game runs it rewrites PrimaryUserSettings.json from LAUNCH-TIME
  // memory, so its theme fields go stale the moment a preset is applied live -
  // the proxy theme file is what the game is actually rendering. Compare theme
  // fields against that whenever the proxy is the selection, or re-applying the
  // preset the game launched with reads as "nothing changed" and the proxy never
  // gets rewritten, leaving the PREVIOUS preset's theme on screen (and its name
  // queued for the quit flush).
  // Every key the proxy carries is a theme-visual one (themeToPrimary writes
  // nothing else), so key presence is the theme test - sens, DPI and the sound
  // fields have no live route and stay on the settings file. Same for the few
  // theme keys a theme file can't hold (the WallMat/FloorMat indices): absent
  // from the proxy, so they fall through to `cur` as before.
  const proxy = isProxyThemeName(cur.stringSettings?.CurrentThemeName)
    ? readProxyPrimary(install)
    : null
  for (const section of Object.keys(PRIMARY_MANAGED))
    for (const [name, val] of Object.entries(primary[section] || {})) {
      // The selected-theme label is pinned to the proxy on apply, so comparing
      // it would make every preset read as "differs" forever.
      if (name === 'CurrentThemeName') continue
      const ref = proxy && name in (proxy[section] || {}) ? proxy[section] : cur[section]
      if (!eq(val, ref?.[name])) return true
    }
  return false
}

// ---- writing ------------------------------------------------------------------
// Every game-file write goes through writeFileAtomic (core/fsatomic) - the game
// re-reads these files at its own moments (the proxy on menu-open,
// weaponsettings on scenario entry), so a torn write can be read as truncated
// JSON/INI.

// weaponsettings.ini - live. Targeted line replace, formatting preserved.
function applyWeapon(install, weapon) {
  if (!weapon) return false
  const p = paths(install)
  const { bom, body } = splitBom(fs.readFileSync(p.weapon, 'utf8'))
  // Only the global block is ours; per-weapon sections are the player's and are
  // preserved byte-for-byte (they're also what the game reloads for their weapon).
  const end = weaponGlobalEnd(body)
  let raw = body.slice(0, end)
  const tail = body.slice(end)
  const before = raw
  for (const k of WEAPON_KEYS) {
    if (weapon[k] == null) continue
    // single line only (imported presets are untrusted - no ini-line injection),
    // and a function replacement so "$&" in a value isn't expanded by replace()
    const val = String(weapon[k]).replace(/[\r\n]/g, '')
    const re = WEAPON_RE.get(k)
    if (re.test(raw)) raw = raw.replace(re, () => `${k}=${val}`)
  }
  if (raw === before) return false
  writeFileAtomic(p.weapon, bom + raw + tail)
  return true
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
  writeFileAtomic(p.primary, (hadBom ? '﻿' : '') + JSON.stringify(obj, null, '\t'))
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

// ---- health check -------------------------------------------------------------
// Surfaces the silent failure modes: a moved or uninstalled game (findInstall
// goes null mid-session), settings files the app can't write (a read-only folder,
// or KovaaK's reinstalled somewhere it can't touch), a missing/corrupt
// PrimaryUserSettings the theme/DPI writes parse, and live-theme swapping not yet
// armed in-game. Each check is independent and never throws; the overall status
// is the worst single check. probeWrites: actually write+delete a temp file to
// test a folder (reliable on Windows, where accessSync(W_OK) lies about ACLs) -
// the real app does; selftest passes false to stay strictly read-only.
function canWriteDir(dir, probeWrites) {
  try {
    if (!fs.existsSync(dir)) return false
    if (!probeWrites) {
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    }
    const probe = path.join(dir, '.kovapresets-writetest.tmp')
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function checkHealth(install, { probeWrites = true } = {}) {
  const checks = []
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail })

  if (!install) {
    const libs = libraryPaths()
    add(
      'install',
      "KovaaK's install",
      'fail',
      libs.length
        ? `No FPSAimTrainer found via Steam. Searched: ${libs.join('; ')}.`
        : 'No Steam install detected on this PC. Is Steam installed?'
    )
    return { status: 'fail', checks }
  }
  add('install', "KovaaK's install", 'ok', install)

  const p = paths(install)
  const sg = p.saveGames

  const sgOk = canWriteDir(sg, probeWrites)
  add(
    'savegames',
    'Settings folder writable',
    sgOk ? 'ok' : 'fail',
    sgOk
      ? sg
      : `Can't write to ${sg}. Make sure the folder isn't read-only - applies would silently do nothing.`
  )

  const weaponOk = fs.existsSync(p.weapon)
  add(
    'weapon',
    'weaponsettings.ini present',
    weaponOk ? 'ok' : 'fail',
    weaponOk
      ? 'Crosshair and combat sounds write here.'
      : "Missing. Launch KovaaK's once so it writes its settings files."
  )

  let primaryStatus = 'ok'
  let primaryDetail = 'Theme, event sounds, sens and DPI write here.'
  if (!fs.existsSync(p.primary)) {
    primaryStatus = 'fail'
    primaryDetail = "Missing. Launch KovaaK's once so it writes its settings files."
  } else if (readPrimaryObject(install) == null) {
    primaryStatus = 'fail'
    primaryDetail = 'Unreadable JSON - theme and DPI applies would fail against it.'
  }
  add('primary', 'PrimaryUserSettings.json valid', primaryStatus, primaryDetail)

  const themesOk = canWriteDir(p.themes, probeWrites)
  add(
    'themes',
    'Themes folder writable',
    themesOk ? 'ok' : 'warn',
    themesOk
      ? `The ${PROXY_THEME} proxy theme is written here for live theme swaps.`
      : `Can't write to ${p.themes}. Live theme swapping won't work until it is.`
  )

  const proxyFile = p.proxy
  if (proxyThemeSelected(install))
    add(
      'proxy',
      'Live theme swapping',
      'ok',
      `The ${PROXY_THEME} theme is selected in-game - theme presets apply live.`
    )
  else if (fs.existsSync(proxyFile))
    add(
      'proxy',
      'Live theme swapping',
      'warn',
      `Select the ${PROXY_THEME} theme in KovaaK's settings once so theme presets swap live.`
    )
  else
    add(
      'proxy',
      'Live theme swapping',
      'warn',
      "Not set up yet - it arms the first time you apply a theme preset (or from the first-run setup)."
    )

  const rank = { ok: 0, warn: 1, fail: 2 }
  const status = checks.reduce((worst, c) => (rank[c.status] > rank[worst] ? c.status : worst), 'ok')
  return { status, checks }
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
  findInstall,
  paths,
  checkHealth,
  recentScenariosFromStats,
  writeFileAtomic,
  readActive,
  readWeapon,
  readPrimary,
  primaryFromTheme,
  listOptions,
  primaryDiffers,
  setSensPick,
  sensScaleOf,
  applyWeapon,
  applyPrimary,
  applyUi,
  validUi,
  readResolution,
  isGameRunning,
  PROXY_THEME,
  proxyThemeName,
  readProxyPrimary,
  readProxyName,
  writeProxyTheme,
  setProxyThemeName,
  proxyThemeSelected,
  // Exercised only by selftest.js, but they guard real file semantics - keep.
  statsFileScenario,
  weaponDiffers,
  shadowingWeaponSections,
}
