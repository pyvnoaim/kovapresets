// Append-only diagnostic log, one line per event, in the app's userData dir.
// The app's error handling is deliberately swallow-and-retry (a missing game
// file mid-Steam-verify must not crash an apply), which also meant "sens didn't
// apply" reports had nothing to go on. This is the something: every apply,
// flush, restart and auto-switch decision lands here.
//
// Everything is best-effort: logging must never throw into an apply path, and a
// full disk or locked file just means a lost line.
const fs = require('node:fs')
const path = require('node:path')

let file = null
let writesSinceCheck = 0
const MAX_BYTES = 256 * 1024 // two generations of this = worst-case footprint

function rotateIfNeeded() {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.rmSync(`${file}.old`, { force: true })
      fs.renameSync(file, `${file}.old`)
    }
  } catch {
    // no log yet, or it's locked - either way just keep appending
  }
}

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, 'kovapresets.log')
    rotateIfNeeded()
  } catch {
    file = null
  }
}

const fmt = (v) => {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function log(...parts) {
  if (!file) return
  try {
    // re-check size every so often - the app can sit in the tray for weeks
    if (++writesSinceCheck >= 200) {
      writesSinceCheck = 0
      rotateIfNeeded()
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${parts.map(fmt).join(' ')}\n`)
  } catch {}
}

const logPath = () => file

module.exports = { init, log, logPath }
