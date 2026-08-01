// Read-only smoke test for the core against the real install. Writes nothing.
// Run: npm run core:test
const assert = require('node:assert')
const k = require('./kovaaks')
const store = require('./presets')

// import validation - pure, runs anywhere (no install needed)
assert.ok(store.validPalette('[Palette]\nColorA=(R=1,G=0,B=0)\n; a comment\n'))
assert.ok(store.validPalette(''))
assert.ok(!store.validPalette('<script>alert(1)</script>'), 'non-ini must be rejected')
assert.ok(!store.validPalette('\x00\x01binary junk'))
assert.ok(!store.validPalette('Key=\x00\x01binary'), 'binary hidden in a value must be rejected')
assert.ok(!store.validPalette('x'.repeat(600 * 1024)), 'oversized must be rejected')
assert.ok(!store.validPalette(null))
assert.ok(store.validUi('{"windows":[]}'))
assert.ok(!store.validUi('not json'))
assert.ok(!store.validUi('null'), 'null parses but carries nothing')
assert.ok(!store.validUi('{'.repeat(600 * 1024)))
console.log('import validation: ok')

// sens picks - pure, no install needed. Sens rides the global XSens/YSens (the
// launch path), NOT the weaponsettings override, which the game ignores on its
// scenario-entry reload - verified in-game, see setSensPick.
{
  const w = {}
  const pr = {}
  k.setSensPick(w, pr, 52, 'cm/360')
  assert.equal(pr.floatSettings.XSens, 52, 'global sens is the only route that works')
  assert.equal(pr.floatSettings.YSens, 52)
  assert.equal(pr.stringSettings.SensScaleString, 'cm/360')
  assert.equal(w.HorizontalSens, '52')
  assert.equal(w.VerticalSens, '52')
  assert.equal(w.OverrideSensScaleString, 'cm/360', 'scale must be pinned, not left stale')
  // the override wins at launch, so leaving it on would shadow the XSens above
  // and make the pick appear to do nothing
  assert.equal(w.OverrideSens, 'false', 'override must be cleared or it shadows global sens')
  // SensScale mirrors the legacy enum and routinely disagrees with the real
  // scale - writing it would reinterpret the number, so it must stay untouched
  assert.ok(!('SensScale' in w), 'legacy SensScale must be left alone')

  // an already-on override must be turned off, not preserved
  const w3 = { OverrideSens: 'true' }
  k.setSensPick(w3, {}, 40, 'cm/360')
  assert.equal(w3.OverrideSens, 'false', 'a pre-existing override must be cleared too')

  // no scale known: still set the value rather than pinning a wrong scale
  const w2 = {}
  const pr2 = {}
  k.setSensPick(w2, pr2, 30, '')
  assert.equal(w2.HorizontalSens, '30')
  assert.equal(pr2.floatSettings.XSens, 30)
  assert.ok(!('OverrideSensScaleString' in w2), 'no scale to pin means leave it as-is')

  // scale resolution: the preset's own wins, else the live one
  assert.equal(k.sensScaleOf({ stringSettings: { SensScaleString: 'in/360' } }, null), 'in/360')
  assert.equal(
    k.sensScaleOf({}, { primary: { stringSettings: { SensScaleString: 'Valorant' } } }),
    'Valorant',
    'an old preset with no scale falls back to the live one'
  )
  assert.equal(k.sensScaleOf(null, null), '')
  console.log('sens picks: ok')
}

// weaponsettings parsing against synthetic files - pure, and the real install
// can't exercise the cases that matter (per-weapon sections, a managed key on
// line 1 behind the BOM). Writes only to a temp dir.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-selftest-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(sg, { recursive: true })
  const file = path2.join(sg, 'weaponsettings.ini')
  const write = (s) => fs2.writeFileSync(file, s)

  // A BOM sits before the first key, so /^Key=/m can't match line 1 unless the
  // BOM is split off first. The real file starts with an unmanaged key, which is
  // the only reason this never showed up as a silent read-of-"" / failed write.
  write('﻿CrosshairFile=global.png\nHorizontalSens=52.0\nOverrideSens=false\n')
  assert.equal(k.readWeapon(root).CrosshairFile, 'global.png', 'must read a managed key on line 1 past the BOM')

  // Per-weapon sections repeat every key, so reads/writes must stay in the
  // global block, and a section must survive a write byte-for-byte.
  write(
    '﻿CrosshairFile=global.png\nHorizontalSens=52.0\nOverrideSens=false\n\n' +
      '[pistol]\nUseDefaults=false\nCrosshairFile=section.png\nHorizontalSens=999.0\n'
  )
  assert.equal(k.readWeapon(root).CrosshairFile, 'global.png', 'must not read a section value')
  assert.equal(k.readWeapon(root).HorizontalSens, '52.0')
  const secBefore = fs2.readFileSync(file, 'utf8').slice(fs2.readFileSync(file, 'utf8').indexOf('[pistol]'))
  assert.equal(k.applyWeapon(root, { CrosshairFile: 'new.png' }), true)
  const after = fs2.readFileSync(file, 'utf8')
  assert.ok(after.startsWith('﻿'), 'BOM must be preserved on write')
  assert.equal(after.slice(after.indexOf('[pistol]')), secBefore, 'per-weapon section must be untouched')
  assert.equal(k.readWeapon(root).CrosshairFile, 'new.png')
  assert.equal(k.applyWeapon(root, { CrosshairFile: 'new.png' }), false, 'a no-op apply must report false')

  // sections that shadow the global block (UseDefaults=false) are reported so the
  // UI can warn; a value containing "[" must not cut a section short
  write(
    '﻿CrosshairFile=a.png\n\n[pistol]\nUseDefaults=true\nCrosshairFile=odd[1].png\n\n' +
      '[LG]\nUseDefaults=false\nCrosshairFile=b.png\n'
  )
  assert.deepEqual(k.shadowingWeaponSections(root), ['LG'], 'only UseDefaults=false sections shadow')
  write('﻿CrosshairFile=a.png\n')
  assert.deepEqual(k.shadowingWeaponSections(root), [], 'no sections -> nothing shadows')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('weaponsettings sections + BOM: ok')
}

// primaryDiffers while the game is on the proxy theme - synthetic install, so it
// can stage the exact mid-session state: the settings file stale on the LAUNCH
// theme (the game rewrites it from launch-time memory) while the proxy file
// holds what a live apply put on screen. Re-applying the launch preset must
// read as a change, or the proxy is never rewritten and the player keeps the
// previous preset's theme (the "going back to the preset I launched with does
// nothing" bug).
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-selftest-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(path2.join(sg, 'Themes'), { recursive: true })
  fs2.writeFileSync(path2.join(sg, 'weaponsettings.ini'), '﻿CrosshairFile=dot.png\n')

  const themeX = { WallColor: [0.1, 0.1, 0.1] }
  const themeA = { WallColor: [0.9, 0, 0] }
  const primaryOf = (theme, name) => ({
    stringSettings: { CurrentThemeName: name },
    floatSettings: { XSens: 0.5 },
    integerSettings: { DPI: 3200 },
    vectorSettings: theme,
  })
  // the on-disk settings file nests managed fields under `<PREFIX>::<name>`
  const PREFIX = {
    stringSettings: 'EStringSettingId',
    floatSettings: 'EFloatSettingId',
    integerSettings: 'EIntegerSettingId',
    vectorSettings: 'EVectorSettingId',
  }
  const writeSettings = (primary) => {
    const out = {}
    for (const [section, fields] of Object.entries(primary)) {
      out[section] = {}
      for (const [name, val] of Object.entries(fields)) out[section][`${PREFIX[section]}::${name}`] = val
    }
    fs2.writeFileSync(path2.join(sg, 'PrimaryUserSettings.json'), JSON.stringify(out, null, '\t'))
  }

  const presetX = primaryOf(themeX, 'X')
  const presetA = primaryOf(themeA, 'A')
  writeSettings(primaryOf(themeX, '!KovaPreset - X')) // stale: still the launch theme
  k.writeProxyTheme(root, presetA, '!KovaPreset - X') // live: the last mid-session apply
  assert.ok(k.proxyThemeSelected(root))
  assert.equal(k.primaryDiffers(root, presetX), true, 'returning to the launch preset must count as a change')
  assert.equal(k.primaryDiffers(root, presetA), false, 're-applying what the proxy renders must be a no-op')
  // non-theme fields have no live route - they still compare against the settings file
  const sensBump = JSON.parse(JSON.stringify(presetA))
  sensBump.floatSettings.XSens = 0.9
  assert.equal(k.primaryDiffers(root, sensBump), true, 'sens still compares against the settings file')
  // off the proxy (or with no proxy file), the settings file decides as before
  writeSettings(primaryOf(themeX, 'SomeRealTheme'))
  assert.equal(k.primaryDiffers(root, presetX), false, 'off-proxy: settings file decides')
  assert.equal(k.primaryDiffers(root, presetA), true)
  fs2.rmSync(path2.join(sg, 'Themes', '!KovaPreset.json'))
  writeSettings(primaryOf(themeX, '!KovaPreset - X'))
  assert.equal(k.primaryDiffers(root, presetX), false, 'proxy selected but file missing: no crash, settings decide')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('primaryDiffers vs proxy theme: ok')
}

// stats-CSV parsing + upcoming-scenario derivation - synthetic install with a
// staged playlist session. upcomingScenario counts the session's finished runs
// (CSVs newer than the playlist load) against each scenario's required plays,
// in list order; off-playlist it falls back to the scenario just played.
{
  const fs2 = require('node:fs')
  const os2 = require('node:os')
  const path2 = require('node:path')

  const p1 = k.statsFileScenario('VT Pasu Advanced S5 - Challenge - 2026.07.29-19.05.28 Stats.csv')
  assert.equal(p1.scenario, 'VT Pasu Advanced S5')
  assert.equal(p1.ts, new Date(2026, 6, 29, 19, 5, 28).getTime(), 'timestamp parses as local time')
  // scenario names can contain " - " themselves; the greedy head must keep it
  const p2 = k.statsFileScenario('A - B - Challenge - 2026.01.02-03.04.05 Stats.csv')
  assert.equal(p2.scenario, 'A - B')
  assert.equal(k.statsFileScenario('not a stats file.csv'), null)

  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kova-selftest-'))
  const sg = path2.join(root, 'Saved', 'SaveGames')
  fs2.mkdirSync(sg, { recursive: true })
  fs2.mkdirSync(path2.join(root, 'stats'), { recursive: true })
  const csv = (scenario, ts) =>
    fs2.writeFileSync(path2.join(root, 'stats', `${scenario} - Challenge - ${ts} Stats.csv`), '')

  // no playlist file at all -> the played scenario is the upcoming one
  csv('Free Play', '2026.07.30-10.00.00')
  assert.equal(k.upcomingScenario(root, 'Free Play'), 'Free Play')

  // playlist: A (1 play), B (2 plays), C (1 play); loaded at 09:00
  fs2.writeFileSync(
    path2.join(sg, 'PlaylistInProgress.json'),
    JSON.stringify({
      playlistName: 'Bench',
      scenarioList: [
        { scenario_name: 'A', play_Count: 1 },
        { scenario_name: 'B', play_Count: 2 },
        { scenario_name: 'C', play_Count: 1 },
      ],
    })
  )
  const loaded = new Date(2026, 6, 30, 9, 0, 0)
  fs2.utimesSync(path2.join(sg, 'PlaylistInProgress.json'), loaded, loaded)

  // a PRE-session CSV of A must not count toward this run-through
  csv('A', '2026.07.30-08.30.00')
  csv('A', '2026.07.30-09.10.00') // A done (1/1)
  assert.equal(k.upcomingScenario(root, 'A'), 'B', 'after A the playlist moves to B')
  csv('B', '2026.07.30-09.20.00') // B 1/2
  assert.equal(k.upcomingScenario(root, 'B'), 'B', 'B needs a second play first')
  csv('B', '2026.07.30-09.30.00') // B 2/2
  assert.equal(k.upcomingScenario(root, 'B'), 'C')
  csv('C', '2026.07.30-09.40.00') // playlist complete
  assert.equal(k.upcomingScenario(root, 'C'), 'C', 'finished playlist: stay on the played scenario')
  // a scenario outside the playlist is just being ground on its own
  assert.equal(k.upcomingScenario(root, 'Free Play'), 'Free Play')

  fs2.rmSync(root, { recursive: true, force: true })
  console.log('playlist upcoming-scenario: ok')
}

const install = k.findInstall()
console.log('install:', install || 'NOT FOUND')
if (!install) process.exit(1)

console.log('game running:', k.isGameRunning())

const active = k.readActive(install)
console.log('\nactive weapon (live: crosshair + combat sounds):')
console.log(JSON.stringify(active.weapon, null, 2))
console.log('\nactive theme name:', active.primary.stringSettings.CurrentThemeName)
console.log('theme fields captured:', Object.values(active.primary).reduce((n, s) => n + Object.keys(s).length, 0))

const opts = k.listOptions(install)
console.log('\noptions available:')
console.log(`  crosshairs: ${opts.crosshairs.length}`)
console.log(`  sounds:     ${opts.sounds.length}`)
console.log(`  themes:     ${opts.themes.length}`)

// change detection against a clone with one tweaked field (no writes)
const clone = JSON.parse(JSON.stringify(active))
clone.weapon.CrosshairFile = 'blank.png'
console.log('\nweaponDiffers vs tweaked clone:', k.weaponDiffers(install, clone.weapon))
console.log('primaryDiffers vs same snapshot:', k.primaryDiffers(install, active.primary))

// health check - probeWrites:false keeps it strictly read-only (accessSync, no
// temp file). Shape + a sane result against the real install.
const health = k.checkHealth(install, { probeWrites: false })
assert.ok(Array.isArray(health.checks) && health.checks.length, 'health returns checks')
assert.ok(['ok', 'warn', 'fail'].includes(health.status), 'health status is valid')
assert.equal(health.checks.find((c) => c.id === 'install').status, 'ok', 'install check ok when found')
const missing = k.checkHealth(null)
assert.equal(missing.status, 'fail', 'null install is a fail')
console.log('\nhealth:', health.status, '-', health.checks.map((c) => `${c.id}:${c.status}`).join(' '))
