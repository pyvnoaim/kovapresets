// Local preset store - a single JSON file in the app's userData dir. No account,
// no network (that's the v2 Kova-sync layer). A preset is just the values to
// write - weapon + primary, as readActive() returns them - plus an id + name.
const fs = require('node:fs')
const path = require('node:path')
const { writeFileAtomic } = require('./fsatomic')

function storeFile(userDataDir) {
  return path.join(userDataDir, 'presets.json')
}

function load(userDataDir) {
  const f = storeFile(userDataDir)
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    const presets = Array.isArray(data.presets) ? data.presets : []
    // Fields removed feature versions ago (HUD colors/layout and scenario
    // auto-apply lived on presets once) - drop them so old stores don't carry
    // dead weight forever. Persisting the strip is the caller's job (it saves
    // on any change anyway).
    for (const p of presets)
      for (const key of ['palette', 'ui', 'scenarios']) if (key in p) delete p[key]
    return presets
  } catch {
    return []
  }
}

function save(userDataDir, presets) {
  // atomic: this file IS the user's preset collection - a torn write here (app
  // killed mid-save, disk hiccup) would lose every preset at once
  writeFileAtomic(storeFile(userDataDir), JSON.stringify({ presets }, null, 2))
}

// Deterministic-ish id without pulling a uuid dep; Date.now + counter is fine for
// a single-user local list.
let counter = 0
function newId() {
  counter += 1
  return `p_${Date.now().toString(36)}_${counter}`
}

module.exports = { load, save, newId }
