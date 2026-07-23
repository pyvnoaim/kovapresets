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
