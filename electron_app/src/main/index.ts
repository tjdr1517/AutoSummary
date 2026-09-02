import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppController } from './controller'
import { placeWindowOnDesktop, revealDesktop } from './native-window'
import { runSmokeTest, writeSmokeResult } from './smoke'
import { readMessageRichContent } from './services/messages'
import type { AppConfig, EventInput, RecallMessageInput, SendMessageInput } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let controller: AppController | null = null
let quitting = false
let boundsSaveTimer: NodeJS.Timeout | undefined

const EDITABLE_CONFIG_KEYS: Array<keyof AppConfig> = [
  'dbPath', 'eventDir', 'refreshSeconds', 'recentLimit', 'autoSaveAttachments', 'attachmentSaveDir',
  'uiTheme', 'uiFontFamily', 'uiFontScale', 'overlayTheme', 'overlayOpacity', 'overlayFontScale',
  'openaiApiKey', 'openaiModel', 'aiAutoEnabled', 'aiEventSuggestionPopup', 'googleCalendarEnabled',
  'googleCalendarId', 'googleCredentialsPath', 'googleOauthClientId', 'googleOauthClientSecret',
  'googleTokenPath', 'googleTimezone', 'launchAtLogin'
]

const smokeTest = app.commandLine.hasSwitch('smoke-test')
const defaultUserData = app.getPath('userData')
if (smokeTest) app.setPath('userData', `${defaultUserData}-smoke`)
else if (!app.isPackaged) app.setPath('userData', `${defaultUserData}-dev`)
const singleInstance = smokeTest || app.requestSingleInstanceLock()
if (!singleInstance) app.quit()
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

function validBounds(bounds: AppConfig['mainBounds'], fallback: Electron.Rectangle): Electron.Rectangle {
  if (!bounds) return fallback
  const candidate = { x: bounds.x ?? fallback.x, y: bounds.y ?? fallback.y, width: bounds.width, height: bounds.height }
  const visible = screen.getAllDisplays().some((display) => {
    const overlapX = Math.max(0, Math.min(candidate.x + candidate.width, display.bounds.x + display.bounds.width) - Math.max(candidate.x, display.bounds.x))
    const overlapY = Math.max(0, Math.min(candidate.y + candidate.height, display.bounds.y + display.bounds.height) - Math.max(candidate.y, display.bounds.y))
    return overlapX >= 100 && overlapY >= 80
  })
  return visible ? candidate : fallback
}

function pageUrl(window: BrowserWindow, route: 'main' | 'overlay'): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/${route}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/${route}` })
  }
}

function editableConfigPatch(value: unknown): Partial<AppConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('설정 값이 올바르지 않습니다.')
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of EDITABLE_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key]
  }
  return result as Partial<AppConfig>
}

function isTrustedRendererNavigation(url: string): boolean {
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    }
    const page = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    return url === page || url.startsWith(`${page}#`)
  } catch {
    return false
  }
}

function secureRenderer(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererNavigation(url)) event.preventDefault()
  })
}

function createMainWindow(config: AppConfig): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea
  const fallback = { x: display.x + 60, y: display.y + 48, width: Math.min(1480, display.width - 120), height: Math.min(940, display.height - 96) }
  const bounds = validBounds(config.mainBounds, fallback)
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    show: false,
    backgroundColor: '#07101d',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  secureRenderer(window)
  window.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) window.show() })
  window.webContents.on('did-finish-load', () => window.setTitle('CoolCalendar'))
  pageUrl(window, 'main')
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  const saveBounds = (): void => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
    boundsSaveTimer = setTimeout(() => controller?.saveWindowBounds('main', window.getBounds()), 350)
  }
  window.on('move', saveBounds)
  window.on('resize', saveBounds)
  return window
}

function createOverlayWindow(config: AppConfig): BrowserWindow {
  const display = screen.getPrimaryDisplay().workArea
  const fallback = { x: display.x + 24, y: display.y + 24, width: display.width - 48, height: display.height - 48 }
  const bounds = validBounds(config.overlayBounds, fallback)
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 480,
    frame: false,
    transparent: true,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  secureRenderer(window)
  window.webContents.on('did-finish-load', () => window.setTitle('CoolCalendar Overlay'))
  pageUrl(window, 'overlay')
  window.setOpacity(config.overlayOpacity / 100)
  window.on('minimize', (event) => {
    event.preventDefault()
    setTimeout(() => {
      if (!window.isDestroyed()) { window.restore(); window.showInactive(); placeWindowOnDesktop(window) }
    }, 120)
  })
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => controller?.saveWindowBounds('overlay', window.getBounds()), 350)
  }
  window.on('move', save)
  window.on('resize', save)
  window.on('show', () => setTimeout(() => placeWindowOnDesktop(window), 80))
  return window
}

function createTray(): void {
  tray?.destroy()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="8" width="32" height="32" fill="#63d8ff"/><rect x="7" y="9" width="18" height="16" rx="3" fill="#07101d"/><path d="M7 14h18M12 6v6M20 6v6" stroke="#fff" stroke-width="2"/></svg>`
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 20, height: 20 })
  tray = new Tray(icon)
  tray.setToolTip('CoolCalendar')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'CoolCalendar 열기', click: () => { mainWindow?.show(); mainWindow?.focus() } },
    { label: '바탕화면 캘린더', type: 'checkbox', checked: overlayWindow?.isVisible(), click: (item) => toggleOverlay(item.checked) },
    { type: 'separator' },
    { label: '새로고침', click: () => controller?.refresh() },
    { label: '종료', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus() })
}

function ensureOverlayWindow(): BrowserWindow | null {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow
  if (!controller) return null
  overlayWindow = createOverlayWindow(controller.getConfig())
  return overlayWindow
}

function toggleOverlay(visible: boolean): boolean {
  if (visible) {
    const window = ensureOverlayWindow()
    if (!window) return false
    window.showInactive()
    placeWindowOnDesktop(window)
    revealDesktop()
    setTimeout(() => {
      if (!overlayWindow?.isDestroyed()) { overlayWindow?.restore(); overlayWindow?.showInactive(); placeWindowOnDesktop(overlayWindow) }
    }, 220)
  } else if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('overlay-visibility', visible)
  createTray()
  return visible
}

function registerIpc(): void {
  if (!controller) return
  ipcMain.handle('app:get-snapshot', () => controller!.getSnapshot())
  ipcMain.handle('app:get-overlay-snapshot', () => controller!.getOverlaySnapshot())
  ipcMain.handle('app:refresh', () => controller!.refresh())
  ipcMain.handle('config:save', (_event, patch: Partial<AppConfig>) => {
    const config = controller!.updateConfig(editableConfigPatch(patch))
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setOpacity(config.overlayOpacity / 100)
    return config
  })
  ipcMain.handle('dialog:choose-path', async (_event, kind: 'db' | 'eventDir' | 'attachmentDir' | 'credentials') => {
    if (!['db', 'eventDir', 'attachmentDir', 'credentials'].includes(kind)) throw new Error('지원하지 않는 경로 선택입니다.')
    const result = kind === 'eventDir' || kind === 'attachmentDir'
      ? await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], filters: kind === 'db' ? [{ name: 'CoolMessenger UDB', extensions: ['udb'] }] : [{ name: 'JSON', extensions: ['json'] }] })
    return result.canceled ? '' : result.filePaths[0]
  })
  ipcMain.handle('event:save', (_event, input: EventInput) => controller!.saveCalendarEvent(input))
  ipcMain.handle('event:trash', (_event, path: string) => controller!.trashCalendarEvent(path))
  ipcMain.handle('event:list-trash', () => controller!.listTrash())
  ipcMain.handle('event:restore', (_event, path: string) => controller!.restoreCalendarEvent(path))
  ipcMain.handle('event:delete-forever', (_event, path: string) => controller!.deleteForever(path))
  ipcMain.handle('event:set-completed', (_event, path: string, done: boolean) => controller!.setCompleted(path, done))
  ipcMain.handle('messenger:login', () => controller!.loginCoolMessenger())
  ipcMain.handle('message:mark-read', (_event, key: number) => controller!.markMessageRead(key))
  ipcMain.handle('message:send', (_event, input: SendMessageInput) => controller!.sendMessage(input))
  ipcMain.handle('message:recall', (_event, input: RecallMessageInput) => controller!.recallMessage(input))
  ipcMain.handle('message:content', (_event, key: number) => {
    const snapshot = controller!.getSnapshot()
    if (!Number.isInteger(key) || key <= 0 || !snapshot.messages.some((message) => message.key === key && message.direction === 'recv')) {
      throw new Error('받은 메시지를 찾을 수 없습니다.')
    }
    const blocks = readMessageRichContent(snapshot.config.dbPath, key)
    const results = blocks.map((block) => {
      if (block.type === 'text') return block
      try {
        const source = block.content
        if (!source.startsWith('data:image/') || source.length > 12 * 1024 * 1024) return null
        let image = nativeImage.createFromDataURL(source)
        if (image.isEmpty()) return null
        const size = image.getSize()
        if (size.width <= 0 || size.height <= 0 || size.width > 12_000 || size.height > 12_000 || size.width * size.height > 40_000_000) return null
        const scale = Math.min(1, 1200 / Math.max(size.width, 1), 900 / Math.max(size.height, 1))
        if (scale < 1) image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' })
        return { type: 'image' as const, content: image.toDataURL() }
      } catch {
        return null
      }
    })
    return results.filter((block) => block !== null)
  })
  ipcMain.handle('ai:analyze', (_event, key: number) => controller!.analyze(key))
  ipcMain.handle('ai:dismiss-event-suggestion', (_event, key: number) => {
    if (!Number.isInteger(key) || key <= 0) throw new Error('일정 후보 메시지를 찾을 수 없습니다.')
    controller!.dismissAiEventSuggestion(key)
  })
  ipcMain.handle('google:connect', () => controller!.connectGoogle())
  ipcMain.handle('google:sync', () => controller!.syncGoogle())
  ipcMain.handle('overlay:show', (_event, visible: boolean) => toggleOverlay(Boolean(visible)))
  ipcMain.handle('window:show-main', () => { mainWindow?.show(); mainWindow?.focus() })
  ipcMain.handle('shell:open', async (_event, target: string) => {
    if (typeof target !== 'string' || target.length > 4096) throw new Error('열 수 없는 대상입니다.')
    if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) await shell.openExternal(target)
    else if (isAbsolute(target) && controller!.getSnapshot().messages.some((message) =>
      message.attachments.some((attachment) => attachment.localPath && resolve(attachment.localPath) === resolve(target)))) {
      await shell.openPath(target)
    }
    else throw new Error('열 수 없는 경로입니다.')
  })
  ipcMain.handle('shell:show-item', (_event, target: string) => {
    const known = typeof target === 'string' && isAbsolute(target) && controller!.getSnapshot().messages.some((message) =>
      message.attachments.some((attachment) => attachment.localPath && resolve(attachment.localPath) === resolve(target)))
    if (!known) throw new Error('표시할 수 없는 경로입니다.')
    shell.showItemInFolder(target)
  })
  ipcMain.handle('window:action', (_event, action: string) => {
    const window = BrowserWindow.fromWebContents(_event.sender)
    if (!window) return
    if (action === 'minimize') window.minimize()
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    else if (action === 'close') window === overlayWindow ? window.hide() : window.close()
  })
}

if (singleInstance) app.whenReady().then(() => {
  controller = new AppController(
    () => mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : [],
    () => overlayWindow && !overlayWindow.isDestroyed() ? [overlayWindow] : []
  )
  if (smokeTest) {
    const result = runSmokeTest(controller)
    writeSmokeResult(app.commandLine.getSwitchValue('smoke-output'), result)
    console.log(JSON.stringify(result, null, 2))
    controller.dispose()
    quitting = true
    process.exitCode = result.ok ? 0 : 1
    app.removeAllListeners('window-all-closed')
    setImmediate(() => app.quit())
    return
  }
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  mainWindow = createMainWindow(controller.getConfig())
  registerIpc()
  createTray()
  app.on('activate', () => { mainWindow?.show(); mainWindow?.focus() })
})

app.on('before-quit', () => { quitting = true; controller?.dispose() })
app.on('window-all-closed', (event: Event) => event.preventDefault())
