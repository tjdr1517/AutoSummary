import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, AppEventName, CoolCalendarApi, EventInput } from '../shared/types'

const api: CoolCalendarApi = {
  getSnapshot: () => ipcRenderer.invoke('app:get-snapshot'),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  saveConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke('config:save', patch),
  choosePath: (kind) => ipcRenderer.invoke('dialog:choose-path', kind),
  saveEvent: (input: EventInput) => ipcRenderer.invoke('event:save', input),
  trashEvent: (filePath) => ipcRenderer.invoke('event:trash', filePath),
  listTrash: () => ipcRenderer.invoke('event:list-trash'),
  restoreEvent: (filePath) => ipcRenderer.invoke('event:restore', filePath),
  deleteForever: (filePath) => ipcRenderer.invoke('event:delete-forever', filePath),
  setCompleted: (filePath, completed) => ipcRenderer.invoke('event:set-completed', filePath, completed),
  markMessageRead: (messageKey) => ipcRenderer.invoke('message:mark-read', messageKey),
  analyzeMessage: (messageKey, createEvent) => ipcRenderer.invoke('ai:analyze', messageKey, createEvent),
  syncGoogle: () => ipcRenderer.invoke('google:sync'),
  connectGoogle: () => ipcRenderer.invoke('google:connect'),
  showOverlay: (visible) => ipcRenderer.invoke('overlay:show', visible),
  showMain: () => ipcRenderer.invoke('window:show-main'),
  openExternal: (target) => ipcRenderer.invoke('shell:open', target),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:show-item', target),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  on: (event: AppEventName, callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('coolcalendar', api)
