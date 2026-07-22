// Renderer: pure UI over the window.kova IPC bridge (see preload.js). No node,
// no fs - every privileged action round-trips to the main process.
const $ = (sel) => document.querySelector(sel)
let current = null // last state snapshot
let dragReordering = false // true while a preset row is being dragged

// win.removeMenu() + frameless killed Electron's built-in accelerators, so
// reload/devtools have to be restored by hand
window.addEventListener('keydown', async (e) => {
  if ((e.ctrlKey && e.key.toLowerCase() === 'r') || e.key === 'F5') {
    e.preventDefault()
    // reloading nukes unsaved HUD edits - same guard as the editor's Back button
    if (
      !$('#hud-view').classList.contains('hidden') &&
      hud.dirty &&
      !(await appConfirm('Reload and discard your HUD changes?', { okLabel: 'Reload', danger: true }))
    )
      return
    location.reload()
  }
  if (e.key === 'F12') window.kova.toggleDevtools()
})

// ---- theme (system / light / dark), mirrors the website's class mechanism -----
function applyTheme(mode) {
  const root = document.documentElement
  root.classList.toggle('light', mode === 'light')
  root.classList.toggle('dark', mode === 'dark')
  for (const b of document.querySelectorAll('#theme-seg button'))
    b.classList.toggle('on', b.dataset.theme === mode)
  localStorage.setItem('theme', mode)
}
document
  .querySelectorAll('#theme-seg button')
  .forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)))
applyTheme(localStorage.getItem('theme') || 'system')

// ---- small helpers ------------------------------------------------------------
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  )
}
const ICON = {
  pencil:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M10 11v6M14 11v6"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  grip:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  share:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
}

// KovaaK's stores crosshair color as "X=r Y=g Z=b" (0-1). Convert to/from #hex
// for a native <input type=color>.
function colorToHex(cc) {
  const m = String(cc || '').match(/X=([\d.]+)\s+Y=([\d.]+)\s+Z=([\d.]+)/)
  if (!m) return '#ffffff'
  const h = (f) => Math.max(0, Math.min(255, Math.round(parseFloat(f) * 255)))
    .toString(16)
    .padStart(2, '0')
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`
}
function hexToColor(hex) {
  const n = hex.replace('#', '')
  const v = (i) => (parseInt(n.slice(i, i + 2), 16) / 255).toFixed(3)
  return `X=${v(0)} Y=${v(2)} Z=${v(4)}`
}

// ---- popover color picker (vanilla port of the website's ColorPicker) ---------
// One shared fixed-position popover: SV pad + hue slider + hex field. Fixed so
// no row/scroller overflow can clip it. Hue lives in state - it can't be
// derived from a gray/black/white hex and must survive edge drags.
const cpick = (() => {
  const HEX6 = /^#?([0-9a-f]{6})$/i
  function hexToHsv(hex) {
    const m = HEX6.exec(hex || '')
    if (!m) return { h: 0, s: 0.75, v: 0.85 }
    const n = parseInt(m[1], 16)
    const r = ((n >> 16) & 0xff) / 255
    const g = ((n >> 8) & 0xff) / 255
    const b = (n & 0xff) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    let h = 0
    if (d) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
      else if (max === g) h = ((b - r) / d + 2) * 60
      else h = ((r - g) / d + 4) * 60
    }
    return { h, s: max === 0 ? 0 : d / max, v: max }
  }
  function hsvToHex(h, s, v) {
    const f = (n) => {
      const k = (n + h / 60) % 6
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    }
    const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0')
    return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`
  }
  let el, svEl, dotEl, hueEl, hexEl, swatchEl
  let state = null // { anchor, value, hue, onChange }
  function build() {
    el = document.createElement('div')
    el.className = 'color-pop hidden'
    el.innerHTML = `
      <div class="cp-sv"><span class="cp-dot"></span></div>
      <input class="cp-hue" type="range" min="0" max="360" step="1" aria-label="hue" />
      <div class="cp-hexrow"><span class="cp-swatch"></span><input class="cp-hex" maxlength="7" spellcheck="false" aria-label="hex color" /></div>`
    document.body.appendChild(el)
    svEl = el.querySelector('.cp-sv')
    dotEl = el.querySelector('.cp-dot')
    hueEl = el.querySelector('.cp-hue')
    hexEl = el.querySelector('.cp-hex')
    swatchEl = el.querySelector('.cp-swatch')
    const pickSv = (e) => {
      if (!state) return
      const r = svEl.getBoundingClientRect()
      const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      set(hsvToHex(state.hue, s, v))
    }
    svEl.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      svEl.setPointerCapture(e.pointerId)
      pickSv(e)
    })
    svEl.addEventListener('pointermove', (e) => {
      if (e.buttons) pickSv(e)
    })
    hueEl.addEventListener('input', () => {
      if (!state) return
      state.hue = Number(hueEl.value)
      const { s, v } = hexToHsv(state.value)
      set(hsvToHex(state.hue, s, v))
    })
    hexEl.addEventListener('input', () => {
      if (!state) return
      const raw = hexEl.value.trim()
      if (!HEX6.test(raw)) return
      const norm = (raw.startsWith('#') ? raw : `#${raw}`).toLowerCase()
      const { h, s, v } = hexToHsv(norm)
      if (s > 0 && v > 0) state.hue = h
      set(norm, true)
    })
    document.addEventListener('mousedown', (e) => {
      if (state && !el.contains(e.target) && !state.anchor.contains(e.target)) close()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close()
    })
    // the popover is fixed - scrolling the list under it would detach it
    document.addEventListener('scroll', close, true)
  }
  function set(hexVal, fromHexInput) {
    state.value = hexVal
    paint(fromHexInput)
    state.onChange(hexVal)
  }
  function paint(skipHexInput) {
    const { s, v } = hexToHsv(state.value)
    svEl.style.backgroundColor = `hsl(${state.hue} 100% 50%)`
    dotEl.style.left = `${s * 100}%`
    dotEl.style.top = `${(1 - v) * 100}%`
    dotEl.style.background = state.value
    swatchEl.style.background = state.value
    hueEl.value = Math.round(state.hue)
    if (!skipHexInput) hexEl.value = state.value
  }
  function close() {
    if (el) el.classList.add('hidden')
    state = null
  }
  function show(anchor, value, onChange) {
    if (!el) build()
    if (state && state.anchor === anchor) return close() // second click toggles
    state = { anchor, value, hue: hexToHsv(value).h, onChange }
    el.classList.remove('hidden')
    paint()
    const a = anchor.getBoundingClientRect()
    el.style.left = `${Math.min(Math.max(8, a.left), window.innerWidth - el.offsetWidth - 8)}px`
    const below = a.bottom + 8
    el.style.top =
      below + el.offsetHeight > window.innerHeight - 8
        ? `${Math.max(8, a.top - el.offsetHeight - 8)}px`
        : `${below}px`
  }
  return { show, close, isOpen: () => !!state }
})()

// ---- local-file previews ------------------------------------------------------
function fileUrl(...parts) {
  const p = parts.join('/').replace(/\\/g, '/')
  return 'file:///' + encodeURI(p).replace(/#/g, '%23')
}
function crosshairUrl(file) {
  return current?.install ? fileUrl(current.install, 'crosshairs', file) : ''
}
function soundUrl(name) {
  const f = current?.options?.soundFiles?.[name]
  return f && current?.install ? fileUrl(current.install, 'sounds', f) : ''
}

// one shared player so previews never overlap
const previewAudio = new Audio()
function playSound(name) {
  // a preview click is momentary - don't leave the button focus-ringed
  if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
  const url = soundUrl(name)
  if (!url) return toast(`Sound file for "${esc(name)}" not found.`, 'err')
  previewAudio.pause()
  previewAudio.src = url
  previewAudio.currentTime = 0
  previewAudio.play().catch(() => toast('Could not play that sound.', 'err'))
}

// Draw a crosshair PNG tinted the way the game tints it: multiply the pixels
// with the color, keeping the original alpha. Decoded images are cached so
// re-renders don't hit the disk again for the same PNG.
const xhairImgCache = new Map() // url -> Image
function drawCrosshair(canvas, file, colorCC) {
  const url = crosshairUrl(file)
  if (!url) return
  const paint = (img) => {
    const ctx = canvas.getContext('2d')
    const s = Math.min(canvas.width / img.width, canvas.height / img.height, 1)
    const w = img.width * s
    const h = img.height * s
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = colorToHex(colorCC)
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }
  let img = xhairImgCache.get(url)
  if (img && img.complete && img.naturalWidth) return paint(img)
  if (!img) {
    img = new Image()
    xhairImgCache.set(url, img)
    img.src = url
  }
  img.addEventListener('load', () => paint(img), { once: true })
}

// ---- custom confirm (replaces the native OS confirm popup) ---------------------
function appConfirm(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div')
    wrap.className = 'modal-backdrop'
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <p class="modal-msg">${esc(message)}</p>
        <div class="modal-actions">
          <button class="m-cancel">Cancel</button>
          <button class="m-ok${danger ? ' m-danger' : ' primary'}">${esc(okLabel)}</button>
        </div>
      </div>`
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true)
      wrap.remove()
      resolve(v)
    }
    const onKey = (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') done(false)
      if (e.key === 'Enter') done(true)
    }
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) done(false)
    })
    wrap.querySelector('.m-cancel').addEventListener('click', () => done(false))
    wrap.querySelector('.m-ok').addEventListener('click', () => done(true))
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(wrap)
    wrap.querySelector('.m-ok').focus()
  })
}

// ---- help modal -----------------------------------------------------------------
function showHelp() {
  const wrap = document.createElement('div')
  wrap.className = 'modal-backdrop'
  wrap.innerHTML = `
    <div class="modal modal-help" role="dialog" aria-modal="true">
      <h3>How it works</h3>
      <ul>
        <li><b>Presets</b> save your KovaaK's look &amp; sound: crosshair, theme, sounds, HUD, sens. Applying writes the game's own settings files.</li>
        <li><b>Going live:</b> crosshair, sounds and scenario sens apply on the next scenario load. Theme: open the game's settings once. The rest lands when the game quits or starts.</li>
        <li><b>Once:</b> select the <b>!KovaPreset</b> theme in-game so themes can swap live.</li>
        <li><b>Re-enter now</b> reloads your scenario via Steam so changes kick in. The run auto-starts, press your reset bind when ready.</li>
        <li><b>Hotkeys</b> (bolt icon) work even in-game, and stay alive in the tray when you close the window.</li>
        <li><b>Restore original setup</b> reverts everything back to before KovaPresets.</li>
        <li><b>One rule:</b> while a preset is applied, change these settings here, not in KovaaK's, or the game overwrites them.</li>
      </ul>
      <div class="modal-actions"><button class="m-ok primary">Got it</button></div>
    </div>`
  const done = () => {
    document.removeEventListener('keydown', onKey, true)
    wrap.remove()
  }
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.stopPropagation()
      done()
    }
  }
  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) done()
  })
  wrap.querySelector('.m-ok').addEventListener('click', done)
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(wrap)
  wrap.querySelector('.m-ok').focus()
}

// action = { label, run }: renders a button inside the toast (e.g. "Re-enter now")
function toast(msg, kind = '', ms = 3600, action = null) {
  const el = $('#toast')
  el.className = `toast ${kind}`
  el.innerHTML = msg
  if (action) {
    const btn = document.createElement('button')
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      el.classList.add('hidden')
      action.run()
    })
    el.appendChild(btn)
  }
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

// short display accessors - tolerant of both the nested snapshot shape and the
// older flat one so presets captured before the refactor still read.
const themeName = (snap) =>
  snap?.primary?.stringSettings?.CurrentThemeName || snap?.primary?.CurrentThemeName || ''
const crosshair = (snap) => snap?.weapon?.CrosshairFile || ''
// display-only: "OPDot.png" reads better as "OPDot" (files keep the extension)
const noExt = (f) => String(f || '').replace(/\.[a-z0-9]+$/i, '')
const bodyHit = (snap) => snap?.weapon?.BodyHitSound || ''
// effective sens: the weapon-file override when on (live per scenario), else
// the global settings value
const sensOf = (snap) => {
  const w = snap?.weapon || {}
  if (String(w.OverrideSens).toLowerCase() === 'true' && w.HorizontalSens != null)
    return { value: w.HorizontalSens, scale: w.SensScale || '', override: true }
  const x = snap?.primary?.floatSettings?.XSens
  if (x == null) return null
  return { value: x, scale: snap?.primary?.stringSettings?.SensScaleString || '', override: false }
}

// Is preset P exactly what's active now? (every field the preset specifies matches;
// CurrentThemeName is excluded - the live-switch proxy pins it to "KovaPreset")
// Numbers compare with an epsilon: the game rewrites its settings file with its
// own float formatting on relaunch (0.77 vs 0.7699999809265137), and that drift
// must not read as "different preset".
function sameVal(a, b) {
  const num = (v) =>
    typeof v === 'number'
      ? v
      : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))
        ? Number(v)
        : null
  const na = num(a)
  const nb = num(b)
  if (na != null && nb != null) return Math.abs(na - nb) < 1e-4
  return JSON.stringify(a) === JSON.stringify(b)
}
// Only THEME-VISUAL fields decide theme identity - sounds/sens/DPI also live
// in primary, and a one-point sens difference must not flip the theme label.
const NON_THEME_KEY =
  /Sound$|Pitch$|Volume$|^XSens$|^YSens$|^DPI$|^SensScaleString$|^SensitivityScaleTargetEnum$/

// While the game runs it rewrites PrimaryUserSettings.json from launch-time
// memory, so the settings file's theme fields go stale the moment a preset is
// applied live. The proxy theme FILE (!KovaPreset.json) is what the game
// actually renders - when the game is on the proxy, compare theme-visual keys
// against it, and skip the few keys a theme file can't carry (WallMat/FloorMat
// indices, two booleans) instead of comparing them against stale settings.
function primaryMatches(preset, active, themeOnly) {
  const raw = active.primary?.stringSettings?.CurrentThemeName || ''
  const proxy =
    (raw === '!KovaPreset' || raw === 'KovaPreset') && current?.proxyPrimary
      ? current.proxyPrimary
      : null
  for (const section of Object.keys(preset.primary || {})) {
    if (!section.match(/Settings$/)) continue
    for (const [key, val] of Object.entries(preset.primary[section] || {})) {
      if (key === 'CurrentThemeName') continue
      const themeKey = !NON_THEME_KEY.test(key)
      if (themeOnly && !themeKey) continue
      if (proxy && themeKey) {
        if (!(key in (proxy[section] || {}))) continue
        if (!sameVal(val, proxy[section][key])) return false
      } else if (!sameVal(val, active.primary?.[section]?.[key])) return false
    }
  }
  return true
}

function isActive(preset, active) {
  for (const k of Object.keys(preset.weapon || {}))
    if (!sameVal(preset.weapon[k] ?? '', active.weapon?.[k] ?? '')) return false
  return primaryMatches(preset, active, false)
}

// Quiet meta line under the name: theme · crosshair file · hit sound (+ play).
// The crosshair PREVIEW lives in the tile at the row start, not here.
function summaryHtml(preset) {
  const parts = []
  const sndChip = (label, name) =>
    `<span class="sm-val sm-sound"><span class="sm-k">${label}</span><span class="sm-name">${esc(name)}</span></span>`
  if (themeName(preset)) parts.push(`<span class="sm-val">${esc(themeName(preset))}</span>`)
  if (crosshair(preset)) {
    const scale = parseFloat(preset.weapon?.CrosshairScale)
    const scaleTag =
      scale && scale !== 1 ? ` <span class="sm-k">${esc(String(scale))}x</span>` : ''
    parts.push(`<span class="sm-val">${esc(noExt(crosshair(preset)))}${scaleTag}</span>`)
  }
  const sens = sensOf(preset)
  if (sens)
    parts.push(
      `<span class="sm-val"><span class="sm-k">sens</span>${esc(Math.round(Number(sens.value) * 100) / 100)}</span>`
    )
  const dpi = preset.primary?.integerSettings?.DPI
  if (dpi != null) parts.push(`<span class="sm-val"><span class="sm-k">dpi</span>${esc(dpi)}</span>`)
  if (bodyHit(preset)) parts.push(sndChip('hit', bodyHit(preset)))
  const kill = preset.primary?.stringSettings?.KillConfirmedSound
  if (kill) parts.push(sndChip('kill', kill))
  // spawn sound deliberately not chipped - it's in the hover tooltip + editor
  if (!parts.length) return '<span class="sm-empty">no changes</span>'
  return parts.join('<span class="sm-sep">·</span>')
}

// Plain-text version of the same summary - the row's hover tooltip, so chips
// clipped off the one-line summary are still readable.
function summaryText(preset) {
  const parts = []
  if (themeName(preset)) parts.push(themeName(preset))
  if (crosshair(preset)) parts.push(noExt(crosshair(preset)))
  const sens = sensOf(preset)
  if (sens) parts.push(`sens ${Math.round(Number(sens.value) * 100) / 100}`)
  const dpi = preset.primary?.integerSettings?.DPI
  if (dpi != null) parts.push(`dpi ${dpi}`)
  if (bodyHit(preset)) parts.push(`hit ${bodyHit(preset)}`)
  const kill = preset.primary?.stringSettings?.KillConfirmedSound
  if (kill) parts.push(`kill ${kill}`)
  const spawn = preset.primary?.stringSettings?.SpawnSound
  if (spawn) parts.push(`spawn ${spawn}`)
  return parts.join(' · ')
}

// ---- render -------------------------------------------------------------------
// The game's selected theme is pinned to the "!KovaPreset" proxy, so its label is
// meaningless to the user - resolve the real theme name from whichever preset
// matches the active state (theme fields, not the label).
function activeThemeLabel(active, presets) {
  const raw = active.primary?.stringSettings?.CurrentThemeName || ''
  if (raw !== '!KovaPreset' && raw !== 'KovaPreset') return { name: raw, liveSwap: false }
  const match = (presets || []).find((p) => primaryMatches(p, active, true))
  // liveSwap: the game is on the proxy theme, so theme applies swap without a
  // game restart (shown as a sub-line, not glued to the name)
  const real = match ? themeName(match) : ''
  return { name: real || 'custom', liveSwap: true }
}

function renderActive(active) {
  const w = active.weapon
  const s = active.primary?.stringSettings || {}
  const f = active.primary?.floatSettings || {}
  const round2 = (v) => Math.round(v * 100) / 100
  const theme = activeThemeLabel(active, current?.presets)
  const sens = sensOf(active)
  const dpi = active.primary?.integerSettings?.DPI
  const hitBits = []
  if (f.HitPitch != null) hitBits.push(`pitch ${round2(f.HitPitch)}`)
  if (f.HitVolume != null) hitBits.push(`volume ${round2(f.HitVolume)}`)
  $('#active').innerHTML = `
    <div class="stat">
      <div class="label">Theme</div>
      <div class="value">${esc(theme.name) || '-'}</div>
      ${theme.liveSwap ? '<div class="sub" data-tip="The game runs the !KovaPreset proxy theme, so theme changes apply without restarting - just open settings once">live swap on</div>' : ''}
    </div>
    <div class="stat">
      <div class="label">Crosshair</div>
      <div class="value">${esc(noExt(w.CrosshairFile)) || '-'}</div>
      <div class="sub">scale ${esc(w.CrosshairScale) || '1.0'}</div>
    </div>
    <div class="stat">
      <div class="label">Hit sound</div>
      <div class="value">${esc(w.BodyHitSound) || '-'}</div>
      ${hitBits.length ? `<div class="sub">${hitBits.join(' · ')}</div>` : ''}
    </div>
    <div class="stat">
      <div class="label">Kill / spawn</div>
      <div class="value">${esc(s.KillConfirmedSound) || '-'}</div>
      <div class="sub">${esc(s.SpawnSound) || '-'}</div>
    </div>
    <div class="stat">
      <div class="label">Sens / DPI</div>
      <div class="value">${sens ? `${esc(round2(Number(sens.value)))} ${esc(sens.scale)}` : '-'}</div>
      <div class="sub">${[dpi != null ? `DPI ${esc(dpi)}` : '', sens?.override ? 'scenario override' : ''].filter(Boolean).join(' · ') || '&nbsp;'}</div>
    </div>`
}

function renderPresets(presets, active) {
  const wrap = $('#presets')
  wrap.innerHTML = ''
  $('#preset-count').textContent = presets.length ? `${presets.length}` : ''
  $('#empty').classList.toggle('hidden', presets.length > 0)

  for (const preset of presets) {
    const activeNow = isActive(preset, active)
    const row = document.createElement('div')
    row.className = 'preset' + (activeNow ? ' active-preset' : '')
    row.dataset.id = preset.id
    row.innerHTML = `
      <div class="grip" data-tip="Drag to reorder">${ICON.grip}</div>
      <div class="tile">
        <canvas class="xprev" width="44" height="44"></canvas>
        <button type="button" class="xcolor tile-color" data-tip="Crosshair color" aria-label="Crosshair color"><span class="cp-mini" style="background:${colorToHex(preset.weapon?.CrosshairColor)}"></span></button>
      </div>
      <div class="info tip-wrap"${summaryText(preset) ? ` data-tip="${esc(summaryText(preset))}"` : ''}>
        <label class="name-field" data-tip="Click to rename">
          <input class="name" value="${esc(preset.name)}" spellcheck="false" aria-label="Preset name" />
        </label>
        <div class="summary">${summaryHtml(preset)}</div>
      </div>
      <div class="actions">
        <button class="edit quiet" data-tip="Edit" aria-label="Edit preset">${ICON.pencil}</button>
        <button class="dup quiet" data-tip="Duplicate" aria-label="Duplicate preset">${ICON.copy}</button>
        <button class="exp quiet" data-tip="Export to a file (share it)" aria-label="Export preset">${ICON.share}</button>
        <button class="del quiet" data-tip="Delete" aria-label="Delete preset">${ICON.trash}</button>
        <button class="hotkey${preset.hotkey ? ' has-key' : ''}" data-tip="${preset.hotkey ? `${esc(preset.hotkey)} - click to change, Backspace clears` : 'Set global hotkey'}">
          ${preset.hotkey ? esc(preset.hotkey) : ICON.key}
        </button>
        <button class="apply ${activeNow ? 'is-active' : 'primary'}" ${activeNow ? 'disabled' : ''}>
          ${activeNow ? ICON.check + 'Active' : 'Apply'}
        </button>
      </div>`

    const input = row.querySelector('.name')
    const commit = async () => {
      const name = input.value.trim() || 'Untitled'
      input.value = name
      await window.kova.rename(preset.id, name)
      preset.name = name
    }
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
    })

    const xprev = row.querySelector('.xprev')
    if (xprev) drawCrosshair(xprev, crosshair(preset), preset.weapon?.CrosshairColor)

    const colorBtn = row.querySelector('.xcolor')
    if (colorBtn) {
      let commitTimer
      colorBtn.addEventListener('click', () => {
        cpick.show(colorBtn, colorToHex(preset.weapon?.CrosshairColor), (hexVal) => {
          // live preview on the row; the store write is debounced, and there's
          // no re-render here - it would tear the open popover out of the DOM
          const cc = hexToColor(hexVal)
          preset.weapon.CrosshairColor = cc
          colorBtn.firstElementChild.style.background = hexVal
          if (xprev) drawCrosshair(xprev, crosshair(preset), cc)
          clearTimeout(commitTimer)
          commitTimer = setTimeout(async () => {
            current.presets = await window.kova.updateWeapon(preset.id, { CrosshairColor: cc })
          }, 250)
        })
      })
    }
    row.querySelector('.edit').addEventListener('click', () => openEditor(preset))

    row.querySelector('.hotkey').addEventListener('click', (e) => recordHotkey(preset, e.currentTarget))
    row.querySelector('.dup').addEventListener('click', async () => {
      current.presets = await window.kova.duplicate(preset.id)
      renderPresets(current.presets, current.active)
    })
    row.querySelector('.exp').addEventListener('click', async () => {
      const res = await window.kova.exportPresets(preset.id)
      if (res.ok) toast('Preset exported - send the file to anyone with KovaPresets.', 'ok')
      else if (!res.canceled) toast(esc(res.error || 'Export failed.'), 'err')
    })
    const applyBtn = row.querySelector('.apply')
    if (!activeNow) applyBtn.addEventListener('click', () => applyPreset(preset))
    row.querySelector('.del').addEventListener('click', async () => {
      current.presets = await window.kova.remove(preset.id)
      renderPresets(current.presets, current.active)
    })

    // drag to reorder - pointer-based (HTML5 DnD flickers and misfires here).
    // The slot is recomputed from row midpoints on every move (idempotent, so
    // it can't oscillate), displaced rows FLIP-animate into place, and the
    // refresh poll is paused so a background re-render can't duplicate the
    // held row mid-drag.
    const grip = row.querySelector('.grip')
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      dragReordering = true
      row.classList.add('dragging')
      // :active on the grip dies when the row is re-inserted mid-drag - pin the
      // grabbing cursor globally until the pointer is released
      document.body.classList.add('row-dragging')
      const rows = () => [...wrap.querySelectorAll('.preset')]
      const move = (ev) => {
        const target = rows().find(
          (el) => el !== row && ev.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2
        )
        if (target === row.nextElementSibling || (!target && row === wrap.lastElementChild)) return
        const before = new Map(rows().map((el) => [el, el.getBoundingClientRect().top]))
        if (target) wrap.insertBefore(row, target)
        else wrap.appendChild(row)
        for (const [el, top] of before) {
          if (el === row) continue
          const d = top - el.getBoundingClientRect().top
          if (d)
            el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], {
              duration: 130,
              easing: 'ease-out',
            })
        }
      }
      const finish = async () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        row.classList.remove('dragging')
        document.body.classList.remove('row-dragging')
        dragReordering = false
        current.presets = await window.kova.reorder(rows().map((el) => el.dataset.id))
        renderPresets(current.presets, current.active)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    })
    wrap.appendChild(row)
  }
}

// Click the hotkey chip, press a combo; Esc cancels, Backspace/Delete clears.
function recordHotkey(preset, chip) {
  chip.textContent = 'press keys…'
  chip.classList.add('recording')
  const onKey = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return cleanup()
    if (e.key === 'Backspace' || e.key === 'Delete') {
      current.presets = await window.kova.setHotkey(preset.id, null)
      cleanup()
      renderPresets(current.presets, current.active)
      return
    }
    // need a real main key, not a bare modifier
    const main = normalizeKey(e)
    if (!main) return
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
    if (!mods.length && !/^F\d+$/.test(main)) {
      toast('Use a modifier (Ctrl/Alt/Shift) or an F-key, so typing elsewhere stays safe.', 'warn')
      return
    }
    const accel = [...mods, main].join('+')
    current.presets = await window.kova.setHotkey(preset.id, accel)
    cleanup()
    renderPresets(current.presets, current.active)
    toast(`Hotkey <b>${esc(accel)}</b> set - works anywhere, even in-game.`, 'ok')
  }
  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true)
    renderPresets(current.presets, current.active)
  }
  window.addEventListener('keydown', onKey, true)
}

function normalizeKey(e) {
  const k = e.key
  if (/^F\d{1,2}$/.test(k)) return k
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase()
  if (/^[0-9]$/.test(k)) return k
  return null
}

async function reenterScenario() {
  const res = await window.kova.restartScenario()
  if (res.ok)
    toast(
      `Re-entering <b>${esc(res.scenario)}</b>${res.hopped ? ' (brief detour so the game reloads it)' : ''} - new crosshair & sounds load with it. The run starts right away, hit your reset bind when ready.`,
      'ok',
      6500
    )
  else toast(esc(res.error || "Couldn't re-enter the scenario."), 'err')
}

async function applyPreset(preset) {
  try {
    const { weaponChanged, theme, running } = await window.kova.apply(preset)
    await refresh()
    // while the game runs, offer the one-tap re-enter right on the toast
    const reenter = weaponChanged && running ? { label: 'Re-enter now', run: reenterScenario } : null
    const live = weaponChanged ? 'Crosshair & sounds are live - re-enter your scenario.' : ''
    if (theme === 'live') {
      toast(`${live} <b>Theme: open KovaaK's settings once and it applies.</b>`.trim(), 'ok', 6500, reenter)
    } else if (theme === 'arming') {
      toast(
        `${live} Theme is staged - <b>select the "!KovaPreset" theme (top of KovaaK's theme list) once</b>; after that, theme changes apply when you open settings.`.trim(),
        'warn',
        8000,
        reenter
      )
    } else if (theme === 'queued') {
      toast(`${live} Layout/palette changes apply when you quit KovaaK's.`.trim(), 'warn', 6000, reenter)
    } else if (theme === 'applied') {
      toast(`Applied. ${live || "Theme is set for your next KovaaK's launch."}`.trim(), 'ok', 3600, reenter)
    } else if (weaponChanged) {
      toast(live, 'ok', 5000, reenter)
    } else {
      toast('Already active - nothing to change.', 'ok')
    }
  } catch (err) {
    toast(esc(String(err.message || err)), 'err')
  }
}

let lastRenderSig = ''
async function refresh(rescan) {
  // Don't re-render under an open builder/editor - it closes native popups
  // (this is what made the dropdowns unscrollable) and can eat typed input.
  if (!$('#builder').classList.contains('hidden')) return
  if (document.querySelector('#hud-view:not(.hidden)')) return
  if (dragReordering) return
  if (cpick.isOpen()) return // a re-render would tear out the popover's anchor
  current = await window.kova.state(rescan ? { rescan: true } : undefined)
  const pill = $('#game-pill')
  if (!current.install) {
    $('#not-found').classList.remove('hidden')
    $('#content').classList.add('hidden')
    pill.textContent = "KovaaK's: not found"
    pill.className = 'pill pill-off'
    lastRenderSig = ''
    return
  }
  $('#not-found').classList.add('hidden')
  $('#content').classList.remove('hidden')
  pill.textContent = current.gameRunning ? "KovaaK's: running" : "KovaaK's: closed"
  pill.className = 'pill ' + (current.gameRunning ? 'pill-on' : 'pill-off')
  $('#launch').classList.toggle('hidden', current.gameRunning)
  $('#deactivate').classList.toggle('hidden', !current.canRestore)
  // Skip the expensive re-render (all rows rebuilt, crosshair canvases redrawn)
  // when nothing it draws from actually changed - most 5s ticks. Also keeps a
  // mid-rename name input from losing focus to the poll.
  const sig = JSON.stringify([current.active, current.presets, current.pending, current.install])
  if (!rescan && sig === lastRenderSig) return
  lastRenderSig = sig
  // capturing a setup that's already saved would only create a duplicate
  const alreadySaved = (current.presets || []).some((p) => isActive(p, current.active))
  const cap = $('#capture')
  cap.disabled = alreadySaved
  cap.dataset.tip = alreadySaved ? 'Already saved as a preset' : 'Save this setup as a preset'
  renderActive(current.active)
  renderPresets(current.presets, current.active)
}

$('#capture').addEventListener('click', async () => {
  const name = `Preset ${(current?.presets?.length || 0) + 1}`
  current.presets = await window.kova.capture(name)
  renderPresets(current.presets, current.active)
  toast('Captured your current setup. Click a name to rename it.', 'ok')
})

// ---- preset builder -----------------------------------------------------------
const builder = $('#builder')

// Custom combobox: our own filtered, scrollable dropdown under a text input.
// (Electron doesn't render native <datalist> popups, and its <select> popups
// misbehave, so we own the whole thing.)
function makeCombo(input, getList, renderItem) {
  const wrap = input.parentElement // the .field label
  wrap.classList.add('combo')
  const list = document.createElement('div')
  list.className = 'combo-list hidden'
  wrap.appendChild(list)
  let filtered = []
  let idx = -1

  const render = () => {
    list.innerHTML =
      filtered
        .map(
          (o, i) =>
            `<div class="combo-item${i === idx ? ' focus' : ''}" data-v="${esc(o)}">${renderItem ? renderItem(o) : ''}${esc(o)}</div>`
        )
        .join('') || '<div class="combo-empty">no matches</div>'
    list.classList.remove('hidden')
    list.querySelector('.focus')?.scrollIntoView({ block: 'nearest' })
  }
  const open = () => {
    const q = input.value.trim().toLowerCase()
    filtered = getList().filter((o) => o.toLowerCase().includes(q))
    idx = -1
    render()
  }
  const close = () => list.classList.add('hidden')
  const pickFocused = () => {
    if (idx >= 0 && filtered[idx] != null) {
      input.value = filtered[idx]
      close()
    }
  }

  input.addEventListener('focus', open)
  input.addEventListener('input', open)
  input.addEventListener('blur', () => setTimeout(close, 120)) // let clicks land
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      open()
      return e.preventDefault()
    }
    if (e.key === 'ArrowDown') {
      idx = Math.min(idx + 1, filtered.length - 1)
      render()
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      idx = Math.max(idx - 1, 0)
      render()
      e.preventDefault()
    } else if (e.key === 'Enter') {
      pickFocused()
      e.preventDefault()
    } else if (e.key === 'Escape') {
      close()
    }
  })
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combo-item')
    if (item) {
      input.value = item.dataset.v
      close()
      e.preventDefault()
    }
  })
}

makeCombo($('#b-theme'), () => current?.options?.themes || [])
makeCombo(
  $('#b-crosshair'),
  () => current?.options?.crosshairs || [],
  (o) => `<img class="combo-ximg" src="${crosshairUrl(o)}" loading="lazy" alt="" />`
)
makeCombo($('#b-sound'), () => current?.options?.sounds || [])
makeCombo($('#b-killsound'), () => current?.options?.sounds || [])

// The builder doubles as the preset editor: editingPresetId null = create mode
// (placeholders show the ACTIVE setup, "leave empty keeps current"), an id =
// edit mode (placeholders show the PRESET's values, empty keeps them).
let editingPresetId = null
let builderColorTouched = false // edit mode: only send a color the user picked

function populateBuilder(preset) {
  if (!current?.options) return
  editingPresetId = preset ? preset.id : null
  const src = preset || current.active
  const themeLabel = preset
    ? themeName(preset)
    : activeThemeLabel(current.active, current.presets).name
  $('#b-theme').placeholder = `keep current (${themeLabel || 'none'})`
  $('#b-crosshair').placeholder = `keep current (${noExt(crosshair(src)) || 'none'})`
  $('#b-sound').placeholder = `keep current (${bodyHit(src) || 'none'})`
  const curSens = sensOf(src)
  $('#b-sens').placeholder =
    `keep current (${curSens ? Math.round(Number(curSens.value) * 100) / 100 : 'none'})`
  $('#b-dpi').placeholder = `keep current (${src.primary?.integerSettings?.DPI ?? 'none'})`
  const hex = colorToHex(src?.weapon?.CrosshairColor)
  builderColorTouched = false
  $('#b-color').dataset.value = hex
  $('#b-color').firstElementChild.style.background = hex
  $('#b-color-hex').textContent = hex
  $('#b-name').value = preset ? preset.name : ''
  $('#b-theme').value = ''
  $('#b-sens').value = ''
  $('#b-dpi').value = ''
  $('#b-crosshair').value = ''
  $('#b-sound').value = ''
  $('#b-killsound').value = ''
  $('#b-create').textContent = preset ? 'Save changes' : 'Create preset'
  $('#b-note').textContent = preset
    ? 'Empty fields keep the preset as it is. Palette and HUD layout stay untouched.'
    : 'Palette, HUD layout, and pitch/volume settings are carried over from your current setup. Sens uses your current sens scale; DPI applies on the game\'s next launch.'
}

function openEditor(preset) {
  populateBuilder(preset)
  builder.classList.remove('hidden')
  $('#b-name').focus()
}

$('#toggle-builder').addEventListener('click', () => {
  const show = builder.classList.contains('hidden') || editingPresetId != null
  if (show) populateBuilder()
  builder.classList.toggle('hidden', !show)
})
$('#b-cancel').addEventListener('click', () => {
  editingPresetId = null
  builder.classList.add('hidden')
})
$('#b-color').addEventListener('click', () => {
  const btn = $('#b-color')
  cpick.show(btn, btn.dataset.value || '#ffffff', (hexVal) => {
    builderColorTouched = true
    btn.dataset.value = hexVal
    btn.firstElementChild.style.background = hexVal
    $('#b-color-hex').textContent = hexVal
  })
})
$('#b-create').addEventListener('click', async () => {
  const opts = current?.options
  // a typed value must exactly match an installed option (empty = keep current)
  const pick = (id, list, label) => {
    const v = $(id).value.trim()
    if (!v) return null
    if (!list.includes(v)) throw new Error(`"${v}" is not an installed ${label}`)
    return v
  }
  const numPick = (id, label, integer) => {
    const v = $(id).value.trim()
    if (!v) return null
    const n = Number(v)
    if (Number.isNaN(n) || n <= 0 || (integer && !Number.isInteger(n)))
      throw new Error(`"${v}" isn't a valid ${label}`)
    return n
  }
  let picks
  try {
    picks = {
      name:
        $('#b-name').value.trim() ||
        (editingPresetId ? null : `Preset ${(current?.presets?.length || 0) + 1}`),
      theme: pick('#b-theme', opts.themes, 'theme'),
      crosshair: pick('#b-crosshair', opts.crosshairs, 'crosshair'),
      // edit mode: an untouched picker sends nothing, so a preset with no
      // color of its own doesn't silently gain the seeded white
      crosshairColor:
        editingPresetId && !builderColorTouched
          ? null
          : hexToColor($('#b-color').dataset.value || '#ffffff'),
      bodyHit: pick('#b-sound', opts.sounds, 'sound'),
      killSound: pick('#b-killsound', opts.sounds, 'sound'),
      sens: numPick('#b-sens', 'sens', false),
      dpi: numPick('#b-dpi', 'DPI', true),
    }
  } catch (err) {
    return toast(esc(err.message), 'err')
  }
  if (editingPresetId) {
    current.presets = await window.kova.updatePreset(editingPresetId, picks)
    editingPresetId = null
    toast('Preset updated.', 'ok')
  } else {
    current.presets = await window.kova.build(picks)
    toast('Preset created.', 'ok')
  }
  renderPresets(current.presets, current.active)
  builder.classList.add('hidden')
})
$('#refresh').addEventListener('click', () => refresh(true)) // manual = full re-scan
$('#help').addEventListener('click', showHelp)
$('#win-min').addEventListener('click', () => window.kova.winMinimize())
$('#win-close').addEventListener('click', () => window.kova.winClose())
$('#launch').addEventListener('click', async () => {
  await window.kova.launchGame()
  toast("Launching KovaaK's via Steam…", 'ok')
})
$('#import').addEventListener('click', async () => {
  const res = await window.kova.importPresets()
  if (res.ok) {
    current.presets = res.presets
    renderPresets(current.presets, current.active)
    toast(`Imported ${res.count} preset${res.count === 1 ? '' : 's'}.`, 'ok')
  } else if (!res.canceled) {
    toast(esc(res.error || 'Import failed.'), 'err')
  }
})

// ---- settings (auto re-enter) ---------------------------------------------------
async function loadSettingsUi() {
  const s = await window.kova.getSettings()
  $('#auto-restart').checked = !!s.autoRestart
  $('#restart-key-note').textContent =
    'Re-entering relaunches your last-played scenario through Steam, the same way play links on the web do.'
}
$('#auto-restart').addEventListener('change', async (e) => {
  await window.kova.setSettings({ autoRestart: e.target.checked })
  toast(
    e.target.checked
      ? 'Hotkey applies will now restart your scenario automatically.'
      : 'Auto re-enter turned off.',
    'ok'
  )
})
loadSettingsUi()
$('#deactivate').addEventListener('click', async () => {
  const res = await window.kova.deactivate()
  await refresh()
  if (!res.ok) return toast(esc(res.error || 'Nothing to restore.'), 'warn')
  toast(
    res.queued
      ? "Original setup restored. Theme/layout finish restoring when you quit KovaaK's; crosshair & sounds are already back."
      : 'Original setup restored - everything is as it was before KovaPresets.',
    'ok'
  )
})
$('#b-sound-play').addEventListener('click', () => playSound($('#b-sound').value.trim() || bodyHit(current?.active)))
$('#b-killsound-play').addEventListener('click', () =>
  playSound($('#b-killsound').value.trim() || current?.active?.primary?.stringSettings?.KillConfirmedSound)
)
window.kova.onChanged(() => refresh()) // queued changes landed after the game quit
window.kova.onHotkeyApplied(({ name, theme, weaponChanged, restarted }) => {
  refresh()
  const bits = []
  if (restarted) bits.push('scenario restarted, changes are live')
  else if (weaponChanged) bits.push('crosshair/sounds live on scenario re-entry')
  if (theme === 'live') bits.push('theme applies when you open settings')
  else if (theme === 'arming') bits.push('select !KovaPreset in the theme menu once')
  toast(`Hotkey applied <b>${esc(name)}</b>${bits.length ? ' - ' + bits.join(', ') : ''}.`, 'ok', 5000)
})

refresh()
setInterval(refresh, 5000)
