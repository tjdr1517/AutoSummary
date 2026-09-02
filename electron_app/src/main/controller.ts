import { app, BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppConfig, AppSnapshot, CalendarEvent, EventInput, GoogleSyncResult, MarkReadResult, MessageAnalysis, MessengerDirectory, OverlaySnapshot, RecallMessageInput, RecallMessageResult, SendMessageInput, SendMessageResult, TrashedEvent } from '../shared/types'
import { analyzeMessage, loadAnalyses, saveAnalysis } from './services/ai'
import { loadConfig, saveConfig } from './services/config'
import { deleteForever, loadEvents, loadTrash, moveEventToTrash, restoreEvent, saveEvent, setEventCompleted } from './services/events'
import { connectGoogle, moveSyncMapping, moveSyncMappingToTrash, restoreSyncMapping, syncGoogle } from './services/google'
import { CoolMessengerSession, coolMessengerOfficeId } from './services/coolmessenger-protocol'
import { AttachmentAutoSaver } from './services/attachments'
import { buildEventDescription, readRecentMessages } from './services/messages'

function messageStateDbId(dbPath: string): string {
  return createHash('sha256').update(resolve(dbPath || 'default').toLocaleLowerCase('en-US')).digest('hex').slice(0, 16)
}

function newestReceivedMessageKey(dbPath: string, limit: number): number {
  try {
    return Math.max(0, ...readRecentMessages(dbPath, limit, false).map((message) => message.key))
  } catch {
    return 0
  }
}

function reuseJsonValue<T>(next: T, previous: T): T {
  return JSON.stringify(next) === JSON.stringify(previous) ? previous : next
}

export class AppController {
  private config: AppConfig
  private snapshot: AppSnapshot
  private watchers: FSWatcher[] = []
  private refreshTimer?: NodeJS.Timeout
  private debounceTimer?: NodeJS.Timeout
  private autoAnalysisRunning = false
  private autoAnalysisRetryAt = 0
  private googleSyncRunning = false
  private googleSyncQueued = false
  private googleSyncTimer?: NodeJS.Timeout
  private disposed = false
  private attachmentSaveRunning = false
  private lastMessageSource?: AppSnapshot['messages']
  private lastRecalledMemoIds = ''
  private readonly attachmentSaver = new AttachmentAutoSaver()
  private readonly messenger: CoolMessengerSession

  constructor(
    private readonly windows: () => BrowserWindow[],
    private readonly overlayWindows: () => BrowserWindow[] = () => []
  ) {
    this.config = loadConfig()
    const currentDbId = messageStateDbId(this.config.dbPath)
    if (!this.config.messageStateDbId) {
      this.config = saveConfig({ ...this.config, messageStateDbId: currentDbId })
    } else if (this.config.messageStateDbId !== currentDbId) {
      this.config = saveConfig({
        ...this.config,
        messageStateDbId: currentDbId,
        aiLastProcessedMessageKey: this.config.aiAutoEnabled ? newestReceivedMessageKey(this.config.dbPath, this.config.recentLimit) : 0,
        attachmentAutoSaveLastMessageKey: 0,
        recalledMemoIds: []
      })
    }
    const directory: MessengerDirectory = {
      connected: false, syncing: true, groups: [], contacts: [], error: '', updatedAt: ''
    }
    this.snapshot = { config: this.config, messages: [], events: [], analyses: {}, aiEventSuggestions: [], directory }
    this.messenger = new CoolMessengerSession(this.config.dbPath, (nextDirectory) => {
      this.snapshot = { ...this.snapshot, directory: nextDirectory }
      this.broadcast('directory-changed', nextDirectory)
    }, () => this.refresh())
    this.refresh(false)
    this.restartWatchers()
    this.applyLoginSetting()
    this.messenger.start()
  }

  getConfig(): AppConfig { return this.config }

  getSnapshot(): AppSnapshot { return this.snapshot }

  getOverlaySnapshot(): OverlaySnapshot {
    return { config: this.snapshot.config, events: this.snapshot.events, eventError: this.snapshot.eventError }
  }

  refresh(notify = true): AppSnapshot {
    const previous = this.snapshot
    let messages: AppSnapshot['messages'] = []
    let dbError: string | undefined
    try {
      const source = readRecentMessages(this.config.dbPath, this.config.recentLimit, true, [this.config.attachmentSaveDir])
      const recalledMemoIds = this.config.recalledMemoIds.join(',')
      messages = source === this.lastMessageSource && recalledMemoIds === this.lastRecalledMemoIds
        ? previous.messages
        : source.map((message) => ({
          ...message,
          recalled: message.direction === 'send' && this.config.recalledMemoIds.includes(message.memoId)
        }))
      this.lastMessageSource = source
      this.lastRecalledMemoIds = recalledMemoIds
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error)
      this.lastMessageSource = undefined
    }
    let events: AppSnapshot['events'] = []
    let eventError: string | undefined
    try {
      events = loadEvents(this.config.eventDir)
      events = reuseJsonValue(events, previous.events)
    } catch (error) {
      eventError = error instanceof Error ? error.message : String(error)
    }
    const analyses = dbError ? {} : reuseJsonValue(loadAnalyses(this.config.dbPath), previous.analyses)
    const nextSuggestions = previous.aiEventSuggestions.filter((suggestion) => (
      messages.some((message) => message.direction === 'recv' && message.key === suggestion.messageKey)
      && !suggestion.analysis.autoCreatedEventPath
    ))
    const aiEventSuggestions = nextSuggestions.length === previous.aiEventSuggestions.length
      ? previous.aiEventSuggestions
      : nextSuggestions
    const nextSnapshot: AppSnapshot = {
      config: this.config,
      messages,
      events,
      analyses,
      aiEventSuggestions,
      directory: previous.directory,
      dbError,
      eventError
    }
    const changed = nextSnapshot.config !== previous.config
      || nextSnapshot.messages !== previous.messages
      || nextSnapshot.events !== previous.events
      || nextSnapshot.analyses !== previous.analyses
      || nextSnapshot.aiEventSuggestions !== previous.aiEventSuggestions
      || nextSnapshot.directory !== previous.directory
      || nextSnapshot.dbError !== previous.dbError
      || nextSnapshot.eventError !== previous.eventError
    const calendarChanged = nextSnapshot.config !== previous.config
      || nextSnapshot.events !== previous.events
      || nextSnapshot.eventError !== previous.eventError
    if (changed) this.snapshot = nextSnapshot
    if (notify && changed) this.broadcast('data-changed', this.snapshot)
    if (notify && calendarChanged) this.broadcastOverlay('calendar-changed', this.getOverlaySnapshot())
    if (this.config.aiAutoEnabled) void this.runAutoAnalysis()
    if (this.config.autoSaveAttachments) void this.runAutoAttachmentSave()
    return this.snapshot
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const oldDb = this.config.dbPath
    const oldEventDir = this.config.eventDir
    const nextDb = String(patch.dbPath ?? oldDb)
    const dbChanged = messageStateDbId(oldDb) !== messageStateDbId(nextDb)
    if (dbChanged) {
      const aiEnabled = Boolean(patch.aiAutoEnabled ?? this.config.aiAutoEnabled)
      patch = {
        ...patch,
        messageStateDbId: messageStateDbId(nextDb),
        aiLastProcessedMessageKey: aiEnabled ? newestReceivedMessageKey(nextDb, Number(patch.recentLimit ?? this.config.recentLimit)) : 0,
        attachmentAutoSaveLastMessageKey: 0,
        recalledMemoIds: []
      }
    } else if (patch.aiAutoEnabled && !this.config.aiAutoEnabled && !patch.aiLastProcessedMessageKey) {
      patch = { ...patch, aiLastProcessedMessageKey: Math.max(0, ...this.snapshot.messages.filter((message) => message.direction === 'recv').map((message) => message.key)) }
    }
    this.config = saveConfig({ ...this.config, ...patch })
    if (patch.aiEventSuggestionPopup === false) this.snapshot.aiEventSuggestions = []
    if (dbChanged) this.messenger.updateDbPath(this.config.dbPath)
    this.applyLoginSetting()
    if (dbChanged || oldEventDir !== this.config.eventDir || patch.refreshSeconds) this.restartWatchers()
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
    const messageKey = Number(input.messageKey)
    if (Number.isInteger(messageKey) && messageKey > 0) {
      if (!oldPath) {
        const existing = this.snapshot.events.find((event) => (
          event.sourceMessageKey === messageKey
          && event.sourceMessageDbId === this.config.messageStateDbId
        ))
        if (existing) return existing
      }
      input = { ...input, messageKey, messageDbId: oldPath ? input.messageDbId : this.config.messageStateDbId }
    }
    if (input.messageKey && !input.description) {
      const message = this.snapshot.messages.find((item) => item.key === input.messageKey && item.direction === 'recv')
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
      this.queueGoogleSync()
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

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const result = await this.messenger.sendMessage(input)
    setTimeout(() => this.refresh(), 350)
    return result
  }

  async recallMessage(input: RecallMessageInput): Promise<RecallMessageResult> {
    const message = this.snapshot.messages.find((item) => item.key === Number(input.messageKey) && item.direction === 'send')
    if (!message) throw new Error('회수할 보낸 쪽지를 찾을 수 없습니다.')
    if (message.receipts.some((receipt) => receipt.received)) throw new Error('받는 사람이 이미 수신한 쪽지는 회수할 수 없습니다.')
    if (this.config.recalledMemoIds.includes(message.memoId)) {
      return { recalled: false, alreadyRecalled: true, memoId: message.memoId, recalledAt: '' }
    }
    const result = await this.messenger.recallMessage(input)
    this.config = saveConfig({
      ...this.config,
      recalledMemoIds: [...new Set([...this.config.recalledMemoIds, result.memoId])].slice(-500)
    })
    this.refresh()
    return result
  }

  async loginCoolMessenger(): Promise<void> {
    await this.messenger.login()
  }

  async analyze(messageKey: number): Promise<MessageAnalysis> {
    const message = this.snapshot.messages.find((item) => item.key === messageKey && item.direction === 'recv')
    if (!message) throw new Error('정리할 메시지를 찾을 수 없습니다.')
    let analysis: MessageAnalysis
    try {
      analysis = await analyzeMessage(message, this.config.openaiApiKey, this.config.openaiModel)
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
    return analysis
  }

  dismissAiEventSuggestion(messageKey: number): void {
    const suggestions = this.snapshot.aiEventSuggestions.filter((item) => item.messageKey !== messageKey)
    if (suggestions.length === this.snapshot.aiEventSuggestions.length) return
    this.snapshot = { ...this.snapshot, aiEventSuggestions: suggestions }
    this.broadcast('data-changed', this.snapshot)
  }

  async connectGoogle(): Promise<void> {
    await connectGoogle(this.config)
  }

  async syncGoogle(): Promise<GoogleSyncResult> {
    if (this.googleSyncRunning) throw new Error('Google Calendar 동기화가 이미 진행 중입니다.')
    if (this.googleSyncTimer) {
      clearTimeout(this.googleSyncTimer)
      this.googleSyncTimer = undefined
    }
    this.googleSyncQueued = false
    this.googleSyncRunning = true
    this.broadcast('sync-status', { running: true, message: 'Google Calendar 동기화 중…' })
    try {
      const result = await syncGoogle(this.config, this.config.eventDir)
      this.refresh()
      const conflictText = result.conflicts > 0 ? ` · 충돌 ${result.conflicts} (두 버전 보존)` : ''
      this.broadcast('sync-status', { running: false, message: `가져오기 ${result.imported} · 보내기 ${result.pushed} · 삭제 ${result.deleted}${conflictText}` })
      return result
    } catch (error) {
      this.broadcast('sync-status', { running: false, error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.googleSyncRunning = false
      if (this.googleSyncQueued && !this.disposed) {
        this.googleSyncQueued = false
        this.queueGoogleSync()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const watcher of this.watchers) watcher.close()
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.googleSyncTimer) clearTimeout(this.googleSyncTimer)
    this.messenger.dispose()
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const window of this.windows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  private broadcastOverlay(channel: string, payload: unknown): void {
    for (const window of this.overlayWindows()) {
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
        const watchesEvents = resolve(path) === resolve(this.config.eventDir)
        this.watchers.push(watch(path, () => {
          this.scheduleRefresh()
          if (watchesEvents) this.queueGoogleSync()
        }))
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
    if (this.disposed || !this.config.googleCalendarEnabled) return
    if (this.googleSyncRunning) {
      this.googleSyncQueued = true
      return
    }
    if (this.googleSyncTimer) return
    this.googleSyncTimer = setTimeout(() => {
      this.googleSyncTimer = undefined
      void this.syncGoogle().catch(() => undefined)
    }, 250)
  }

  private async runAutoAnalysis(): Promise<void> {
    if (this.autoAnalysisRunning || !this.config.aiAutoEnabled || Date.now() < this.autoAnalysisRetryAt) return
    const pending = this.snapshot.messages
      .filter((message) => message.direction === 'recv' && message.key > this.config.aiLastProcessedMessageKey)
      .sort((left, right) => left.key - right.key)
    if (!pending.length) return
    this.autoAnalysisRunning = true
    try {
      for (const message of pending) {
        if (!this.config.aiAutoEnabled) break
        const analysis = await this.analyze(message.key)
        if (analysis.error) {
          this.autoAnalysisRetryAt = Date.now() + 5 * 60 * 1000
          this.broadcast('sync-status', { running: false, error: `메시지 자동 정리를 잠시 멈췄습니다. ${analysis.error}` })
          break
        }
        if (this.config.aiEventSuggestionPopup && analysis.shouldCreateEvent && analysis.dueDate) {
          this.enqueueAiEventSuggestion(message.key, analysis)
        }
        this.autoAnalysisRetryAt = 0
        this.config = saveConfig({ ...this.config, aiLastProcessedMessageKey: message.key })
      }
      this.refresh()
    } catch (error) {
      this.autoAnalysisRetryAt = Date.now() + 5 * 60 * 1000
      this.broadcast('sync-status', { running: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.autoAnalysisRunning = false
    }
  }

  private enqueueAiEventSuggestion(messageKey: number, analysis: MessageAnalysis): void {
    const next = this.snapshot.aiEventSuggestions.filter((item) => item.messageKey !== messageKey)
    next.push({ messageKey, analysis })
    this.snapshot = { ...this.snapshot, aiEventSuggestions: next.slice(-20) }
    this.broadcast('data-changed', this.snapshot)
  }

  private async runAutoAttachmentSave(): Promise<void> {
    if (this.attachmentSaveRunning || !this.config.autoSaveAttachments) return
    const received = this.snapshot.messages.filter((message) => message.direction === 'recv')
    const newestKey = Math.max(0, ...received.map((message) => message.key))
    const firstRun = this.config.attachmentAutoSaveLastMessageKey === 0
    const pending = received.filter((message) =>
      message.attachments.length > 0 && Boolean(message.fileSessionId) && (
        (!firstRun && message.key > this.config.attachmentAutoSaveLastMessageKey) ||
        (firstRun && message.unread) ||
        this.attachmentSaver.hasPending(message)
      )
    )
    if (!pending.length) {
      if (newestKey > this.config.attachmentAutoSaveLastMessageKey) {
        this.config = saveConfig({ ...this.config, attachmentAutoSaveLastMessageKey: newestKey })
        this.snapshot = { ...this.snapshot, config: this.config }
      }
      return
    }
    this.attachmentSaveRunning = true
    try {
      const result = await this.attachmentSaver.saveMessages(
        pending,
        this.config,
        coolMessengerOfficeId(),
        () => this.config.autoSaveAttachments
      )
      if (this.config.autoSaveAttachments && newestKey > this.config.attachmentAutoSaveLastMessageKey) {
        this.config = saveConfig({ ...this.config, attachmentAutoSaveLastMessageKey: newestKey })
        this.snapshot = { ...this.snapshot, config: this.config }
      }
      if (result.saved > 0) {
        this.broadcast('sync-status', { running: false, message: `첨부파일 ${result.saved}개를 자동 저장했습니다.` })
        this.refresh()
      } else if (result.failed > 0) {
        this.broadcast('sync-status', { running: false, error: `첨부파일 ${result.failed}개를 저장하지 못했습니다. 잠시 후 다시 시도합니다.` })
      }
    } catch (error) {
      this.broadcast('sync-status', { running: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.attachmentSaveRunning = false
    }
  }
}
