// HUD editor: drag/resize KovaaK's HUD windows on a virtual screen with the snap
// guides the in-game editor lacks (center lines, edge alignment, equal-spacing
// bars, multi-select align/distribute, keyboard nudge). Reads the layout from
// state.active.ui (UI.json) and saves via hud:save under the closed-game rule.
// Shares the global scope with renderer.js ($, esc, toast, current, refresh).

// Approximate unscaled window sizes in game units (1080p px). The game stores
// only position + scale, so sizes are estimates - the corner handle on a
// selected box lets the user calibrate the real size, persisted locally.
const HUD_SIZES = {
  SessionStats: { w: 380, h: 220 },
  ScenarioTitle: { w: 220, h: 34 },
  SensitivityRandomizer: { w: 220, h: 60 },
  Clock: { w: 88, h: 32 },
  FPS: { w: 64, h: 32 },
  ChallengeTimer: { w: 80, h: 44 },
  Weapon: { w: 130, h: 64 },
  AdaptiveSettings: { w: 250, h: 80 },
  ScoreProgressBar: { w: 300, h: 40 },
}
const HUD_DEFAULT_SIZE = { w: 160, h: 48 }
const SNAP_PX = 6 // snap threshold in canvas px

const hudSizeOverrides = JSON.parse(localStorage.getItem('hudSizeOverrides') || '{}')
function saveSizeOverride(name, w, h) {
  hudSizeOverrides[name] = { w: Math.round(w), h: Math.round(h) }
  localStorage.setItem('hudSizeOverrides', JSON.stringify(hudSizeOverrides))
}

const hud = {
  items: [], // {name, x, y, scale, hadScaleEntry}
  res: { x: 1920, y: 1080 },
  factor: 1, // canvas px per game unit
  selection: new Set(),
  dirty: false,
  history: [], // snapshots; [0] is the saved layout at open
  histIdx: -1,
}

// ---- undo / redo ---------------------------------------------------------------
function hudSnapshot() {
  return JSON.stringify(hud.items)
}
function hudCommit() {
  const snap = hudSnapshot()
  if (hud.history[hud.histIdx] === snap) return // mutation was a no-op
  hud.history = hud.history.slice(0, hud.histIdx + 1)
  hud.history.push(snap)
  hud.histIdx++
  hudHistoryUi()
}
function hudRestore(idx) {
  hud.histIdx = idx
  hud.items = JSON.parse(hud.history[idx])
  // selection entries point at replaced objects - remap them by window name
  const byName = new Map(hud.items.map((i) => [i.name, i]))
  hud.selection = new Set([...hud.selection].map((i) => byName.get(i.name)).filter(Boolean))
  hud.dirty = hud.history[idx] !== hud.history[0]
  hudRender()
  hudRenderInspector()
  hudHistoryUi()
}
// A nudge burst commits on a delay - land it before jumping through history,
// or an undo inside the delay window would skip the nudge entirely.
function flushNudgeCommit() {
  if (!nudgeCommitT) return
  clearTimeout(nudgeCommitT)
  nudgeCommitT = null
  hudCommit()
}
function hudUndo() {
  flushNudgeCommit()
  if (hud.histIdx > 0) hudRestore(hud.histIdx - 1)
}
function hudRedo() {
  flushNudgeCommit()
  if (hud.histIdx < hud.history.length - 1) hudRestore(hud.histIdx + 1)
}
function hudHistoryUi() {
  $('#hud-undo').disabled = hud.histIdx <= 0
  $('#hud-redo').disabled = hud.histIdx >= hud.history.length - 1
  $('#hud-reset').disabled = hud.histIdx === 0
}

const selOnly = () => (hud.selection.size === 1 ? [...hud.selection][0] : null)

function hudSizeOf(item) {
  const base = hudSizeOverrides[item.name] || HUD_SIZES[item.name] || HUD_DEFAULT_SIZE
  const s = item.scale ?? 1
  return { w: base.w * s, h: base.h * s }
}

function hudParse(raw) {
  let obj
  try {
    obj = JSON.parse(String(raw || '').replace(/^﻿/, ''))
  } catch {
    obj = {}
  }
  const scales = new Map((obj.windowScaleSettings || []).map((e) => [e.windowName, e.scale]))
  const items = (obj.windowPositionSettings || []).map((e) => ({
    name: e.windowName,
    x: e.position?.x ?? 0,
    y: e.position?.y ?? 0,
    scale: scales.get(e.windowName) ?? null,
    hadScaleEntry: scales.has(e.windowName),
  }))
  for (const [name, scale] of scales)
    if (!items.some((i) => i.name === name))
      items.push({ name, x: 20, y: 20, scale, hadScaleEntry: true })
  return items
}

function hudSerialize() {
  const obj = {
    windowPositionSettings: hud.items.map((i) => ({
      windowName: i.name,
      position: { x: i.x, y: i.y },
    })),
    windowScaleSettings: hud.items
      .filter((i) => i.scale != null)
      .map((i) => ({ windowName: i.name, scale: i.scale })),
  }
  return JSON.stringify(obj, null, '\t')
}

// ---- rendering ----------------------------------------------------------------
function hudRender() {
  const canvas = $('#hud-canvas')
  canvas.querySelectorAll('.hud-box').forEach((el) => el.remove())
  for (const item of hud.items) {
    const el = document.createElement('div')
    const selected = hud.selection.has(item)
    el.className = 'hud-box' + (selected ? ' selected' : '')
    el.dataset.name = item.name
    const size = hudSizeOf(item)
    el.style.left = `${item.x * hud.factor}px`
    el.style.top = `${item.y * hud.factor}px`
    el.style.width = `${size.w * hud.factor}px`
    el.style.height = `${size.h * hud.factor}px`
    el.innerHTML = `<span>${esc(item.name)}</span>${selected && hud.selection.size === 1 ? '<div class="hud-resize"></div>' : ''}`
    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('hud-resize')) hudStartResize(item, el, e)
      else hudStartDrag(item, el, e)
    })
    const rz = el.querySelector('.hud-resize')
    if (rz)
      rz.addEventListener('dblclick', () => {
        delete hudSizeOverrides[item.name]
        localStorage.setItem('hudSizeOverrides', JSON.stringify(hudSizeOverrides))
        toast(`${esc(item.name)} size reset to the built-in estimate.`, 'ok')
        hudRender()
      })
    canvas.appendChild(el)
  }
  hudRenderInspector()
}

function hudRenderInspector() {
  const single = $('#hud-inspector')
  const multi = $('#hud-align')
  const item = selOnly()
  single.classList.toggle('hidden', !item)
  multi.classList.toggle('hidden', hud.selection.size < 2)
  if (item) {
    $('#hud-sel-name').textContent = item.name
    $('#hud-sel-pos').textContent = `x ${Math.round(item.x)} · y ${Math.round(item.y)}`
    $('#hud-sel-scale').value = item.scale ?? 1
    $('#hud-sel-scale-val').textContent = `${(item.scale ?? 1).toFixed(2)}×`
  }
  if (hud.selection.size >= 2)
    $('#hud-align-count').textContent = `(${hud.selection.size} selected)`
}

// ---- snapping -----------------------------------------------------------------
function hudSnap(item, gx, gy) {
  const size = hudSizeOf(item)
  const others = hud.items.filter((o) => o !== item && !hud.selection.has(o))

  const candX = [
    { at: hud.res.x / 2 - size.w / 2, line: hud.res.x / 2, center: true },
    { at: 0, line: 0 },
    { at: hud.res.x - size.w, line: hud.res.x },
  ]
  const candY = [
    { at: hud.res.y / 2 - size.h / 2, line: hud.res.y / 2, center: true },
    { at: 0, line: 0 },
    { at: hud.res.y - size.h, line: hud.res.y },
  ]
  for (const other of others) {
    const os = hudSizeOf(other)
    candX.push(
      { at: other.x, line: other.x },
      { at: other.x + os.w - size.w, line: other.x + os.w },
      { at: other.x + os.w / 2 - size.w / 2, line: other.x + os.w / 2 }
    )
    candY.push(
      { at: other.y, line: other.y },
      { at: other.y + os.h - size.h, line: other.y + os.h },
      { at: other.y + os.h / 2 - size.h / 2, line: other.y + os.h / 2 }
    )
  }

  const row = others
    .filter((o) => o.y < gy + size.h && gy < o.y + hudSizeOf(o).h)
    .sort((a, b) => a.x - b.x)
  for (let a = 0; a < row.length; a++) {
    for (let b = a + 1; b < row.length; b++) {
      const A = row[a]
      const B = row[b]
      const As = hudSizeOf(A)
      const Bs = hudSizeOf(B)
      const aR = A.x + As.w
      const midY = Math.max(A.y, B.y, gy) + 8
      const gap = B.x - aR
      if (gap > 0) {
        candX.push({
          at: B.x + Bs.w + gap,
          bars: [
            { axis: 'x', from: aR, to: B.x, at: midY, label: gap },
            { axis: 'x', from: B.x + Bs.w, to: B.x + Bs.w + gap, at: midY, label: gap },
          ],
        })
        candX.push({
          at: A.x - gap - size.w,
          bars: [
            { axis: 'x', from: A.x - gap, to: A.x, at: midY, label: gap },
            { axis: 'x', from: aR, to: B.x, at: midY, label: gap },
          ],
        })
      }
      const between = (aR + B.x - size.w) / 2
      const bGap = between - aR
      if (bGap > 2) {
        candX.push({
          at: between,
          bars: [
            { axis: 'x', from: aR, to: between, at: midY, label: bGap },
            { axis: 'x', from: between + size.w, to: B.x, at: midY, label: bGap },
          ],
        })
      }
    }
  }
  const col = others
    .filter((o) => o.x < gx + size.w && gx < o.x + hudSizeOf(o).w)
    .sort((a, b) => a.y - b.y)
  for (let a = 0; a < col.length; a++) {
    for (let b = a + 1; b < col.length; b++) {
      const A = col[a]
      const B = col[b]
      const As = hudSizeOf(A)
      const Bs = hudSizeOf(B)
      const aB = A.y + As.h
      const midX = Math.max(A.x, B.x, gx) + 8
      const gap = B.y - aB
      if (gap > 0) {
        candY.push({
          at: B.y + Bs.h + gap,
          bars: [
            { axis: 'y', from: aB, to: B.y, at: midX, label: gap },
            { axis: 'y', from: B.y + Bs.h, to: B.y + Bs.h + gap, at: midX, label: gap },
          ],
        })
        candY.push({
          at: A.y - gap - size.h,
          bars: [
            { axis: 'y', from: A.y - gap, to: A.y, at: midX, label: gap },
            { axis: 'y', from: aB, to: B.y, at: midX, label: gap },
          ],
        })
      }
      const between = (aB + B.y - size.h) / 2
      const bGap = between - aB
      if (bGap > 2) {
        candY.push({
          at: between,
          bars: [
            { axis: 'y', from: aB, to: between, at: midX, label: bGap },
            { axis: 'y', from: between + size.h, to: B.y, at: midX, label: bGap },
          ],
        })
      }
    }
  }

  const thr = SNAP_PX / hud.factor
  const guides = []
  const pickAxis = (cands, want, axisIsX) => {
    let best = thr
    let val = want
    let win = null
    for (const c of cands) {
      const d = Math.abs(want - c.at)
      if (d < best) {
        best = d
        val = c.at
        win = c
      }
    }
    if (win?.line != null)
      guides.push({ kind: 'line', axis: axisIsX ? 'v' : 'h', at: win.line, center: !!win.center })
    if (win?.bars) guides.push(...win.bars.map((b) => ({ kind: 'bar', ...b })))
    return val
  }
  const x = pickAxis(candX, gx, true)
  const y = pickAxis(candY, gy, false)
  hudShowGuides(guides)
  return { x, y }
}

function hudShowGuides(guides) {
  const canvas = $('#hud-canvas')
  canvas.querySelectorAll('.hud-guide, .hud-gap').forEach((el) => el.remove())
  for (const g of guides) {
    if (g.kind === 'line') {
      const el = document.createElement('div')
      el.className = `hud-guide ${g.axis === 'v' ? 'hud-guide-v' : 'hud-guide-h'}${g.center ? ' hud-guide-center' : ''}`
      if (g.axis === 'v') el.style.left = `${g.at * hud.factor}px`
      else el.style.top = `${g.at * hud.factor}px`
      canvas.appendChild(el)
    } else {
      const el = document.createElement('div')
      el.className = `hud-gap ${g.axis === 'x' ? 'hud-gap-x' : 'hud-gap-y'}`
      const from = Math.min(g.from, g.to) * hud.factor
      const len = Math.abs(g.to - g.from) * hud.factor
      if (g.axis === 'x') {
        el.style.left = `${from}px`
        el.style.width = `${len}px`
        el.style.top = `${g.at * hud.factor}px`
      } else {
        el.style.top = `${from}px`
        el.style.height = `${len}px`
        el.style.left = `${g.at * hud.factor}px`
      }
      el.innerHTML = `<i>${Math.round(g.label)}</i>`
      canvas.appendChild(el)
    }
  }
}

// ---- interaction --------------------------------------------------------------
function clampItem(item, x, y) {
  const size = hudSizeOf(item)
  return {
    x: Math.max(0, Math.min(hud.res.x - size.w, x)),
    y: Math.max(0, Math.min(hud.res.y - size.h, y)),
  }
}

function hudStartDrag(item, el, e) {
  e.preventDefault()
  if (e.shiftKey) {
    // shift-click toggles membership, no drag
    if (hud.selection.has(item)) hud.selection.delete(item)
    else hud.selection.add(item)
    hudRender()
    return
  }
  if (!hud.selection.has(item)) hud.selection = new Set([item])
  hudRender()

  const moving = [...hud.selection]
  const starts = moving.map((m) => ({ m, x: m.x, y: m.y }))
  const startX = e.clientX
  const startY = e.clientY

  const move = (ev) => {
    const dx = (ev.clientX - startX) / hud.factor
    const dy = (ev.clientY - startY) / hud.factor
    // snap is driven by the grabbed item; the rest follow its delta
    const lead = starts.find((s) => s.m === item)
    const want = clampItem(item, lead.x + dx, lead.y + dy)
    const snapped = hudSnap(item, want.x, want.y)
    const adx = snapped.x - lead.x
    const ady = snapped.y - lead.y
    for (const s of starts) {
      const p = clampItem(s.m, s.x + adx, s.y + ady)
      s.m.x = Math.round(p.x * 2) / 2
      s.m.y = Math.round(p.y * 2) / 2
    }
    hud.dirty = true
    for (const s of starts) {
      const boxEl = $('#hud-canvas').querySelector(`.hud-box[data-name="${CSS.escape(s.m.name)}"]`)
      if (boxEl) {
        boxEl.style.left = `${s.m.x * hud.factor}px`
        boxEl.style.top = `${s.m.y * hud.factor}px`
      }
    }
    hudRenderInspector()
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    hudShowGuides([])
    hudCommit()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// Corner-drag calibration: adjusts the window's UNSCALED base size (persisted
// app-side), so snapping/centering math matches the real on-screen window.
function hudStartResize(item, el, e) {
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startY = e.clientY
  const size = hudSizeOf(item)
  const move = (ev) => {
    const w = Math.max(12, size.w + (ev.clientX - startX) / hud.factor)
    const h = Math.max(8, size.h + (ev.clientY - startY) / hud.factor)
    el.style.width = `${w * hud.factor}px`
    el.style.height = `${h * hud.factor}px`
    el.dataset.w = w
    el.dataset.h = h
  }
  const up = (ev) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const w = parseFloat(el.dataset.w || size.w)
    const h = parseFloat(el.dataset.h || size.h)
    const s = item.scale ?? 1
    saveSizeOverride(item.name, w / s, h / s)
    toast(`Calibrated ${esc(item.name)} to ${Math.round(w)}×${Math.round(h)}.`, 'ok')
    hudRender()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// A held arrow key repeats ~30/s - collapse the burst into ONE history entry
// (committed shortly after the last press) or undo unwinds pixel by pixel.
let nudgeCommitT = null
function hudNudge(dx, dy) {
  if (!hud.selection.size) return
  for (const item of hud.selection) {
    const p = clampItem(item, item.x + dx, item.y + dy)
    item.x = p.x
    item.y = p.y
  }
  hud.dirty = true
  hudRender()
  clearTimeout(nudgeCommitT)
  nudgeCommitT = setTimeout(hudCommit, 400)
}

// ---- align / distribute -------------------------------------------------------
function hudAlign(mode) {
  const sel = [...hud.selection]
  if (sel.length < 2) return
  const boxes = sel.map((m) => ({ m, s: hudSizeOf(m) }))
  const minX = Math.min(...boxes.map((b) => b.m.x))
  const maxR = Math.max(...boxes.map((b) => b.m.x + b.s.w))
  const minY = Math.min(...boxes.map((b) => b.m.y))
  const maxB = Math.max(...boxes.map((b) => b.m.y + b.s.h))
  if (mode === 'left') boxes.forEach((b) => (b.m.x = minX))
  if (mode === 'right') boxes.forEach((b) => (b.m.x = maxR - b.s.w))
  if (mode === 'hcenter') boxes.forEach((b) => (b.m.x = (minX + maxR) / 2 - b.s.w / 2))
  if (mode === 'top') boxes.forEach((b) => (b.m.y = minY))
  if (mode === 'bottom') boxes.forEach((b) => (b.m.y = maxB - b.s.h))
  if (mode === 'vcenter') boxes.forEach((b) => (b.m.y = (minY + maxB) / 2 - b.s.h / 2))
  if (mode === 'disth' && boxes.length > 2) {
    boxes.sort((a, b) => a.m.x - b.m.x)
    const total = maxR - minX
    const used = boxes.reduce((n, b) => n + b.s.w, 0)
    const gap = (total - used) / (boxes.length - 1)
    let cursor = minX
    for (const b of boxes) {
      b.m.x = cursor
      cursor += b.s.w + gap
    }
  }
  if (mode === 'distv' && boxes.length > 2) {
    boxes.sort((a, b) => a.m.y - b.m.y)
    const total = maxB - minY
    const used = boxes.reduce((n, b) => n + b.s.h, 0)
    const gap = (total - used) / (boxes.length - 1)
    let cursor = minY
    for (const b of boxes) {
      b.m.y = cursor
      cursor += b.s.h + gap
    }
  }
  // space-evenly across the whole screen: equal gaps between windows AND to
  // both screen edges (distribute keeps the outermost windows pinned instead)
  if (mode === 'evenh') {
    boxes.sort((a, b) => a.m.x - b.m.x)
    const used = boxes.reduce((n, b) => n + b.s.w, 0)
    // gap floors at 0: windows wider than the screen pack from the left edge
    // instead of being pushed off-screen by a negative gap
    const gap = Math.max(0, (hud.res.x - used) / (boxes.length + 1))
    let cursor = gap
    for (const b of boxes) {
      b.m.x = cursor
      cursor += b.s.w + gap
    }
  }
  if (mode === 'evenv') {
    boxes.sort((a, b) => a.m.y - b.m.y)
    const used = boxes.reduce((n, b) => n + b.s.h, 0)
    const gap = Math.max(0, (hud.res.y - used) / (boxes.length + 1))
    let cursor = gap
    for (const b of boxes) {
      b.m.y = cursor
      cursor += b.s.h + gap
    }
  }
  for (const b of boxes) {
    b.m.x = Math.round(b.m.x * 2) / 2
    b.m.y = Math.round(b.m.y * 2) / 2
  }
  hud.dirty = true
  hudRender()
  hudCommit()
}

// ---- open/close/save ----------------------------------------------------------
function hudOpen() {
  if (!current?.install) return
  hud.res = current.resolution || { x: 1920, y: 1080 }
  hud.items = hudParse(current.active?.ui)
  hud.selection = new Set()
  hud.dirty = false
  hud.history = [hudSnapshot()]
  hud.histIdx = 0
  hudHistoryUi()
  $('#content').classList.add('hidden')
  $('#hud-view').classList.remove('hidden')
  $('#hud-hint').textContent = `${hud.res.x}×${hud.res.y}`

  const wrap = $('#hud-canvas-wrap')
  const canvas = $('#hud-canvas')
  const width = wrap.clientWidth
  hud.factor = width / hud.res.x
  canvas.style.width = `${width}px`
  canvas.style.height = `${hud.res.y * hud.factor}px`
  hudRender()
}

function hudClose() {
  $('#hud-view').classList.add('hidden')
  $('#content').classList.remove('hidden')
  refresh()
}

$('#open-hud').addEventListener('click', hudOpen)
$('#hud-cancel').addEventListener('click', async () => {
  if (hud.dirty && !(await appConfirm('Discard your HUD changes?', { okLabel: 'Discard', danger: true })))
    return
  hudClose()
})
$('#hud-undo').addEventListener('click', hudUndo)
$('#hud-redo').addEventListener('click', hudRedo)
$('#hud-reset').addEventListener('click', () => {
  flushNudgeCommit()
  hudRestore(0) // back to the saved layout (redoable)
})
$('#hud-save').addEventListener('click', async () => {
  const { status } = await window.kova.hudSave(hudSerialize())
  if (status === 'invalid') return toast("Couldn't save that layout - nothing was written.", 'err')
  hudClose()
  toast(
    status === 'queued'
      ? "HUD layout saved - applies when you quit KovaaK's."
      : "HUD layout saved - live next time you launch KovaaK's.",
    status === 'queued' ? 'warn' : 'ok'
  )
})
$('#hud-sel-scale').addEventListener('input', (e) => {
  const item = selOnly()
  if (!item) return
  // magnetic detent at 1.00 - the track is narrower than its 175 steps, so a
  // drag can land on 0.99/1.01 with no pixel that yields exactly 1
  let v = parseFloat(e.target.value)
  if (Math.abs(v - 1) < 0.015) {
    v = 1
    e.target.value = '1'
  }
  item.scale = v
  hud.dirty = true
  hudRender()
})
// one history entry per slider release, not per tick
$('#hud-sel-scale').addEventListener('change', hudCommit)
$('#hud-center-h').addEventListener('click', () => {
  const item = selOnly()
  if (!item) return
  item.x = Math.round((hud.res.x / 2 - hudSizeOf(item).w / 2) * 2) / 2
  hud.dirty = true
  hudRender()
  hudCommit()
})
$('#hud-center-v').addEventListener('click', () => {
  const item = selOnly()
  if (!item) return
  item.y = Math.round((hud.res.y / 2 - hudSizeOf(item).h / 2) * 2) / 2
  hud.dirty = true
  hudRender()
  hudCommit()
})
document.querySelectorAll('#hud-align [data-align]').forEach((b) =>
  b.addEventListener('click', () => hudAlign(b.dataset.align))
)
window.addEventListener('keydown', (e) => {
  if ($('#hud-view').classList.contains('hidden')) return
  if (e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    return e.shiftKey ? hudRedo() : hudUndo()
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    return hudRedo()
  }
  if (!hud.selection.size) return
  const step = e.shiftKey ? 10 : 1
  const map = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  if (map[e.key]) {
    e.preventDefault()
    hudNudge(...map[e.key])
  }
})
