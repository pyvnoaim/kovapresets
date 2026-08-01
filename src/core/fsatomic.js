// Atomic file writes: write a sibling temp file, then rename it into place.
// Everything the app persists - the game's settings files AND its own stores -
// is read by someone at a moment the app doesn't control (the game re-reads the
// proxy on menu-open, the app re-reads presets.json on every poll), so a bare
// writeFileSync can be caught half-written and read as truncated JSON/INI.
// A same-volume rename is atomic; when the target is briefly locked (the game
// mid-read, AV mid-scan) it throws EPERM/EBUSY, so retry a few times and fall
// back to a direct write - a write that might tear beats one that's lost.
const fs = require('node:fs')

function writeFileAtomic(file, data) {
  const tmp = `${file}.kovatmp`
  fs.writeFileSync(tmp, data)
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch {
      // main-process-safe synchronous sleep (no async callers in the write path)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (i + 1))
    }
  }
  try {
    fs.unlinkSync(tmp)
  } catch {}
  fs.writeFileSync(file, data)
}

module.exports = { writeFileAtomic }
