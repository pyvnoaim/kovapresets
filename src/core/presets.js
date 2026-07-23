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

// ---- import validation --------------------------------------------------------
// Imported presets are the only untrusted input (capture/build/duplicate all
// come from this machine). Their palette/ui are written back to the game
// VERBATIM, so a shared file could otherwise drop arbitrary bytes into
// Palette.ini / UI.json. Content that doesn't still look like what it claims is
// dropped on import - the preset applies fine, it just leaves those two alone.
const MAX_RAW = 512 * 1024 // both files are a few KB in practice

function validUi(s) {
  if (typeof s !== 'string' || s.length > MAX_RAW) return false
  try {
    return JSON.parse(s) !== null
  } catch {
    return false
  }
}

// UE config: section headers, key=value, comments, blanks - nothing else.
const iniLine = (l) =>
  !l.trim() || /^\[.*\]$/.test(l.trim()) || l.trim().startsWith(';') || l.includes('=')
// ponytail: shape check, not a real INI parse - the game is the only consumer
// and it tolerates junk keys. Parse properly only if we ever need to merge
// palettes instead of swapping whole files.
const validPalette = (s) =>
  typeof s === 'string' &&
  s.length <= MAX_RAW &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s) && // no binary payload smuggled in a key=value line
  s.split(/\r?\n/).every(iniLine)

module.exports = { load, save, newId, validUi, validPalette }
