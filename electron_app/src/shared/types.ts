export type MessageDirection = 'recv' | 'send'

export interface Message {
  key: number
  direction: MessageDirection
  unread: boolean
  peer: string
  title: string
  whenText: string
  body: string
  filePath: string
  linkUrl: string
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
  uiTheme: 'light' | 'dark'
  mainBounds?: WindowBounds
  overlayBounds?: WindowBounds
  overlayTheme: 'navy' | 'black' | 'glass'
  overlayOpacity: number
  overlayFontScale: number
  openaiApiKey: string
  openaiModel: string
  aiAutoEnabled: boolean
  aiAutoCreateEvents: boolean
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

export interface AppSnapshot {
  config: AppConfig
  messages: Message[]
  events: CalendarEvent[]
  analyses: Record<number, MessageAnalysis>
  dbError?: string
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
}

export interface GoogleSyncResult {
  imported: number
  pushed: number
  deleted: number
}

export interface MarkReadResult {
  marked: boolean
  alreadyRead: boolean
}

export type AppEventName = 'data-changed' | 'sync-status' | 'overlay-visibility'

export interface CoolCalendarApi {
  getSnapshot: () => Promise<AppSnapshot>
  refresh: () => Promise<AppSnapshot>
  saveConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  choosePath: (kind: 'db' | 'eventDir' | 'credentials') => Promise<string>
  saveEvent: (input: EventInput) => Promise<CalendarEvent>
  trashEvent: (filePath: string) => Promise<boolean>
  listTrash: () => Promise<TrashedEvent[]>
  restoreEvent: (filePath: string) => Promise<CalendarEvent | null>
  deleteForever: (filePath: string) => Promise<boolean>
  setCompleted: (filePath: string, completed: boolean) => Promise<void>
  markMessageRead: (messageKey: number) => Promise<MarkReadResult>
  analyzeMessage: (messageKey: number, createEvent: boolean) => Promise<MessageAnalysis>
  syncGoogle: () => Promise<GoogleSyncResult>
  connectGoogle: () => Promise<void>
  showOverlay: (visible: boolean) => Promise<boolean>
  showMain: () => Promise<void>
  openExternal: (target: string) => Promise<void>
  showItemInFolder: (target: string) => Promise<void>
  windowAction: (action: 'minimize' | 'maximize' | 'close') => Promise<void>
  on: (event: AppEventName, callback: (payload: unknown) => void) => () => void
}
