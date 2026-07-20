// Renderer: pure UI over the window.kova IPC bridge (see preload.js). No node,
// no fs - every privileged action round-trips to the main process.
const $ = (sel) => document.querySelector(sel)
let current = null // last state snapshot

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
  play:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  grip:
    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2"/></svg>',
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
  const url = soundUrl(name)
  if (!url) return toast(`Sound file for "${esc(name)}" not found.`, 'err')
  previewAudio.pause()
  previewAudio.src = url
  previewAudio.currentTime = 0
  previewAudio.play().catch(() => toast('Could not play that sound.', 'err'))
}

// Draw a crosshair PNG tinted the way the game tints it: multiply the pixels
// with the color, keeping the original alpha.
function drawCrosshair(canvas, file, colorCC) {
  const url = crosshairUrl(file)
  if (!url) return
  const img = new Image()
  img.onload = () => {
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
  img.src = url
}

function toast(msg, kind = '', ms = 3600) {
  const el = $('#toast')
  el.className = `toast ${kind}`
  el.innerHTML = msg
  el.classList.remove('hidden')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.add('hidden'), ms)
}

// short display accessors - tolerant of both the nested snapshot shape and the
// older flat one so presets captured before the refactor still read.
const themeName = (snap) =>
  snap?.primary?.stringSettings?.CurrentThemeName || snap?.primary?.CurrentThemeName || ''
const crosshair = (snap) => snap?.weapon?.CrosshairFile || ''
const bodyHit = (snap) => snap?.weapon?.BodyHitSound || ''

// Is preset P exactly what's active now? (every field the preset specifies matches;
// CurrentThemeName is excluded - the live-switch proxy pins it to "KovaPreset")
function isActive(preset, active) {
  for (const k of Object.keys(preset.weapon || {}))
    if ((preset.weapon[k] ?? '') !== (active.weapon?.[k] ?? '')) return false
  for (const section of Object.keys(preset.primary || {}))
    for (const [key, val] of Object.entries(preset.primary[section] || {})) {
      if (key === 'CurrentThemeName') continue
      if (JSON.stringify(val) !== JSON.stringify(active.primary?.[section]?.[key])) return false
    }
  return true
}

// Quiet meta line under the name: theme · crosshair file · hit sound (+ play).
// The crosshair PREVIEW lives in the tile at the row start, not here.
function summaryHtml(preset) {
  const parts = []
  if (themeName(preset)) parts.push(`<span class="sm-val">${esc(themeName(preset))}</span>`)
  if (crosshair(preset)) parts.push(`<span class="sm-val">${esc(crosshair(preset))}</span>`)
  if (bodyHit(preset))
    parts.push(
      `<span class="sm-val sm-sound">${esc(bodyHit(preset))}<button class="play play-hit" data-tip="Preview">${ICON.play}</button></span>`
    )
  if (!parts.length) return '<span class="sm-empty">no changes</span>'
  return parts.join('<span class="sm-sep">·</span>')
}

// ---- render -------------------------------------------------------------------
// The game's selected theme is pinned to the "!KovaPreset" proxy, so its label is
// meaningless to the user - resolve the real theme name from whichever preset
// matches the active state (theme fields, not the label).
function activeThemeLabel(active, presets) {
  const raw = active.primary?.stringSettings?.CurrentThemeName || ''
  if (raw !== '!KovaPreset' && raw !== 'KovaPreset') return raw
  const match = (presets || []).find((p) => {
    for (const section of Object.keys(p.primary || {}))
      for (const [key, val] of Object.entries(p.primary[section] || {})) {
        if (key === 'CurrentThemeName') continue
        if (!section.match(/Settings$/)) continue
        if (JSON.stringify(val) !== JSON.stringify(active.primary?.[section]?.[key])) return false
      }
    return true
  })
  const real = match ? themeName(match) : ''
  return real ? `${real} (live)` : 'custom (live)'
}

function renderActive(active) {
  const w = active.weapon
  const s = active.primary?.stringSettings || {}
  $('#active').innerHTML = `
    <div class="stat">
      <div class="label">Theme</div>
      <div class="value">${esc(activeThemeLabel(active, current?.presets)) || '—'}</div>
    </div>
    <div class="stat">
      <div class="label">Crosshair</div>
      <div class="value">${esc(w.CrosshairFile) || '—'}</div>
      <div class="sub">scale ${esc(w.CrosshairScale) || '1.0'}</div>
    </div>
    <div class="stat">
      <div class="label">Hit sound</div>
      <div class="value">${esc(w.BodyHitSound) || '—'}</div>
    </div>
    <div class="stat">
      <div class="label">Kill / spawn sound</div>
      <div class="value">${esc(s.KillConfirmedSound) || '—'}</div>
      <div class="sub">spawn ${esc(s.SpawnSound) || '—'}</div>
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
        <label class="xcolor tile-color" data-tip="Crosshair color"><input type="color" value="${colorToHex(preset.weapon?.CrosshairColor)}" aria-label="Crosshair color" /></label>
      </div>
      <div class="info">
        <label class="name-field" title="Click to rename">
          ${ICON.pencil}
          <input class="name" value="${esc(preset.name)}" spellcheck="false" aria-label="Preset name" />
        </label>
        <div class="summary">${summaryHtml(preset)}</div>
      </div>
      <div class="actions">
        <button class="hotkey${preset.hotkey ? ' has-key' : ''}" data-tip="${preset.hotkey ? `${esc(preset.hotkey)} — click to change, Backspace clears` : 'Set global hotkey'}">
          ${preset.hotkey ? esc(preset.hotkey) : ICON.key}
        </button>
        <button class="dup quiet" data-tip="Duplicate" aria-label="Duplicate preset">${ICON.copy}</button>
        <button class="del quiet" data-tip="Delete" aria-label="Delete preset">${ICON.trash}</button>
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

    const colorInput = row.querySelector('.xcolor input')
    if (colorInput)
      colorInput.addEventListener('change', async (e) => {
        current.presets = await window.kova.updateWeapon(preset.id, {
          CrosshairColor: hexToColor(e.target.value),
        })
        renderPresets(current.presets, current.active)
      })

    const xprev = row.querySelector('.xprev')
    if (xprev) drawCrosshair(xprev, crosshair(preset), preset.weapon?.CrosshairColor)
    const playBtn = row.querySelector('.play-hit')
    if (playBtn) playBtn.addEventListener('click', () => playSound(bodyHit(preset)))

    row.querySelector('.hotkey').addEventListener('click', (e) => recordHotkey(preset, e.currentTarget))
    row.querySelector('.dup').addEventListener('click', async () => {
      current.presets = await window.kova.duplicate(preset.id)
      renderPresets(current.presets, current.active)
    })
    const applyBtn = row.querySelector('.apply')
    if (!activeNow) applyBtn.addEventListener('click', () => applyPreset(preset))
    row.querySelector('.del').addEventListener('click', async () => {
      current.presets = await window.kova.remove(preset.id)
      renderPresets(current.presets, current.active)
    })

    // drag to reorder - pointer-based (HTML5 DnD flickers and misfires here)
    const grip = row.querySelector('.grip')
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      row.classList.add('dragging')
      const rows = () => [...wrap.querySelectorAll('.preset')]
      const move = (ev) => {
        for (const other of rows()) {
          if (other === row) continue
          const r = other.getBoundingClientRect()
          if (ev.clientY > r.top && ev.clientY < r.bottom) {
            wrap.insertBefore(row, ev.clientY < r.top + r.height / 2 ? other : other.nextSibling)
            break
          }
        }
      }
      const up = async () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        row.classList.remove('dragging')
        current.presets = await window.kova.reorder(rows().map((el) => el.dataset.id))
        renderPresets(current.presets, current.active)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
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
    toast(`Hotkey <b>${esc(accel)}</b> set — works anywhere, even in-game.`, 'ok')
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

async function applyPreset(preset) {
  try {
    const { weaponChanged, theme } = await window.kova.apply(preset)
    await refresh()
    const live = weaponChanged ? 'Crosshair & sounds are live — re-enter your scenario.' : ''
    if (theme === 'live') {
      toast(`${live} <b>Theme: open the menu in KovaaK's and it applies instantly.</b>`.trim(), 'ok', 6500)
    } else if (theme === 'arming') {
      toast(
        `${live} Theme is staged — <b>select the "!KovaPreset" theme (top of KovaaK's theme list) once</b>; after that, theme changes apply live on menu-open.`.trim(),
        'warn',
        8000
      )
    } else if (theme === 'queued') {
      toast(`${live} Layout/palette changes apply when you quit KovaaK's.`.trim(), 'warn', 6000)
    } else if (theme === 'applied') {
      toast(`Applied. ${live || "Theme is set for your next KovaaK's launch."}`.trim(), 'ok')
    } else if (weaponChanged) {
      toast(live, 'ok')
    } else {
      toast('Already active — nothing to change.', 'ok')
    }
  } catch (err) {
    toast(esc(String(err.message || err)), 'err')
  }
}

async function refresh() {
  // Don't re-render under an open builder/editor - it closes native popups
  // (this is what made the dropdowns unscrollable) and can eat typed input.
  if (!$('#builder').classList.contains('hidden')) return
  if (document.querySelector('#hud-view:not(.hidden)')) return
  current = await window.kova.state()
  const pill = $('#game-pill')
  if (!current.install) {
    $('#not-found').classList.remove('hidden')
    $('#content').classList.add('hidden')
    pill.textContent = "KovaaK's: not found"
    pill.className = 'pill pill-off'
    return
  }
  $('#not-found').classList.add('hidden')
  $('#content').classList.remove('hidden')
  pill.textContent = current.gameRunning ? "KovaaK's: running" : "KovaaK's: closed"
  pill.className = 'pill ' + (current.gameRunning ? 'pill-on' : 'pill-off')
  $('#undo').classList.toggle('hidden', !current.canUndo)
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

function populateBuilder() {
  if (!current?.options) return
  // placeholders show what "leave empty" keeps
  $('#b-theme').placeholder = `keep current (${themeName(current.active) || 'none'})`
  $('#b-crosshair').placeholder = `keep current (${crosshair(current.active) || 'none'})`
  $('#b-sound').placeholder = `keep current (${bodyHit(current.active) || 'none'})`
  const hex = colorToHex(current.active?.weapon?.CrosshairColor)
  $('#b-color').value = hex
  $('#b-color-hex').textContent = hex
  $('#b-name').value = ''
  $('#b-theme').value = ''
  $('#b-crosshair').value = ''
  $('#b-sound').value = ''
  $('#b-killsound').value = ''
}

$('#toggle-builder').addEventListener('click', () => {
  const show = builder.classList.contains('hidden')
  if (show) populateBuilder()
  builder.classList.toggle('hidden', !show)
})
$('#b-cancel').addEventListener('click', () => builder.classList.add('hidden'))
$('#b-color').addEventListener('input', (e) => {
  $('#b-color-hex').textContent = e.target.value
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
  let picks
  try {
    picks = {
      name: $('#b-name').value.trim() || `Preset ${(current?.presets?.length || 0) + 1}`,
      theme: pick('#b-theme', opts.themes, 'theme'),
      crosshair: pick('#b-crosshair', opts.crosshairs, 'crosshair'),
      crosshairColor: hexToColor($('#b-color').value),
      bodyHit: pick('#b-sound', opts.sounds, 'sound'),
      killSound: pick('#b-killsound', opts.sounds, 'sound'),
    }
  } catch (err) {
    return toast(esc(err.message), 'err')
  }
  current.presets = await window.kova.build(picks)
  renderPresets(current.presets, current.active)
  builder.classList.add('hidden')
  toast('Preset created.', 'ok')
})
$('#refresh').addEventListener('click', refresh)
$('#undo').addEventListener('click', async () => {
  const res = await window.kova.undoLast()
  await refresh()
  if (!res.ok) return toast(esc(res.error || 'Nothing to undo.'), 'warn')
  toast(
    res.queued
      ? 'Reverted. Some settings restore when you quit KovaaK\'s; crosshair/sounds are already back.'
      : 'Reverted to the state before the last apply.',
    'ok'
  )
})
$('#b-sound-play').addEventListener('click', () => playSound($('#b-sound').value.trim() || bodyHit(current?.active)))
$('#b-killsound-play').addEventListener('click', () =>
  playSound($('#b-killsound').value.trim() || current?.active?.primary?.stringSettings?.KillConfirmedSound)
)
window.kova.onChanged(() => refresh()) // queued changes landed after the game quit
window.kova.onHotkeyApplied(({ name, theme, weaponChanged }) => {
  refresh()
  const bits = []
  if (weaponChanged) bits.push('crosshair/sounds live on scenario re-entry')
  if (theme === 'live') bits.push('theme applies on menu-open')
  else if (theme === 'arming') bits.push('select !KovaPreset in the theme menu once')
  toast(`Hotkey applied <b>${esc(name)}</b>${bits.length ? ' — ' + bits.join(', ') : ''}.`, 'ok', 5000)
})

refresh()
setInterval(refresh, 5000)
