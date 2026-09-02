export type MessageDirection = 'recv' | 'send'

export interface MessageAttachment {
  name: string
  size: number
  sourcePath: string
  localPath: string
  kind: 'image' | 'file'
}

export interface MessageContentBlock {
  type: 'text' | 'image'
  content: string
}

export interface MessageReceipt {
  memberKey: number
  recipient: string
  received: boolean
  receivedAt: string
}

export interface Message {
  key: number
  memoId: number
  direction: MessageDirection
  unread: boolean
  recalled: boolean
  peer: string
  title: string
  whenText: string
  body: string
  filePath: string
  fileSessionId: string
  attachments: MessageAttachment[]
  linkUrl: string
  receipts: MessageReceipt[]
}

export interface CalendarEvent {
  filePath: string
  date: string
  title: string
  description: string
  timeText: string
  allDay: boolean
  endDate: string
  endTimeText: string
  completed: boolean
  sourceMessageKey?: number
  sourceMessageDbId?: string
}

export interface TrashedEvent {
  event: CalendarEvent
  originalPath: string
  deletedAt: string
}

export interface MessageAnalysis {
  messageKey: number
  summary: string
  hasActionItem: boolean
  shouldCreateEvent: boolean
  eventTitle: string
  dueDate: string
  dueTime: string
  allDay: boolean
  reason: string
  autoCreatedEventPath: string
  analyzedAt: string
  model: string
  error: string
}

export interface AiEventSuggestion {
  messageKey: number
  analysis: MessageAnalysis
}

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

export interface AppConfig {
  dbPath: string
  eventDir: string
  refreshSeconds: number
  recentLimit: number
  autoSaveAttachments: boolean
  attachmentSaveDir: string
  attachmentAutoSaveLastMessageKey: number
  messageStateDbId: string
  recallProtocolVersion: number
  recalledMemoIds: number[]
  uiTheme: 'light' | 'dark'
  uiFontFamily: 'coolcalendar' | 'malgun' | 'system'
  uiFontScale: number
  mainBounds?: WindowBounds
  overlayBounds?: WindowBounds
  overlayTheme: 'navy' | 'black' | 'glass'
  overlayOpacity: number
  overlayFontScale: number
  openaiApiKey: string
  openaiModel: string
  aiAutoEnabled: boolean
  aiEventSuggestionPopup: boolean
  aiLastProcessedMessageKey: number
  googleCalendarEnabled: boolean
  googleCalendarId: string
  googleCredentialsPath: string
  googleOauthClientId: string
  googleOauthClientSecret: string
  googleTokenPath: string
  googleTimezone: string
  launchAtLogin: boolean
}

export type ContactPresence = 'online' | 'away' | 'offline' | 'unknown'

export interface MessengerContact {
  key: number
  name: string
  displayName: string
  role: string
  extension: string
  status: ContactPresence
}

export interface MessengerGroup {
  key: number
  name: string
  memberKeys: number[]
}

export interface MessengerDirectory {
  connected: boolean
  syncing: boolean
  groups: MessengerGroup[]
  contacts: MessengerContact[]
  error: string
  updatedAt: string
}

export interface AppSnapshot {
  config: AppConfig
  messages: Message[]
  events: CalendarEvent[]
  analyses: Record<number, MessageAnalysis>
  aiEventSuggestions: AiEventSuggestion[]
  directory: MessengerDirectory
  dbError?: string
  eventError?: string
}

export interface OverlaySnapshot {
  config: AppConfig
  events: CalendarEvent[]
  eventError?: string
}

export interface EventInput {
  filePath?: string
  date: string
  title: string
  description: string
  allDay: boolean
  timeText: string
  endDate?: string
  endTimeText?: string
  messageKey?: number
  messageDbId?: string
}

export interface GoogleSyncResult {
  imported: number
  pushed: number
  deleted: number
  conflicts: number
}

export interface MarkReadResult {
  marked: boolean
  alreadyRead: boolean
}

export interface SendMessageInput {
  recipientKeys: number[]
  title: string
  body: string
  clientSendId: string
}

export interface SendMessageResult {
  sent: boolean
  memoId: number
  recipientCount: number
  sentAt: string
}

export interface RecallMessageInput {
  messageKey: number
  clientRecallId: string
}

export interface RecallMessageResult {
  recalled: boolean
  alreadyRecalled: boolean
  memoId: number
  recalledAt: string
}

export type AppEventName = 'data-changed' | 'directory-changed' | 'calendar-changed' | 'sync-status' | 'overlay-visibility'

export interface CoolCalendarApi {
  getSnapshot: () => Promise<AppSnapshot>
  getOverlaySnapshot: () => Promise<OverlaySnapshot>
  refresh: () => Promise<AppSnapshot>
  saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  choosePath: (kind: 'db' | 'eventDir' | 'attachmentDir' | 'credentials') => Promise<string>
  saveEvent: (input: EventInput) => Promise<CalendarEvent>
  trashEvent: (filePath: string) => Promise<boolean>
  listTrash: () => Promise<TrashedEvent[]>
  restoreEvent: (filePath: string) => Promise<CalendarEvent | null>
  deleteForever: (filePath: string) => Promise<boolean>
  setCompleted: (filePath: string, completed: boolean) => Promise<void>
  loginCoolMessenger: () => Promise<void>
  markMessageRead: (messageKey: number) => Promise<MarkReadResult>
  sendMessage: (input: SendMessageInput) => Promise<SendMessageResult>
  recallMessage: (input: RecallMessageInput) => Promise<RecallMessageResult>
  analyzeMessage: (messageKey: number) => Promise<MessageAnalysis>
  dismissAiEventSuggestion: (messageKey: number) => Promise<void>
  syncGoogle: () => Promise<GoogleSyncResult>
  connectGoogle: () => Promise<void>
  showOverlay: (visible: boolean) => Promise<boolean>
  showMain: () => Promise<void>
  openExternal: (target: string) => Promise<void>
  showItemInFolder: (target: string) => Promise<void>
  getMessageContent: (messageKey: number) => Promise<MessageContentBlock[]>
  setUiZoom: (scale: number) => void
  windowAction: (action: 'minimize' | 'maximize' | 'close') => Promise<void>
  on: (event: AppEventName, callback: (payload: unknown) => void) => () => void
}
