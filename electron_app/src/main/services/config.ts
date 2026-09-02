import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { AppConfig, WindowBounds } from '../../shared/types'

const CONFIG_NAME = 'config.json'

export function dataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

export function configPath(): string {
  return dataPath(CONFIG_NAME)
}

function detectDefaultDb(): string {
  const memoDir = join(homedir(), 'AppData', 'Local', 'CoolMessenger', 'Memo')
  try {
    const files = readdirSync(memoDir)
      .filter((name) => name.toLowerCase().endsWith('.udb'))
      .map((name) => join(memoDir, name))
      .filter((path) => statSync(path).isFile() && statSync(path).size > 0)
    files.sort((a, b) => statSync(b).size - statSync(a).size)
    return files[0] ?? ''
  } catch {
    return ''
  }
}

function defaultConfig(): AppConfig {
  return {
    dbPath: detectDefaultDb(),
    eventDir: join(homedir(), 'Desktop', 'CoolMessenger Calendar Drop'),
    refreshSeconds: 15,
    recentLimit: 250,
    autoSaveAttachments: false,
    attachmentSaveDir: join(homedir(), 'Documents', 'CoolMessenger Files', 'Received Files'),
    attachmentAutoSaveLastMessageKey: 0,
    messageStateDbId: '',
    recallProtocolVersion: 3,
    recalledMemoIds: [],
    uiTheme: 'light',
    uiFontFamily: 'coolcalendar',
    uiFontScale: 110,
    overlayTheme: 'black',
    overlayOpacity: 72,
    overlayFontScale: 100,
    openaiApiKey: '',
    openaiModel: 'gpt-5.4-mini',
    aiAutoEnabled: false,
    aiEventSuggestionPopup: false,
    aiLastProcessedMessageKey: 0,
    googleCalendarEnabled: false,
    googleCalendarId: 'primary',
    googleCredentialsPath: dataPath('google_credentials.json'),
    googleOauthClientId: '',
    googleOauthClientSecret: '',
    googleTokenPath: dataPath('google_token.json'),
    googleTimezone: 'Asia/Seoul',
    launchAtLogin: false
  }
}

function asBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Partial<WindowBounds>
  if (!Number.isFinite(item.width) || !Number.isFinite(item.height)) return undefined
  return {
    x: Number.isFinite(item.x) ? Number(item.x) : undefined,
    y: Number.isFinite(item.y) ? Number(item.y) : undefined,
    width: Math.max(480, Number(item.width)),
    height: Math.max(320, Number(item.height))
  }
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback
}

function parseLegacyOverlayBounds(value: unknown): WindowBounds | undefined {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined
  try {
    return asBounds(JSON.parse(value))
  } catch {
    return undefined
  }
}

function legacyRoots(): string[] {
  const candidates = [
    resolve(app.getAppPath(), '..', 'desktop_app'),
    resolve(app.getAppPath(), 'desktop_app'),
    resolve(process.cwd(), '..', 'desktop_app'),
    resolve(process.cwd(), 'desktop_app')
  ]
  return [...new Set(candidates)]
}

function findLegacyConfig(): string | undefined {
  return legacyRoots().map((root) => join(root, CONFIG_NAME)).find(existsSync)
}

function migrateLegacyFiles(legacyConfigPath: string, raw: Record<string, unknown>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const fileMappings: Array<[unknown, string]> = [
    [raw.google_token_path, dataPath('google_token.json')],
    [join(dirname(legacyConfigPath), 'google_sync.json'), dataPath('google_sync.json')],
    [join(dirname(legacyConfigPath), 'google_sync_state.json'), dataPath('google_sync_state.json')],
    [join(dirname(legacyConfigPath), 'data', 'event_completion.json'), dataPath('event_completion.json')]
  ]
  for (const [sourceValue, destination] of fileMappings) {
    const source = typeof sourceValue === 'string' ? sourceValue : ''
    if (source && existsSync(source) && !existsSync(destination)) {
      copyFileSync(source, destination)
    }
  }
  const oldAnalysisDir = join(dirname(legacyConfigPath), 'data', 'ai_analyses')
  if (existsSync(oldAnalysisDir)) {
    const newAnalysisDir = dataPath('ai_analyses')
    mkdirSync(newAnalysisDir, { recursive: true })
    for (const name of readdirSync(oldAnalysisDir)) {
      const source = join(oldAnalysisDir, name)
      const destination = join(newAnalysisDir, basename(name))
      if (!existsSync(destination) && statSync(source).isFile()) copyFileSync(source, destination)
    }
  }
}

function fromLegacy(raw: Record<string, unknown>, sourcePath: string): AppConfig {
  const defaults = defaultConfig()
  migrateLegacyFiles(sourcePath, raw)
  return {
    ...defaults,
    dbPath: String(raw.db_path || defaults.dbPath),
    eventDir: String(raw.event_dir || defaults.eventDir),
    refreshSeconds: Number(raw.refresh_seconds || defaults.refreshSeconds),
    recentLimit: Number(raw.recent_limit || defaults.recentLimit),
    overlayBounds: parseLegacyOverlayBounds(raw.overlay_geometry),
    overlayTheme: ['navy', 'black', 'glass'].includes(String(raw.overlay_theme))
      ? (String(raw.overlay_theme) as AppConfig['overlayTheme'])
      : defaults.overlayTheme,
    overlayOpacity: Number(raw.overlay_opacity ?? defaults.overlayOpacity),
    overlayFontScale: Number(raw.overlay_font_scale ?? defaults.overlayFontScale),
    openaiApiKey: String(raw.openai_api_key || ''),
    openaiModel: String(raw.openai_model || defaults.openaiModel),
    aiAutoEnabled: Boolean(raw.ai_auto_enabled),
    aiEventSuggestionPopup: Boolean(raw.ai_event_suggestion_popup ?? raw.ai_auto_create_events),
    aiLastProcessedMessageKey: Number(raw.ai_last_processed_message_key || 0),
    googleCalendarEnabled: Boolean(raw.google_calendar_enabled),
    googleCalendarId: String(raw.google_calendar_id || 'primary'),
    googleCredentialsPath: String(raw.google_credentials_path || defaults.googleCredentialsPath),
    googleOauthClientId: String(raw.google_oauth_client_id || ''),
    googleOauthClientSecret: String(raw.google_oauth_client_secret || ''),
    googleTokenPath: existsSync(dataPath('google_token.json'))
      ? dataPath('google_token.json')
      : String(raw.google_token_path || defaults.googleTokenPath),
    googleTimezone: String(raw.google_timezone || defaults.googleTimezone),
    launchAtLogin: false
  }
}

function normalize(raw: Partial<AppConfig>): AppConfig {
  const defaults = defaultConfig()
  const legacy = raw as Partial<AppConfig> & { aiAutoCreateEvents?: boolean }
  const { aiAutoCreateEvents: legacyAutoCreate, ...clean } = legacy
  const requestedDbPath = String(clean.dbPath || '')
  return {
    ...defaults,
    ...clean,
    dbPath: requestedDbPath && existsSync(requestedDbPath) ? requestedDbPath : defaults.dbPath,
    mainBounds: asBounds(clean.mainBounds),
    overlayBounds: asBounds(clean.overlayBounds),
    uiTheme: clean.uiTheme === 'dark' ? 'dark' : 'light',
    uiFontFamily: ['coolcalendar', 'malgun', 'system'].includes(String(clean.uiFontFamily))
      ? clean.uiFontFamily as AppConfig['uiFontFamily']
      : defaults.uiFontFamily,
    uiFontScale: clampNumber(clean.uiFontScale, defaults.uiFontScale, 90, 135),
    refreshSeconds: clampNumber(clean.refreshSeconds, defaults.refreshSeconds, 3, 3600),
    recentLimit: Math.round(clampNumber(clean.recentLimit, defaults.recentLimit, 20, 2000)),
    attachmentSaveDir: String(clean.attachmentSaveDir || defaults.attachmentSaveDir),
    attachmentAutoSaveLastMessageKey: Math.max(0, Number(clean.attachmentAutoSaveLastMessageKey || 0) || 0),
    messageStateDbId: String(clean.messageStateDbId || ''),
    recallProtocolVersion: 3,
    recalledMemoIds: [...new Set((clean.recallProtocolVersion === 3 && Array.isArray(clean.recalledMemoIds) ? clean.recalledMemoIds : [])
      .map(Number).filter((value) => Number.isInteger(value) && value > 0))].slice(-500),
    aiEventSuggestionPopup: typeof clean.aiEventSuggestionPopup === 'boolean'
      ? clean.aiEventSuggestionPopup
      : Boolean(legacyAutoCreate),
    overlayOpacity: clampNumber(clean.overlayOpacity, defaults.overlayOpacity, 20, 100),
    overlayFontScale: clampNumber(clean.overlayFontScale, defaults.overlayFontScale, 75, 150)
  }
}

function decryptSecret(value: unknown): string {
  const text = String(value || '')
  if (!text.startsWith('enc:')) return text
  try {
    return safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'))
  } catch {
    return ''
  }
}

function encryptSecret(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  return `enc:${safeStorage.encryptString(value).toString('base64')}`
}

function deserializeConfig(raw: Partial<AppConfig>): Partial<AppConfig> {
  return {
    ...raw,
    openaiApiKey: decryptSecret(raw.openaiApiKey),
    googleOauthClientSecret: decryptSecret(raw.googleOauthClientSecret)
  }
}

function serializeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    openaiApiKey: encryptSecret(config.openaiApiKey),
    googleOauthClientSecret: encryptSecret(config.googleOauthClientSecret)
  }
}

export function loadConfig(): AppConfig {
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (existsSync(configPath())) {
    try {
      const loaded = normalize(deserializeConfig(JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AppConfig>))
      saveConfig(loaded)
      return loaded
    } catch {
      // A malformed local config should not prevent the app from starting.
    }
  }
  const legacy = findLegacyConfig()
  let config = defaultConfig()
  if (legacy) {
    try {
      config = fromLegacy(JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, unknown>, legacy)
    } catch {
      config = defaultConfig()
    }
  }
  saveConfig(config)
  return config
}

export function saveConfig(config: AppConfig): AppConfig {
  const normalized = normalize(config)
  mkdirSync(dirname(configPath()), { recursive: true })
  const destination = configPath()
  const temp = `${destination}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(serializeConfig(normalized), null, 2), 'utf8')
    renameSync(temp, destination)
  } finally {
    if (existsSync(temp)) rmSync(temp)
  }
  return normalized
}
