import { app, BrowserWindow } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppConfig, AppSnapshot, CalendarEvent, EventInput, GoogleSyncResult, MarkReadResult, MessageAnalysis, MessengerDirectory, TrashedEvent } from '../shared/types'
import { analyzeMessage, createEventFromAnalysis, loadAnalyses, saveAnalysis } from './services/ai'
import { loadConfig, saveConfig } from './services/config'
import { deleteForever, loadEvents, loadTrash, moveEventToTrash, restoreEvent, saveEvent, setEventCompleted } from './services/events'
import { connectGoogle, moveSyncMapping, moveSyncMappingToTrash, restoreSyncMapping, syncGoogle } from './services/google'
import { CoolMessengerSession } from './services/coolmessenger-protocol'
import { buildEventDescription, readRecentMessages } from './services/messages'

export class AppController {
  private config: AppConfig
  private snapshot: AppSnapshot
  private watchers: FSWatcher[] = []
  private refreshTimer?: NodeJS.Timeout
  private debounceTimer?: NodeJS.Timeout
  private autoAnalysisRunning = false
  private googleSyncRunning = false
  private readonly messenger: CoolMessengerSession

  constructor(private readonly windows: () => BrowserWindow[]) {
    this.config = loadConfig()
    const directory: MessengerDirectory = {
      connected: false, syncing: true, groups: [], contacts: [], error: '', updatedAt: ''
    }
    this.snapshot = { config: this.config, messages: [], events: [], analyses: {}, directory }
    this.messenger = new CoolMessengerSession(this.config.dbPath, (nextDirectory) => {
      this.snapshot = { ...this.snapshot, directory: nextDirectory }
      this.broadcast('data-changed', this.snapshot)
    })
    this.refresh(false)
    this.restartWatchers()
    this.applyLoginSetting()
    this.messenger.start()
  }

  getConfig(): AppConfig { return this.config }

  getSnapshot(): AppSnapshot { return this.snapshot }

  refresh(notify = true): AppSnapshot {
    let messages = this.snapshot.messages
    let dbError: string | undefined
    try {
      messages = readRecentMessages(this.config.dbPath, this.config.recentLimit)
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error)
    }
    const events = loadEvents(this.config.eventDir)
    const analyses = loadAnalyses(this.config.dbPath)
    this.snapshot = { config: this.config, messages, events, analyses, directory: this.snapshot.directory, dbError }
    if (notify) this.broadcast('data-changed', this.snapshot)
    if (this.config.aiAutoEnabled) void this.runAutoAnalysis()
    return this.snapshot
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const oldDb = this.config.dbPath
    const oldEventDir = this.config.eventDir
    if (patch.aiAutoEnabled && !this.config.aiAutoEnabled && !patch.aiLastProcessedMessageKey) {
      patch = { ...patch, aiLastProcessedMessageKey: Math.max(0, ...this.snapshot.messages.map((message) => message.key)) }
    }
    this.config = saveConfig({ ...this.config, ...patch })
    if (oldDb !== this.config.dbPath) this.messenger.updateDbPath(this.config.dbPath)
    this.applyLoginSetting()
    if (oldDb !== this.config.dbPath || oldEventDir !== this.config.eventDir || patch.refreshSeconds) this.restartWatchers()
    this.refresh()
    return this.config
  }

  saveWindowBounds(kind: 'main' | 'overlay', bounds: Electron.Rectangle): void {
    const key = kind === 'main' ? 'mainBounds' : 'overlayBounds'
    this.config = saveConfig({ ...this.config, [key]: bounds })
    this.snapshot.config = this.config
  }

  saveCalendarEvent(input: EventInput): CalendarEvent {
    if (input.filePath) this.assertPathInside(input.filePath, this.config.eventDir)
    const oldPath = input.filePath || ''
    if (input.messageKey && !input.description) {
      const message = this.snapshot.messages.find((item) => item.key === input.messageKey)
      if (message) input = { ...input, description: buildEventDescription(message) }
    }
    const event = saveEvent(this.config.eventDir, input)
    if (oldPath && oldPath !== event.filePath) moveSyncMapping(oldPath, event.filePath)
    this.refresh()
    this.queueGoogleSync()
    return event
  }

  trashCalendarEvent(filePath: string): boolean {
    this.assertPathInside(filePath, this.config.eventDir)
    const trashed = moveEventToTrash(this.config.eventDir, filePath)
    if (!trashed) return false
    moveSyncMappingToTrash(filePath, trashed)
    this.refresh()
    this.queueGoogleSync()
    return true
  }

  listTrash(): TrashedEvent[] { return loadTrash(this.config.eventDir) }

  restoreCalendarEvent(filePath: string): CalendarEvent | null {
    this.assertPathInside(filePath, join(this.config.eventDir, '.coolcalendar-trash'))
    const event = restoreEvent(this.config.eventDir, filePath)
    if (event) {
      restoreSyncMapping(filePath, event.filePath)
      this.refresh()
    }
    return event
  }

  deleteForever(filePath: string): boolean {
    this.assertPathInside(filePath, join(this.config.eventDir, '.coolcalendar-trash'))
    return deleteForever(this.config.eventDir, filePath)
  }

  setCompleted(filePath: string, completed: boolean): void {
    this.assertPathInside(filePath, this.config.eventDir)
    setEventCompleted(filePath, completed)
    this.refresh()
  }

  async markMessageRead(messageKey: number): Promise<MarkReadResult> {
    const result = await this.messenger.markMessageRead(messageKey)
    if (result.marked) this.refresh()
    return result
  }

  async loginCoolMessenger(): Promise<void> {
    await this.messenger.login()
  }

  async analyze(messageKey: number, createEvent: boolean): Promise<MessageAnalysis> {
    const message = this.snapshot.messages.find((item) => item.key === messageKey)
    if (!message) throw new Error('분석할 메시지를 찾을 수 없습니다.')
    let analysis: MessageAnalysis
    try {
      analysis = await analyzeMessage(message, this.config.openaiApiKey, this.config.openaiModel)
      if (createEvent && analysis.shouldCreateEvent) {
        const event = createEventFromAnalysis(this.config.eventDir, message, analysis)
        if (event) analysis.autoCreatedEventPath = event.filePath
      }
    } catch (error) {
      analysis = {
        messageKey, summary: '', hasActionItem: false, shouldCreateEvent: false,
        eventTitle: '', dueDate: '', dueTime: '', allDay: true, reason: '',
        autoCreatedEventPath: '', analyzedAt: new Date().toISOString(),
        model: this.config.openaiModel, error: error instanceof Error ? error.message : String(error)
      }
    }
    saveAnalysis(this.config.dbPath, analysis)
    this.refresh()
    if (analysis.autoCreatedEventPath) this.queueGoogleSync()
    return analysis
  }

  async connectGoogle(): Promise<void> {
    await connectGoogle(this.config)
  }

  async syncGoogle(): Promise<GoogleSyncResult> {
    if (this.googleSyncRunning) throw new Error('Google Calendar 동기화가 이미 진행 중입니다.')
    this.googleSyncRunning = true
    this.broadcast('sync-status', { running: true, message: 'Google Calendar 동기화 중…' })
    try {
      const result = await syncGoogle(this.config, this.config.eventDir)
      this.refresh()
      this.broadcast('sync-status', { running: false, message: `가져오기 ${result.imported} · 보내기 ${result.pushed} · 삭제 ${result.deleted}` })
      return result
    } catch (error) {
      this.broadcast('sync-status', { running: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.googleSyncRunning = false
    }
  }

  dispose(): void {
    for (const watcher of this.watchers) watcher.close()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.messenger.dispose()
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const window of this.windows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  private assertPathInside(candidate: string, parent: string): void {
    const result = relative(resolve(parent), resolve(candidate))
    if (!result || result.startsWith('..') || isAbsolute(result) || extname(candidate).toLowerCase() !== '.ics') {
      throw new Error('허용되지 않은 일정 파일 경로입니다.')
    }
  }

  private restartWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    const paths = [this.config.eventDir, dirname(this.config.dbPath)]
    for (const path of paths) {
      if (!path || !existsSync(path)) continue
      try {
        this.watchers.push(watch(path, () => this.scheduleRefresh()))
      } catch { /* The periodic refresh remains available. */ }
    }
    this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshSeconds * 1000)
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.refresh(), 400)
  }

  private applyLoginSetting(): void {
    app.setLoginItemSettings({ openAtLogin: this.config.launchAtLogin, args: ['--hidden'] })
  }

  private queueGoogleSync(): void {
    if (!this.config.googleCalendarEnabled || this.googleSyncRunning) return
    setTimeout(() => void this.syncGoogle().catch(() => undefined), 250)
  }

  private async runAutoAnalysis(): Promise<void> {
    if (this.autoAnalysisRunning || !this.config.aiAutoEnabled) return
    const pending = this.snapshot.messages.filter((message) => message.direction === 'recv' && message.key > this.config.aiLastProcessedMessageKey)
    if (!pending.length) return
    this.autoAnalysisRunning = true
    try {
      for (const message of pending) {
        if (!this.config.aiAutoEnabled) break
        await this.analyze(message.key, this.config.aiAutoCreateEvents)
        this.config = saveConfig({ ...this.config, aiLastProcessedMessageKey: message.key })
      }
      this.refresh()
    } finally {
      this.autoAnalysisRunning = false
    }
  }
}
