// Local preset store - a single JSON file in the app's userData dir. No account,
// no network (that's the v2 Kova-sync layer). A preset is just the values to
// write, in readActive()'s shape, plus an id + name.
const fs = require('node:fs')
const path = require('node:path')

function storeFile(userDataDir) {
  return path.join(userDataDir, 'presets.json')
}

function load(userDataDir) {
  const f = storeFile(userDataDir)
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'))
    return Array.isArray(data.presets) ? data.presets : []
  } catch {
    return []
  }
}

function save(userDataDir, presets) {
  fs.writeFileSync(storeFile(userDataDir), JSON.stringify({ presets }, null, 2))
}

// Deterministic-ish id without pulling a uuid dep; Date.now + counter is fine for
// a single-user local list.
let counter = 0
function newId() {
  counter += 1
  return `p_${Date.now().toString(36)}_${counter}`
}

module.exports = { load, save, newId }
