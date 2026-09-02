import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AppConfig, AppEventName, CoolCalendarApi, EventInput } from '../shared/types'

const api: CoolCalendarApi = {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  getOverlaySnapshot: () => ipcRenderer.invoke('app:get-overlay-snapshot'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  saveConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:save', patch),
  choosePath: (kind) => ipcRenderer.invoke('dialog:choose-path', kind),
  saveEvent: (input: EventInput) => ipcRenderer.invoke('event:save', input),
  trashEvent: (filePath) => ipcRenderer.invoke('event:trash', filePath),
  listTrash: () => ipcRenderer.invoke('event:list-trash'),
  restoreEvent: (filePath) => ipcRenderer.invoke('event:restore', filePath),
  deleteForever: (filePath) => ipcRenderer.invoke('event:delete-forever', filePath),
  setCompleted: (filePath, completed) => ipcRenderer.invoke('event:set-completed', filePath, completed),
  loginCoolMessenger: () => ipcRenderer.invoke('messenger:login'),
  markMessageRead: (messageKey) => ipcRenderer.invoke('message:mark-read', messageKey),
  sendMessage: (input) => ipcRenderer.invoke('message:send', input),
  recallMessage: (input) => ipcRenderer.invoke('message:recall', input),
  analyzeMessage: (messageKey) => ipcRenderer.invoke('ai:analyze', messageKey),
  dismissAiEventSuggestion: (messageKey) => ipcRenderer.invoke('ai:dismiss-event-suggestion', messageKey),
  syncGoogle: () => ipcRenderer.invoke('google:sync'),
  connectGoogle: () => ipcRenderer.invoke('google:connect'),
  showOverlay: (visible) => ipcRenderer.invoke('overlay:show', visible),
  showMain: () => ipcRenderer.invoke('window:show-main'),
  openExternal: (target) => ipcRenderer.invoke('shell:open', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:show-item', target),
  getMessageContent: (messageKey) => ipcRenderer.invoke('message:content', messageKey),
  setUiZoom: (scale) => webFrame.setZoomFactor(Math.min(1.35, Math.max(0.9, scale))),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  on: (event: AppEventName, callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('coolcalendar', api)
