// The only bridge between the sandboxed renderer and the main process. Each
// method is a thin wrapper over an ipcMain.handle channel in main.js.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kova', {
  state: () => ipcRenderer.invoke('state'),
  capture: (name) => ipcRenderer.invoke('presets:capture', name),
  build: (picks) => ipcRenderer.invoke('presets:build', picks),
  remove: (id) => ipcRenderer.invoke('presets:delete', id),
  rename: (id, name) => ipcRenderer.invoke('presets:rename', id, name),
  updateWeapon: (id, patch) => ipcRenderer.invoke('presets:updateWeapon', id, patch),
  duplicate: (id) => ipcRenderer.invoke('presets:duplicate', id),
  reorder: (orderedIds) => ipcRenderer.invoke('presets:reorder', orderedIds),
  setHotkey: (id, hotkey) => ipcRenderer.invoke('presets:setHotkey', id, hotkey),
  apply: (preset) => ipcRenderer.invoke('preset:apply', preset),
  deactivate: () => ipcRenderer.invoke('presets:deactivate'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  restartScenario: () => ipcRenderer.invoke('game:restart'),
  launchGame: () => ipcRenderer.invoke('game:launch'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  exportPresets: (id) => ipcRenderer.invoke('presets:export', id),
  importPresets: () => ipcRenderer.invoke('presets:import'),
  hudSave: (uiRaw) => ipcRenderer.invoke('hud:save', uiRaw),
  // Fired when a queued change is flushed after the game quits.
  onChanged: (cb) => ipcRenderer.on('changed', () => cb()),
  // Fired when a global hotkey applied a preset in the background.
  onHotkeyApplied: (cb) => ipcRenderer.on('hotkey-applied', (_e, info) => cb(info)),
})
