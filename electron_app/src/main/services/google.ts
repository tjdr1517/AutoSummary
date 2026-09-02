import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import type { calendar_v3 } from 'googleapis'
import type { AppConfig, CalendarEvent, EventInput, GoogleSyncResult } from '../../shared/types'
import { dataPath } from './config'
import { buildEventText, eventUid, eventUidFromText, loadEvents, moveEventToTrash, parseIcsFile } from './events'

interface SyncConflict {
  artifactPath: string
  artifactFingerprint: string
  eventId: string
  localFingerprint: string
  remoteFingerprint: string
  detectedAt: string
  resolved: boolean
}

type GoogleApisModule = typeof import('googleapis')
type GoogleOauthClient = InstanceType<GoogleApisModule['google']['auth']['OAuth2']>
let googleApisPromise: Promise<GoogleApisModule> | undefined

function loadGoogleApis(): Promise<GoogleApisModule> {
  googleApisPromise ??= import('googleapis')
  return googleApisPromise
}

interface PendingInsert {
  eventId: string
  path: string
  fingerprint: string
  startedAt: string
  lastCheckedAt: string
}

interface SyncState {
  fingerprints: Record<string, string>
  etags: Record<string, string>
  tokens: Record<string, string>
  tombstones: Record<string, string>
  deletedUids: Record<string, string>
  deleteGuards: Record<string, string>
  uids: Record<string, string>
  pendingInserts: Record<string, PendingInsert>
  conflicts: Record<string, SyncConflict>
}

interface SyncStore {
  version: 2
  revision: number
  target: string
  map: Record<string, string>
  state: SyncState
}

const syncMapPath = (): string => dataPath('google_sync.json')
const syncStatePath = (): string => dataPath('google_sync_state.json')
const legacySyncStorePath = (): string => dataPath('google_sync_store.json')
const syncTargetPointerPath = (): string => dataPath('google_sync_target.json')
const targetSyncStorePath = (target: string): string => dataPath(`google_sync_store_${target}.json`)

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
}

function conflictRecord(value: unknown): Record<string, SyncConflict> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, SyncConflict> = {}
  for (const [path, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<SyncConflict>
    if (!item.artifactPath || !item.eventId) continue
    result[path] = {
      artifactPath: String(item.artifactPath),
      artifactFingerprint: String(item.artifactFingerprint || ''),
      eventId: String(item.eventId),
      localFingerprint: String(item.localFingerprint || ''),
      remoteFingerprint: String(item.remoteFingerprint || ''),
      detectedAt: String(item.detectedAt || ''),
      resolved: Boolean(item.resolved)
    }
  }
  return result
}

function pendingInsertRecord(value: unknown): Record<string, PendingInsert> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, PendingInsert> = {}
  for (const [uid, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Partial<PendingInsert>
    if (!item.fingerprint || !item.startedAt) continue
    result[uid] = {
      eventId: String(item.eventId || `cc${createHash('sha256').update(uid).digest('hex').slice(0, 40)}`),
      path: String(item.path || ''),
      fingerprint: String(item.fingerprint),
      startedAt: String(item.startedAt),
      lastCheckedAt: String(item.lastCheckedAt || item.startedAt)
    }
  }
  return result
}

function activeSyncTarget(): string {
  const target = String(readJson<{ target?: string }>(syncTargetPointerPath(), {}).target || '')
  return /^[a-f0-9]{64}$/.test(target) ? target : ''
}

function knownSyncTargets(): string[] {
  const pointer = readJson<{ target?: string; targets?: unknown }>(syncTargetPointerPath(), {})
  const values = [pointer.target, ...(Array.isArray(pointer.targets) ? pointer.targets : [])]
  return [...new Set(values.map(String).filter((target) => /^[a-f0-9]{64}$/.test(target)))]
}

function syncStorePath(): string {
  const target = activeSyncTarget()
  return target ? targetSyncStorePath(target) : legacySyncStorePath()
}

function loadLegacyState(): SyncState {
  const raw = readJson<Partial<SyncState>>(syncStatePath(), {})
  return {
    fingerprints: stringRecord(raw.fingerprints),
    etags: stringRecord(raw.etags),
    tokens: stringRecord(raw.tokens),
    tombstones: stringRecord(raw.tombstones),
    deletedUids: stringRecord(raw.deletedUids),
    deleteGuards: stringRecord(raw.deleteGuards),
    uids: stringRecord(raw.uids),
    pendingInserts: pendingInsertRecord(raw.pendingInserts),
    conflicts: conflictRecord(raw.conflicts)
  }
}

function normalizedStore(raw: Partial<SyncStore>): SyncStore | undefined {
  if (raw.version === 2 && raw.state && typeof raw.state === 'object') {
    return {
      version: 2,
      revision: Math.max(0, Number(raw.revision) || 0),
      target: String(raw.target || ''),
      map: stringRecord(raw.map),
      state: {
        fingerprints: stringRecord(raw.state.fingerprints),
        etags: stringRecord(raw.state.etags),
        tokens: stringRecord(raw.state.tokens),
        tombstones: stringRecord(raw.state.tombstones),
        deletedUids: stringRecord(raw.state.deletedUids),
        deleteGuards: stringRecord(raw.state.deleteGuards),
        uids: stringRecord(raw.state.uids),
        pendingInserts: pendingInsertRecord(raw.state.pendingInserts),
        conflicts: conflictRecord(raw.state.conflicts)
      }
    }
  }
  return undefined
}

function loadStore(): SyncStore {
  const target = activeSyncTarget()
  const normalized = normalizedStore(readJson<Partial<SyncStore>>(syncStorePath(), {}))
  if (normalized) return normalized
  if (target) return { version: 2, revision: 0, target, map: {}, state: emptySyncState() }
  return {
    version: 2,
    revision: 0,
    target: '',
    map: stringRecord(readJson<Record<string, string>>(syncMapPath(), {})),
    state: loadLegacyState()
  }
}

function updateStore(mutator: (store: SyncStore) => void): SyncStore {
  const store = loadStore()
  mutator(store)
  store.revision += 1
  writeJson(syncStorePath(), store)
  return store
}

function updateEveryTargetStore(mutator: (store: SyncStore) => void): void {
  const targets = knownSyncTargets()
  if (!targets.length) {
    updateStore(mutator)
    return
  }
  for (const target of targets) {
    const path = targetSyncStorePath(target)
    const store = normalizedStore(readJson<Partial<SyncStore>>(path, {}))
    if (!store) continue
    mutator(store)
    store.revision += 1
    writeJson(path, store)
  }
}

function emptySyncState(): SyncState {
  return { fingerprints: {}, etags: {}, tokens: {}, tombstones: {}, deletedUids: {}, deleteGuards: {}, uids: {}, pendingInserts: {}, conflicts: {} }
}

function tokenSubject(config: AppConfig): string {
  const token = readJson<Record<string, unknown>>(config.googleTokenPath, {})
  const idToken = String(token.id_token || '')
  if (idToken) {
    try {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>
      if (payload.sub) return `sub:${String(payload.sub)}`
    } catch { /* Fall back to the refresh-token identity below. */ }
  }
  const refreshToken = String(token.refresh_token || '')
  if (refreshToken) return `refresh:${createHash('sha256').update(refreshToken).digest('hex')}`
  return `token-path:${resolve(config.googleTokenPath || 'google-token').toLocaleLowerCase('en-US')}`
}

function resolvedOauthClientId(config: AppConfig): string {
  let clientId = config.googleOauthClientId || ''
  if (!clientId) {
    try { clientId = oauthClientConfig(config).clientId } catch { /* calendar() reports invalid OAuth configuration. */ }
  }
  return clientId
}

function syncTargetFor(config: AppConfig, clientId: string, subject: string): string {
  return createHash('sha256').update(JSON.stringify({
    calendarId: config.googleCalendarId || 'primary',
    clientId,
    subject
  })).digest('hex')
}

function syncTarget(config: AppConfig): string {
  return syncTargetFor(config, resolvedOauthClientId(config), tokenSubject(config))
}

function provenPriorSyncTargets(config: AppConfig): Set<string> {
  const clientId = resolvedOauthClientId(config)
  const currentSubject = tokenSubject(config)
  const subjects = new Set([currentSubject])
  const token = readJson<Record<string, unknown>>(config.googleTokenPath, {})
  const refreshToken = String(token.refresh_token || '')
  // If the same token file now contains both an OpenID subject and its retained
  // refresh token, the former refresh-hash bucket is provably the same account.
  if (currentSubject.startsWith('sub:') && refreshToken) {
    subjects.add(`refresh:${createHash('sha256').update(refreshToken).digest('hex')}`)
  }
  const clients = new Set([clientId])
  // Older builds hashed an empty client ID when credentials came from a file.
  if (clientId) clients.add('')
  const current = syncTargetFor(config, clientId, currentSubject)
  const result = new Set<string>()
  for (const subject of subjects) {
    for (const candidateClient of clients) {
      const candidate = syncTargetFor(config, candidateClient, subject)
      if (candidate !== current) result.add(candidate)
    }
  }
  return result
}

function prepareSyncStore(config: AppConfig): void {
  const target = syncTarget(config)
  const targetPath = targetSyncStorePath(target)
  let store = normalizedStore(readJson<Partial<SyncStore>>(targetPath, {}))
  let migratedTarget = ''
  if (!store) {
    const current = loadStore()
    const sourceTarget = activeSyncTarget() || current.target
    const provenAlias = Boolean(sourceTarget && provenPriorSyncTargets(config).has(sourceTarget))
    // Earlier v2 builds could keep a declared target only in the legacy
    // combined file. Preserve that bucket before switching the pointer.
    if (!activeSyncTarget() && /^[a-f0-9]{64}$/.test(current.target) && current.target !== target) {
      const previousPath = targetSyncStorePath(current.target)
      if (!normalizedStore(readJson<Partial<SyncStore>>(previousPath, {}))) writeJson(previousPath, current)
      migratedTarget = current.target
    }
    if (current.target === target || provenAlias) {
      store = { ...current, target }
      if (provenAlias) migratedTarget ||= sourceTarget
    } else {
      // A target-less legacy store cannot prove which account/calendar its IDs
      // belong to. UID hints are local identity (and may come from an older
      // sidecar-only disambiguation), so carry only those across targets and
      // rebuild every remote link by UID. Disk UID remains authoritative.
      const state = emptySyncState()
      state.uids = { ...current.state.uids }
      // A pending custom ID is safe to probe in another bucket: adoption still
      // requires the same private UID marker, while a genuine target switch can
      // idempotently create that ID after the grace window. This also bridges a
      // refresh-token-hash bucket to the same account's new OpenID-sub bucket.
      state.pendingInserts = { ...current.state.pendingInserts }
      state.deletedUids = { ...current.state.deletedUids }
      state.deleteGuards = { ...current.state.deleteGuards }
      // Preserve unproven destructive intent as a UID quarantine. Without the
      // old ETag it cannot delete in the new target, but it also cannot silently
      // resurrect the trashed event during import.
      for (const [path, eventId] of Object.entries(current.state.tombstones)) {
        state.deleteGuards[path] = eventId
        const uid = current.state.uids[path]
        if (uid) state.deletedUids[path] = uid
      }
      store = { version: 2, revision: 0, target, map: {}, state }
    }
  }
  store.target = target
  store.revision += 1
  writeJson(targetPath, store)
  const targets = [...new Set([...knownSyncTargets(), migratedTarget, target].filter(Boolean))]
  writeJson(syncTargetPointerPath(), { version: 1, target, targets })
}

function oauthClientConfig(config: AppConfig): { clientId: string; clientSecret: string } {
  if (config.googleOauthClientId && config.googleOauthClientSecret) {
    return { clientId: config.googleOauthClientId, clientSecret: config.googleOauthClientSecret }
  }
  if (config.googleCredentialsPath && existsSync(config.googleCredentialsPath)) {
    const raw = readJson<Record<string, Record<string, unknown>>>(config.googleCredentialsPath, {})
    const item = raw.installed ?? raw.web ?? {}
    return { clientId: String(item.client_id || ''), clientSecret: String(item.client_secret || '') }
  }
  throw new Error('Google OAuth Client ID와 Client Secret을 설정해 주세요.')
}

async function createOauthClient(config: AppConfig, redirectUri = 'http://127.0.0.1'): Promise<GoogleOauthClient> {
  const { google } = await loadGoogleApis()
  const { clientId, clientSecret } = oauthClientConfig(config)
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  if (config.googleTokenPath && existsSync(config.googleTokenPath)) {
    const token = readJson<Record<string, unknown>>(config.googleTokenPath, {})
    client.setCredentials({
      access_token: String(token.access_token ?? token.token ?? '') || undefined,
      refresh_token: String(token.refresh_token ?? '') || undefined,
      scope: Array.isArray(token.scopes) ? token.scopes.join(' ') : String(token.scope ?? ''),
      token_type: String(token.token_type ?? 'Bearer'),
      expiry_date: typeof token.expiry_date === 'number'
        ? token.expiry_date
        : token.expiry ? Date.parse(String(token.expiry)) : undefined
    })
  }
  client.on('tokens', (tokens) => {
    const previous = readJson<Record<string, unknown>>(config.googleTokenPath, {})
    writeJson(config.googleTokenPath, { ...previous, ...tokens })
  })
  return client
}

export async function connectGoogle(config: AppConfig): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || '/', `http://${request.headers.host}`)
        const code = url.searchParams.get('code')
        if (!code) throw new Error(url.searchParams.get('error') || '인증 코드가 없습니다.')
        const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const client = await createOauthClient(config, redirectUri)
        const { tokens } = await client.getToken(code)
        writeJson(config.googleTokenPath, tokens)
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<h2>CoolCalendar 연결이 완료되었습니다.</h2><p>이 창을 닫아도 됩니다.</p>')
        server.close()
        resolvePromise()
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(error instanceof Error ? error.message : String(error))
        server.close()
        reject(error)
      }
    })
    server.listen(0, '127.0.0.1', async () => {
      try {
        const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const client = await createOauthClient(config, redirectUri)
        const url = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: ['openid', 'https://www.googleapis.com/auth/calendar.events']
        })
        await shell.openExternal(url)
      } catch (error) {
        server.close()
        reject(error)
      }
    })
    server.setTimeout(180_000, () => {
      server.close()
      reject(new Error('Google 인증 시간이 초과되었습니다.'))
    })
  })
}

async function calendar(config: AppConfig): Promise<calendar_v3.Calendar> {
  const { google } = await loadGoogleApis()
  const auth = await createOauthClient(config)
  if (!auth.credentials.refresh_token && !auth.credentials.access_token) throw new Error('먼저 Google Calendar에 연결해 주세요.')
  return google.calendar({ version: 'v3', auth })
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
}

function fingerprint(event: CalendarEvent): string {
  return createHash('sha256').update(stableJson({
    all_day: event.allDay,
    date: event.date,
    description: event.description,
    end_date: event.endDate,
    end_time_text: event.allDay ? '' : event.endTimeText,
    source_message_db_id: event.sourceMessageDbId || '',
    source_message_key: event.sourceMessageKey || 0,
    time_text: event.allDay ? '' : event.timeText,
    title: event.title
  })).digest('hex')
}

function googleBody(event: CalendarEvent, timezone: string, uid: string): calendar_v3.Schema$Event {
  const privateProperties: Record<string, string> = { coolcalendar_uid: uid }
  if (event.sourceMessageKey) privateProperties.coolcalendar_message_key = String(event.sourceMessageKey)
  if (event.sourceMessageDbId) privateProperties.coolcalendar_message_db_id = event.sourceMessageDbId
  const body: calendar_v3.Schema$Event = {
    summary: event.title || '새 일정',
    description: event.description || '',
    extendedProperties: { private: privateProperties }
  }
  if (event.allDay || !event.timeText || event.timeText === '종일') {
    body.start = { date: event.date }
    body.end = { date: event.endDate && event.endDate > event.date ? event.endDate : addDays(event.date, 1) }
  } else {
    const start = `${event.date}T${event.timeText}:00`
    let endDate = event.endDate || event.date
    let endTime = event.endTimeText || addMinutes(event.date, event.timeText, 30).time
    if (`${endDate}T${endTime}` <= `${event.date}T${event.timeText}`) {
      const fallback = addMinutes(event.date, event.timeText, 30)
      endDate = fallback.date
      endTime = fallback.time
    }
    body.start = { dateTime: start, timeZone: timezone }
    body.end = { dateTime: `${endDate}T${endTime}:00`, timeZone: timezone }
  }
  return body
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + days)
  return value.toLocaleDateString('sv-SE')
}
function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const value = new Date(`${date}T${time}:00`)
  value.setMinutes(value.getMinutes() + minutes)
  return { date: value.toLocaleDateString('sv-SE'), time: value.toTimeString().slice(0, 5) }
}

function errorCode(error: unknown): number {
  const candidate = error as { code?: number | string; response?: { status?: number } }
  return Number(candidate.code ?? candidate.response?.status)
}

function mappedPathForId(store: SyncStore, eventId: string): string {
  return Object.entries(store.map).find(([, id]) => id === eventId)?.[0] || ''
}

function pathInsideEventDir(path: string, eventDir: string): boolean {
  if (!path || extname(path).toLowerCase() !== '.ics') return false
  const result = relative(resolve(eventDir), resolve(path))
  return Boolean(result) && !result.startsWith('..') && !isAbsolute(result) && dirname(result) === '.'
}

function remoteMarker(item: calendar_v3.Schema$Event): string {
  const value = String(item.extendedProperties?.private?.coolcalendar_uid || '').trim()
  return value && value.length <= 1024 ? safeSyncUid(value) : ''
}

function remoteUid(item: calendar_v3.Schema$Event): string {
  return remoteMarker(item) || `${item.id}@google.calendar`
}

function calendarEventFromInput(input: EventInput, filePath = ''): CalendarEvent {
  return {
    filePath,
    date: input.date,
    title: input.title,
    description: input.description,
    timeText: input.allDay ? '종일' : input.timeText,
    allDay: input.allDay,
    endDate: input.endDate || '',
    endTimeText: input.allDay ? '' : input.endTimeText || '',
    completed: false,
    sourceMessageKey: input.messageKey,
    sourceMessageDbId: input.messageDbId
  }
}

function remoteFingerprint(item: calendar_v3.Schema$Event, timezone: string): string {
  const input = googleItemToInput(item, timezone)
  return input ? fingerprint(calendarEventFromInput(input)) : ''
}

function safeRemoteTitle(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Google 일정'
}

function availableRemotePath(eventDir: string, input: EventInput, suffix = ''): string {
  const ending = suffix ? ` ${suffix}` : ''
  const first = join(eventDir, `${input.date}-${safeRemoteTitle(input.title)}${ending}.ics`)
  if (!existsSync(first)) return first
  const base = first.slice(0, -4)
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} (${index}).ics`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('Google 일정을 저장할 빈 파일명을 만들 수 없습니다.')
}

function writeEventAtomic(target: string, input: EventInput, uid: string): CalendarEvent {
  mkdirSync(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, buildEventText({ ...input, filePath: target }, uid), 'utf8')
    renameSync(temp, target)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
  }
  const event = parseIcsFile(target)
  if (!event) throw new Error('Google 일정을 로컬 파일로 저장하지 못했습니다.')
  return event
}

function syncFileUid(path: string): string {
  return eventUid(path)
}

function rewriteEventUidAtomic(path: string, expectedUid: string, uid: string): void {
  const original = readFileSync(path, 'utf8')
  const uidLine = /^UID(?:;[^:\r\n]*)?:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/im
  const eventCount = original.match(/^BEGIN:VEVENT[ \t]*\r?$/gim)?.length || 0
  if (eventCount !== 1) throw new Error('단일 VEVENT ICS 파일에서만 UID를 안전하게 변경할 수 있습니다.')
  const currentUid = eventUidFromText(original)
  if (currentUid !== expectedUid) throw new Error('UID 기록 중 ICS 파일이 외부에서 변경되었습니다. 다시 동기화해 주세요.')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const begin = /^BEGIN:VEVENT[ \t]*\r?$/im.exec(original)
  const endPattern = /^END:VEVENT[ \t]*\r?$/gim
  endPattern.lastIndex = (begin?.index || 0) + (begin?.[0].length || 0)
  const end = endPattern.exec(original)
  if (!begin || !end) throw new Error('ICS 파일에서 UID를 기록할 VEVENT를 찾지 못했습니다.')
  const eventStart = begin.index + begin[0].length
  const eventBody = original.slice(eventStart, end.index)
  const uidMatches = eventBody.match(new RegExp(uidLine.source, 'gim')) || []
  if (uidMatches.length > 1) throw new Error('단일 VEVENT ICS 파일에서만 UID를 안전하게 변경할 수 있습니다.')
  const nextBody = uidMatches.length === 1
    ? eventBody.replace(uidLine, (line) => `${line.slice(0, line.indexOf(':') + 1)}${uid}`)
    : `${eventBody}UID:${uid}${newline}`
  const next = `${original.slice(0, eventStart)}${nextBody}${original.slice(end.index)}`
  if (next === original && currentUid === uid) return
  if (next === original) throw new Error('ICS 파일에서 UID를 기록할 VEVENT를 찾지 못했습니다.')
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.uid.tmp`)
  try {
    writeFileSync(temp, next, 'utf8')
    if (!parseIcsFile(temp) || syncFileUid(temp) !== uid) throw new Error('ICS UID 기록을 검증하지 못했습니다.')
    if (readFileSync(path, 'utf8') !== original) throw new Error('UID 기록 중 ICS 파일이 외부에서 변경되었습니다. 다시 동기화해 주세요.')
    renameSync(temp, path)
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true })
  }
}

function localUid(event: CalendarEvent, store: SyncStore): string {
  return safeSyncUid(store.state.uids[event.filePath] || syncFileUid(event.filePath))
}

function findLocalPathByUid(eventDir: string, uid: string, store = loadStore()): string {
  if (!uid) return ''
  const pendingPath = store.state.pendingInserts[uid]?.path || ''
  if (pendingPath && pathInsideEventDir(pendingPath, eventDir) && existsSync(pendingPath)) return pendingPath
  const statePath = Object.entries(store.state.uids)
    .find(([path, value]) => value === uid && pathInsideEventDir(path, eventDir) && existsSync(path))?.[0]
  if (statePath) return statePath
  return loadEvents(eventDir).find((event) => {
    const diskUid = syncFileUid(event.filePath)
    return Boolean(diskUid) && safeSyncUid(diskUid) === uid
  })?.filePath || ''
}

function safeSyncUid(value: string): string {
  const candidate = value.trim()
  if (candidate && candidate.length <= 512 && /^[A-Za-z0-9._@+-]+$/.test(candidate) && !isAbsolute(candidate)) {
    return candidate
  }
  return `cc-${createHash('sha256').update(candidate || randomUUID()).digest('hex').slice(0, 32)}@coolcalendar-sync`
}

function ensureLocalUid(event: CalendarEvent): string {
  const snapshot = loadStore()
  const stored = snapshot.state.uids[event.filePath]
  const rawUid = syncFileUid(event.filePath)
  const ownedPending = Object.entries(snapshot.state.pendingInserts).find(([pendingUid, pending]) => {
    if (pending.path) return pending.path === event.filePath
    return snapshot.state.uids[event.filePath] === pendingUid
  })
  if (ownedPending) {
    // Finish/adopt the old idempotent insert before changing its UID marker.
    // The disk UID remains untouched; after checkpointing the old custom ID, a
    // queued sync can safely patch the remote marker to the externally edited UID.
    return safeSyncUid(ownedPending[0])
  }
  let current = safeSyncUid(rawUid || stored)
  const duplicatePaths = loadEvents(dirname(event.filePath))
    .filter((candidate) => {
      const candidateUid = syncFileUid(candidate.filePath)
      return Boolean(candidateUid) && safeSyncUid(candidateUid) === current
    })
    .map((candidate) => candidate.filePath)
  if (duplicatePaths.length > 1) {
    const canonical = duplicatePaths.sort((left, right) => {
      const mappedDifference = Number(Boolean(snapshot.map[right])) - Number(Boolean(snapshot.map[left]))
      const originalOwnerDifference = Number(snapshot.state.uids[right] === current) - Number(snapshot.state.uids[left] === current)
      return mappedDifference || originalOwnerDifference || resolve(left).localeCompare(resolve(right), 'en-US')
    })[0]
    if (canonical !== event.filePath) {
      const storedCandidate = stored && stored !== rawUid ? safeSyncUid(stored) : ''
      const storedOwner = storedCandidate && loadEvents(dirname(event.filePath)).find((candidate) => {
        if (candidate.filePath === event.filePath) return false
        const candidateUid = syncFileUid(candidate.filePath) || snapshot.state.uids[candidate.filePath]
        return Boolean(candidateUid) && safeSyncUid(candidateUid) === storedCandidate
      })
      current = storedCandidate && !storedOwner ? storedCandidate : `${randomUUID()}@coolcalendar-sync`
    }
  }
  if (rawUid !== current) rewriteEventUidAtomic(event.filePath, rawUid, current)
  if (stored !== current) {
    updateStore((store) => { store.state.uids[event.filePath] = current })
  }
  return current
}

const INSERT_RECONCILE_GRACE_MS = 5 * 60_000

function newGoogleEventId(): string {
  return `cc${randomUUID().replaceAll('-', '')}`
}

function markPendingInsert(uid: string, baseFingerprint: string, path: string): PendingInsert {
  let pending!: PendingInsert
  updateStore((store) => {
    const now = new Date().toISOString()
    const existing = store.state.pendingInserts[uid]
    pending = existing
      ? { ...existing, path: existing.path || path, lastCheckedAt: now }
      : { eventId: newGoogleEventId(), path, fingerprint: baseFingerprint, startedAt: now, lastCheckedAt: now }
    store.state.pendingInserts[uid] = pending
  })
  return pending
}

function touchPendingInsert(uid: string): PendingInsert | undefined {
  let pending: PendingInsert | undefined
  updateStore((store) => {
    const current = store.state.pendingInserts[uid]
    if (!current) return
    current.lastCheckedAt = new Date().toISOString()
    pending = { ...current }
  })
  return pending
}

function clearPendingInsert(uid: string): void {
  if (!loadStore().state.pendingInserts[uid]) return
  updateStore((store) => { delete store.state.pendingInserts[uid] })
}

function pendingInsertWithinGrace(pending: PendingInsert): boolean {
  const started = Date.parse(pending.startedAt)
  return Number.isFinite(started) && Date.now() - started < INSERT_RECONCILE_GRACE_MS
}

function moveConflictPath(store: SyncStore, oldPath: string, newPath: string): void {
  if (store.state.conflicts[oldPath]) {
    const conflict = store.state.conflicts[oldPath]
    delete store.state.conflicts[oldPath]
    if (conflict.artifactPath === oldPath) conflict.artifactPath = newPath
    store.state.conflicts[newPath] = conflict
  }
  for (const conflict of Object.values(store.state.conflicts)) {
    if (conflict.artifactPath === oldPath) conflict.artifactPath = newPath
  }
}

function assignMapping(store: SyncStore, path: string, eventId: string, baseFingerprint: string, uid: string, etag = ''): void {
  for (const [otherPath, id] of Object.entries(store.map)) {
    if (otherPath === path || id !== eventId) continue
    delete store.map[otherPath]
    delete store.state.fingerprints[otherPath]
    delete store.state.etags[otherPath]
    delete store.state.uids[otherPath]
    moveConflictPath(store, otherPath, path)
  }
  store.map[path] = eventId
  store.state.fingerprints[path] = baseFingerprint
  if (etag) store.state.etags[path] = etag
  store.state.uids[path] = uid
  delete store.state.pendingInserts[uid]
  for (const [trashPath, id] of Object.entries(store.state.tombstones)) {
    if (id === eventId) delete store.state.tombstones[trashPath]
  }
  for (const [trashPath, deletedUid] of Object.entries(store.state.deletedUids)) {
    if (deletedUid === uid) delete store.state.deletedUids[trashPath]
  }
}

function linkMapping(path: string, eventId: string, uid: string): void {
  updateStore((store) => {
    for (const [otherPath, id] of Object.entries(store.map)) {
      if (otherPath === path || id !== eventId) continue
      delete store.map[otherPath]
      if (!store.state.fingerprints[path] && store.state.fingerprints[otherPath]) {
        store.state.fingerprints[path] = store.state.fingerprints[otherPath]
      }
      if (!store.state.etags[path] && store.state.etags[otherPath]) store.state.etags[path] = store.state.etags[otherPath]
      delete store.state.fingerprints[otherPath]
      delete store.state.etags[otherPath]
      delete store.state.uids[otherPath]
      moveConflictPath(store, otherPath, path)
    }
    store.map[path] = eventId
    store.state.uids[path] = uid
    delete store.state.pendingInserts[uid]
  })
}

function checkpointMapping(path: string, eventId: string, baseFingerprint: string, uid: string, etag = ''): void {
  updateStore((store) => assignMapping(store, path, eventId, baseFingerprint, uid, etag))
}

function checkpointRemoteWrite(eventDir: string, fallbackPath: string, eventId: string, baseFingerprint: string, uid: string, etag = ''): void {
  const diskPath = existsSync(fallbackPath) ? fallbackPath : findLocalPathByUid(eventDir, uid)
  updateStore((store) => {
    const tombstonePath = Object.entries(store.state.tombstones).find(([, id]) => id === eventId)?.[0]
    if (tombstonePath) {
      store.state.fingerprints[tombstonePath] = baseFingerprint
      if (etag) store.state.etags[tombstonePath] = etag
      store.state.uids[tombstonePath] = uid
      delete store.state.pendingInserts[uid]
      return
    }
    const mappedPath = mappedPathForId(store, eventId)
    const uidPath = Object.entries(store.state.uids).find(([, value]) => value === uid)?.[0] || ''
    const activeMappedPath = mappedPath && pathInsideEventDir(mappedPath, eventDir) && existsSync(mappedPath) ? mappedPath : ''
    const activeUidPath = uidPath && pathInsideEventDir(uidPath, eventDir) && existsSync(uidPath) ? uidPath : ''
    const path = activeMappedPath || activeUidPath || diskPath || mappedPath || uidPath || fallbackPath
    if (!pathInsideEventDir(path, eventDir)) {
      store.state.tombstones[path] = eventId
      delete store.state.deletedUids[path]
      store.state.fingerprints[path] = baseFingerprint
      if (etag) store.state.etags[path] = etag
      store.state.uids[path] = uid
      delete store.state.pendingInserts[uid]
      if (mappedPath) delete store.map[mappedPath]
      return
    }
    assignMapping(store, path, eventId, baseFingerprint, uid, etag)
  })
}

function markConflictResolved(path: string, localFingerprint: string, remoteValue: string): void {
  const conflict = loadStore().state.conflicts[path]
  if (!conflict) return
  updateStore((store) => {
    const current = store.state.conflicts[path]
    if (!current) return
    current.localFingerprint = localFingerprint
    current.remoteFingerprint = remoteValue
    current.resolved = true
  })
}

function recordConflict(
  eventDir: string,
  local: CalendarEvent,
  item: calendar_v3.Schema$Event,
  input: EventInput,
  localFingerprint: string,
  remoteValue: string
): void {
  const current = loadStore().state.conflicts[local.filePath]
  if (current?.artifactPath && existsSync(current.artifactPath)) {
    updateStore((store) => {
      const conflict = store.state.conflicts[local.filePath]
      if (!conflict) return
      conflict.localFingerprint = localFingerprint
      conflict.remoteFingerprint = remoteValue
      conflict.detectedAt = new Date().toISOString()
      conflict.resolved = false
    })
    return
  }
  const artifactPath = availableRemotePath(eventDir, input, '(Google 충돌)')
  const conflictInput: EventInput = { ...input, title: `[Google 충돌] ${input.title || 'Google 일정'}` }
  const artifactUid = `${randomUUID()}@coolcalendar-conflict`
  const artifact = writeEventAtomic(artifactPath, conflictInput, artifactUid)
  updateStore((store) => {
    store.state.uids[artifactPath] = artifactUid
    store.state.conflicts[local.filePath] = {
      artifactPath,
      artifactFingerprint: fingerprint(artifact),
      eventId: String(item.id),
      localFingerprint,
      remoteFingerprint: remoteValue,
      detectedAt: new Date().toISOString(),
      resolved: false
    }
  })
}

function recordDeletionConflict(local: CalendarEvent, eventId: string, localFingerprint: string): void {
  updateStore((store) => {
    const existing = store.state.conflicts[local.filePath]
    const preservesExistingArtifact = Boolean(existing?.artifactPath && existsSync(existing.artifactPath))
    store.state.conflicts[local.filePath] = {
      artifactPath: preservesExistingArtifact ? existing.artifactPath : local.filePath,
      artifactFingerprint: preservesExistingArtifact ? existing.artifactFingerprint : localFingerprint,
      eventId,
      localFingerprint,
      remoteFingerprint: '__deleted__',
      detectedAt: new Date().toISOString(),
      resolved: false
    }
  })
}

function conflictArtifactPaths(store = loadStore()): Set<string> {
  return new Set(Object.values(store.state.conflicts).map((conflict) => conflict.artifactPath))
}

interface RemoteIndex {
  byId: Map<string, calendar_v3.Schema$Event>
  byUid: Map<string, calendar_v3.Schema$Event>
}

interface SyncDelta {
  imported: number
  pushed: number
}

function addRemoteToIndex(index: RemoteIndex, item: calendar_v3.Schema$Event): void {
  if (!item.id) return
  index.byId.set(item.id, item)
  const marker = remoteMarker(item)
  if (marker && item.status !== 'cancelled' && !index.byUid.has(marker)) index.byUid.set(marker, item)
}

async function listRemoteEvents(api: calendar_v3.Calendar, config: AppConfig): Promise<calendar_v3.Schema$Event[]> {
  const today = new Date().toLocaleDateString('sv-SE')
  const min = new Date(`${addDays(today, -90)}T00:00:00`).toISOString()
  const max = new Date(`${addDays(today, 550)}T00:00:00`).toISOString()
  const items: calendar_v3.Schema$Event[] = []
  const seenTokens = new Set<string>()
  let pageToken: string | undefined
  do {
    const response = await api.events.list({
      calendarId: config.googleCalendarId || 'primary', singleEvents: true, showDeleted: true,
      timeMin: min, timeMax: max, orderBy: 'startTime', maxResults: 2500, pageToken
    })
    items.push(...(response.data.items ?? []))
    const next = response.data.nextPageToken || undefined
    if (!next || seenTokens.has(next)) break
    seenTokens.add(next)
    pageToken = next
  } while (pageToken)
  return items
}

async function findRemotesByUid(api: calendar_v3.Calendar, config: AppConfig, uid: string): Promise<calendar_v3.Schema$Event[]> {
  const response = await api.events.list({
    calendarId: config.googleCalendarId || 'primary',
    privateExtendedProperty: [`coolcalendar_uid=${uid}`],
    showDeleted: false,
    singleEvents: true,
    maxResults: 2500
  })
  return (response.data.items ?? []).filter((item) => Boolean(item.id) && item.status !== 'cancelled')
}

async function findRemoteByUid(api: calendar_v3.Calendar, config: AppConfig, uid: string): Promise<calendar_v3.Schema$Event | undefined> {
  return (await findRemotesByUid(api, config, uid))[0]
}

async function findRemoteByUidWithRetry(api: calendar_v3.Calendar, config: AppConfig, uid: string): Promise<calendar_v3.Schema$Event | undefined> {
  for (const delay of [0, 250, 750, 1500]) {
    if (delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay))
    const event = await findRemoteByUid(api, config, uid)
    if (event) return event
  }
  return undefined
}

async function fetchRemoteById(api: calendar_v3.Calendar, config: AppConfig, eventId: string): Promise<calendar_v3.Schema$Event | undefined> {
  try {
    return (await api.events.get({ calendarId: config.googleCalendarId || 'primary', eventId })).data
  } catch (error) {
    if ([404, 410].includes(errorCode(error))) return undefined
    throw error
  }
}

function recordTrashConflict(path: string, eventId: string, localValue: string, remoteValue: string): void {
  updateStore((store) => {
    store.state.conflicts[path] = {
      artifactPath: path,
      artifactFingerprint: localValue,
      eventId,
      localFingerprint: localValue,
      remoteFingerprint: remoteValue,
      detectedAt: new Date().toISOString(),
      resolved: false
    }
  })
}

function checkpointRemoteDeletion(path: string, eventId: string): void {
  updateStore((store) => {
    if (store.state.tombstones[path] === eventId) {
      delete store.state.tombstones[path]
      delete store.state.fingerprints[path]
      delete store.state.etags[path]
      delete store.state.uids[path]
      delete store.state.conflicts[path]
      return
    }
    // A restore may race with an already-issued remote delete. Detach the restored
    // local file from the deleted ID so the queued sync recreates it safely.
    const restoredPath = mappedPathForId(store, eventId)
    if (restoredPath) {
      delete store.map[restoredPath]
      delete store.state.fingerprints[restoredPath]
      delete store.state.etags[restoredPath]
      delete store.state.conflicts[restoredPath]
    }
  })
}

async function flushTombstones(api: calendar_v3.Calendar, config: AppConfig, conflicts: Set<string>): Promise<number> {
  let deleted = 0
  for (const [path, id] of Object.entries(loadStore().state.tombstones)) {
    const remote = await fetchRemoteById(api, config, id)
    if (loadStore().state.tombstones[path] !== id) continue
    if (remote) {
      const remoteValue = remoteFingerprint(remote, config.googleTimezone || 'Asia/Seoul')
      const currentStore = loadStore()
      const base = currentStore.state.fingerprints[path]
      const baseEtag = currentStore.state.etags[path]
      const remoteChanged = !baseEtag || remote.etag !== baseEtag
      if (!base || !remoteValue || remoteChanged || !remote.etag) {
        const local = parseIcsFile(path)
        recordTrashConflict(path, id, base || (local ? fingerprint(local) : ''), remoteValue)
        conflicts.add(id)
        continue
      }
      try {
        await api.events.delete({ calendarId: config.googleCalendarId || 'primary', eventId: id }, { headers: { 'If-Match': remote.etag } })
      } catch (error) {
        const code = errorCode(error)
        if (code === 412) {
          const latest = await fetchRemoteById(api, config, id)
          if (latest) {
            if (loadStore().state.tombstones[path] === id) {
              recordTrashConflict(path, id, base, remoteFingerprint(latest, config.googleTimezone || 'Asia/Seoul'))
              conflicts.add(id)
            }
            continue
          }
        }
        if (![404, 410].includes(code)) throw error
      }
    }
    checkpointRemoteDeletion(path, id)
    deleted += 1
  }
  return deleted
}

async function flushUidTombstones(api: calendar_v3.Calendar, config: AppConfig, conflicts: Set<string>): Promise<number> {
  let deleted = 0
  for (const [path, uid] of Object.entries(loadStore().state.deletedUids)) {
    const deleteGuard = loadStore().state.deleteGuards[path]
    if (deleteGuard) {
      conflicts.add(`guard:${deleteGuard}`)
      continue
    }
    let matches = await findRemotesByUid(api, config, uid)
    let pending = loadStore().state.pendingInserts[uid]
    if (pending) {
      const byId = await fetchRemoteById(api, config, pending.eventId)
      if (byId && remoteMarker(byId) !== uid) {
        // The custom ID is occupied by an unrelated event. Never delete it;
        // abandon this insert attempt so a restore can allocate a fresh ID.
        conflicts.add(pending.eventId)
        clearPendingInsert(uid)
        pending = undefined
      } else if (byId?.id && !matches.some((item) => item.id === byId.id)) {
        matches.push(byId)
      }
    }
    if (!matches.length && pending) {
      touchPendingInsert(uid)
      conflicts.add(`pending:${pending.eventId}`)
      continue
    }
    const local = parseIcsFile(path)
    const localValue = local ? fingerprint(local) : ''
    const baseEtag = loadStore().state.etags[path]
    const expectedValue = pending?.fingerprint || localValue
    const divergent = matches.find((item) => {
      if (!item.etag || remoteFingerprint(item, config.googleTimezone || 'Asia/Seoul') !== expectedValue) return true
      // A pending insert has no stored ETag, but its durable custom event ID and
      // original payload fingerprint establish the safe deletion base.
      return !pending && (!baseEtag || item.etag !== baseEtag)
    })
    if (divergent?.id) {
      recordTrashConflict(path, divergent.id, localValue, remoteFingerprint(divergent, config.googleTimezone || 'Asia/Seoul'))
      conflicts.add(divergent.id)
      continue
    }
    let blocked = false
    const removedIds = new Set<string>()
    for (const item of matches) {
      if (!item.id) continue
      if (loadStore().state.deletedUids[path] !== uid) break
      try { await api.events.delete({ calendarId: config.googleCalendarId || 'primary', eventId: item.id }, { headers: { 'If-Match': item.etag! } }) }
      catch (error) {
        const code = errorCode(error)
        if (code === 412) {
          const latest = await fetchRemoteById(api, config, item.id)
          if (latest) {
            if (loadStore().state.deletedUids[path] === uid) {
              recordTrashConflict(path, item.id, localValue, remoteFingerprint(latest, config.googleTimezone || 'Asia/Seoul'))
              conflicts.add(item.id)
              blocked = true
            }
            break
          }
        }
        if (![404, 410].includes(code)) throw error
      }
      // Keep the UID tombstone until every duplicate has been removed, but persist
      // a fresh combined checkpoint after each successful/idempotent remote delete.
      updateStore(() => undefined)
      removedIds.add(item.id)
      deleted += 1
    }
    if (blocked) continue
    updateStore((store) => {
      if (store.state.deletedUids[path] === uid) {
        delete store.state.deletedUids[path]
        delete store.state.fingerprints[path]
        delete store.state.etags[path]
        delete store.state.uids[path]
        delete store.state.pendingInserts[uid]
        return
      }
      const restoredPath = Object.entries(store.state.uids)
        .find(([candidate, value]) => value === uid && existsSync(candidate))?.[0]
      if (restoredPath) {
        delete store.state.fingerprints[restoredPath]
        delete store.state.etags[restoredPath]
        if (pending && removedIds.has(pending.eventId)) delete store.state.pendingInserts[uid]
      }
    })
  }
  return deleted
}

function googleItemToInput(item: calendar_v3.Schema$Event, timezone: string): EventInput | null {
  const remoteMessageKey = Number(item.extendedProperties?.private?.coolcalendar_message_key)
  const remoteMessageDbId = String(item.extendedProperties?.private?.coolcalendar_message_db_id || '').trim().toLowerCase()
  const source: Pick<EventInput, 'messageKey' | 'messageDbId'> = {
    messageKey: Number.isInteger(remoteMessageKey) && remoteMessageKey > 0 ? remoteMessageKey : undefined,
    messageDbId: /^[0-9a-f]{16}$/.test(remoteMessageDbId) ? remoteMessageDbId : undefined
  }
  const startDate = item.start?.date
  if (startDate) return {
    ...source,
    date: startDate,
    title: item.summary || 'Google 일정',
    description: item.description || '',
    allDay: true,
    timeText: '',
    endDate: item.end?.date || undefined
  }
  if (!item.start?.dateTime) return null
  const start = new Date(item.start.dateTime)
  const end = item.end?.dateTime ? new Date(item.end.dateTime) : null
  const formatterDate = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone })
  const formatterTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return {
    ...source,
    date: formatterDate.format(start),
    title: item.summary || 'Google 일정',
    description: item.description || '',
    allDay: false,
    timeText: formatterTime.format(start),
    endDate: end ? formatterDate.format(end) : undefined,
    endTimeText: end ? formatterTime.format(end) : undefined
  }
}

function mappedLocalPath(eventDir: string, item: calendar_v3.Schema$Event): string {
  const store = loadStore()
  const mapped = mappedPathForId(store, String(item.id))
  if (mapped && pathInsideEventDir(mapped, eventDir) && existsSync(mapped)) return mapped
  if (item.status === 'cancelled') return mapped && pathInsideEventDir(mapped, eventDir) ? mapped : ''
  // Read the legacy absolute-path marker only to migrate an existing event in
  // the currently selected target. New writes never send this private value.
  const legacyPath = String(item.extendedProperties?.private?.coolcalendar_file || '')
  if (legacyPath && pathInsideEventDir(legacyPath, eventDir) && existsSync(legacyPath)) return legacyPath
  const uid = remoteUid(item)
  const candidate = findLocalPathByUid(eventDir, uid, store)
  if (candidate) {
    const otherId = store.map[candidate]
    if (!otherId || otherId === item.id) return candidate
  }
  return mapped && pathInsideEventDir(mapped, eventDir) ? mapped : ''
}

function handleRemoteDeletion(eventDir: string, path: string, item: calendar_v3.Schema$Event, conflicts: Set<string>): number {
  const local = parseIcsFile(path)
  if (!local) {
    updateStore((store) => {
      delete store.map[path]
      delete store.state.fingerprints[path]
      delete store.state.etags[path]
      delete store.state.uids[path]
    })
    return 0
  }
  const store = loadStore()
  const localValue = fingerprint(local)
  const base = store.state.fingerprints[path]
  if (!base || localValue !== base) {
    recordDeletionConflict(local, String(item.id), localValue)
    conflicts.add(String(item.id))
    return 0
  }
  const uid = localUid(local, store)
  const trashed = moveEventToTrash(eventDir, path)
  if (!trashed) return 0
  updateStore((latest) => {
    delete latest.map[path]
    delete latest.state.fingerprints[path]
    delete latest.state.etags[path]
    delete latest.state.uids[path]
    if (uid) latest.state.uids[trashed] = uid
    const conflict = latest.state.conflicts[path]
    if (conflict) {
      delete latest.state.conflicts[path]
      latest.state.conflicts[trashed] = conflict
    }
  })
  return 1
}

function reconcileRemoteItem(eventDir: string, path: string, item: calendar_v3.Schema$Event, input: EventInput, conflicts: Set<string>): number {
  const local = parseIcsFile(path)
  const uid = remoteUid(item)
  const remoteValue = fingerprint(calendarEventFromInput(input))
  if (!local) {
    const target = pathInsideEventDir(path, eventDir) ? path : availableRemotePath(eventDir, input)
    const written = writeEventAtomic(target, input, uid)
    checkpointMapping(target, String(item.id), fingerprint(written), uid, item.etag || '')
    return 1
  }
  const store = loadStore()
  const localValue = fingerprint(local)
  const base = store.state.fingerprints[path]
  const effectiveRemoteValue = remoteValue || fingerprint(calendarEventFromInput(input))
  if (localValue === effectiveRemoteValue) {
    checkpointMapping(path, String(item.id), localValue, uid, item.etag || '')
    markConflictResolved(path, localValue, effectiveRemoteValue)
    return 0
  }
  if (base && localValue === base && effectiveRemoteValue !== base) {
    const written = writeEventAtomic(path, input, uid)
    checkpointMapping(path, String(item.id), fingerprint(written), uid, item.etag || '')
    markConflictResolved(path, fingerprint(written), effectiveRemoteValue)
    return 1
  }
  if (base && localValue !== base && effectiveRemoteValue === base) return 0
  recordConflict(eventDir, local, item, input, localValue, effectiveRemoteValue)
  conflicts.add(String(item.id))
  return 0
}

async function importAndReconcileRemote(
  config: AppConfig,
  eventDir: string,
  items: calendar_v3.Schema$Event[],
  index: RemoteIndex,
  conflicts: Set<string>
): Promise<number> {
  let imported = 0
  const timezone = config.googleTimezone || 'Asia/Seoul'
  for (const item of items) {
    if (!item.id) continue
    addRemoteToIndex(index, item)
    const store = loadStore()
    if (Object.values(store.state.tombstones).includes(item.id)) continue
    const itemUid = remoteUid(item)
    const guardedId = Object.values(store.state.deleteGuards).includes(item.id)
    if (guardedId) {
      conflicts.add(String(item.id))
      continue
    }
    if (Object.values(store.state.deletedUids).includes(itemUid)) continue
    let path = mappedLocalPath(eventDir, item)
    if (path && !store.map[path]) {
      const pending = store.state.pendingInserts[itemUid]
      linkMapping(path, item.id, itemUid)
      if (pending) updateStore((latest) => { latest.state.fingerprints[path] = pending.fingerprint })
    }
    if (item.status === 'cancelled') {
      if (path) imported += handleRemoteDeletion(eventDir, path, item, conflicts)
      continue
    }
    const input = googleItemToInput(item, timezone)
    if (!input) continue
    if (!path) {
      path = availableRemotePath(eventDir, input)
      const uid = remoteUid(item)
      const written = writeEventAtomic(path, input, uid)
      checkpointMapping(path, item.id, fingerprint(written), uid, item.etag || '')
      imported += 1
      continue
    }
    imported += reconcileRemoteItem(eventDir, path, item, input, conflicts)
  }
  return imported
}

async function insertOrAdopt(
  api: calendar_v3.Calendar,
  config: AppConfig,
  eventDir: string,
  event: CalendarEvent,
  uid: string,
  index: RemoteIndex,
  conflicts: Set<string>
): Promise<SyncDelta> {
  const pending = loadStore().state.pendingInserts[uid]
  let existing: calendar_v3.Schema$Event | undefined
  if (pending) {
    const byId = await fetchRemoteById(api, config, pending.eventId)
    if (byId && remoteMarker(byId) !== uid) {
      clearPendingInsert(uid)
      throw new Error('Google 일정 ID 충돌이 감지되어 새 일정을 만들지 않았습니다.')
    }
    existing = byId
  }
  existing ||= index.byUid.get(uid) || await findRemoteByUid(api, config, uid)
  if (!existing && pending && pendingInsertWithinGrace(pending)) {
    existing = await findRemoteByUidWithRetry(api, config, uid)
    if (!existing) {
      const byId = await fetchRemoteById(api, config, pending.eventId)
      if (byId && remoteMarker(byId) !== uid) {
        clearPendingInsert(uid)
        throw new Error('Google 일정 ID 충돌이 감지되어 새 일정을 만들지 않았습니다.')
      }
      existing = byId
    }
    if (!existing) {
      touchPendingInsert(uid)
      conflicts.add(`pending:${pending.eventId}`)
      return { imported: 0, pushed: 0 }
    }
  }
  if (existing?.id && existing.status === 'cancelled' && pending?.eventId === existing.id) {
    // A restored/active local file must not be rebound to a confirmed deleted
    // pending instance. Rotate the custom ID and keep the local version visible.
    conflicts.add(existing.id)
    clearPendingInsert(uid)
    existing = index.byUid.get(uid) || await findRemoteByUid(api, config, uid)
  }
  if (existing?.id) {
    addRemoteToIndex(index, existing)
    const current = parseIcsFile(event.filePath)
    if (!current) return { imported: 0, pushed: 0 }
    linkMapping(current.filePath, existing.id, uid)
    if (pending) updateStore((store) => { store.state.fingerprints[current.filePath] = pending.fingerprint })
    const input = googleItemToInput(existing, config.googleTimezone || 'Asia/Seoul')
    if (!input) return { imported: 0, pushed: 0 }
    return { imported: reconcileRemoteItem(eventDir, current.filePath, existing, input, conflicts), pushed: 0 }
  }

  const insertEvent = parseIcsFile(event.filePath)
  if (!insertEvent) return { imported: 0, pushed: 0 }
  const localValue = fingerprint(insertEvent)
  const activePending = markPendingInsert(uid, localValue, insertEvent.filePath)
  const insertEventId = activePending.eventId
  let result: calendar_v3.Schema$Event
  try {
    result = (await api.events.insert({
      calendarId: config.googleCalendarId || 'primary',
      requestBody: { ...googleBody(insertEvent, config.googleTimezone || 'Asia/Seoul', uid), id: insertEventId }
    })).data
  } catch (error) {
    existing = await fetchRemoteById(api, config, insertEventId).catch(() => undefined)
    if (existing && remoteMarker(existing) !== uid) {
      clearPendingInsert(uid)
      throw new Error('Google 일정 ID 충돌이 감지되어 새 일정을 만들지 않았습니다.')
    }
    existing ||= await findRemoteByUidWithRetry(api, config, uid).catch(() => undefined)
    if (!existing?.id) {
      const code = errorCode(error)
      if (code >= 400 && code < 500 && ![408, 409, 429].includes(code)) clearPendingInsert(uid)
      else touchPendingInsert(uid)
      throw error
    }
    if (existing.status === 'cancelled') {
      clearPendingInsert(uid)
      conflicts.add(existing.id)
      existing = index.byUid.get(uid) || await findRemoteByUid(api, config, uid)
      if (!existing?.id) return { imported: 0, pushed: 0 }
    }
    addRemoteToIndex(index, existing)
    const remoteValue = remoteFingerprint(existing, config.googleTimezone || 'Asia/Seoul')
    if (remoteValue && remoteValue !== localValue) {
      const input = googleItemToInput(existing, config.googleTimezone || 'Asia/Seoul')
      const latestPath = findLocalPathByUid(eventDir, uid)
      const latestLocal = parseIcsFile(latestPath || insertEvent.filePath)
      if (input && latestLocal) recordConflict(eventDir, latestLocal, existing, input, fingerprint(latestLocal), remoteValue)
      conflicts.add(existing.id)
      clearPendingInsert(uid)
      return { imported: 0, pushed: 0 }
    }
    checkpointRemoteWrite(eventDir, insertEvent.filePath, existing.id, localValue, uid, existing.etag || '')
    return { imported: 0, pushed: 0 }
  }
  if (!result.id) {
    existing = await fetchRemoteById(api, config, insertEventId) || await findRemoteByUidWithRetry(api, config, uid)
    if (!existing?.id) throw new Error('Google Calendar가 생성된 일정의 식별자를 반환하지 않았습니다.')
    result = existing
  }
  if (result.status === 'cancelled') {
    clearPendingInsert(uid)
    conflicts.add(String(result.id || insertEventId))
    existing = index.byUid.get(uid) || await findRemoteByUid(api, config, uid)
    if (!existing?.id) return { imported: 0, pushed: 0 }
    addRemoteToIndex(index, existing)
    linkMapping(insertEvent.filePath, existing.id, uid)
    if (pending) updateStore((store) => { store.state.fingerprints[insertEvent.filePath] = pending.fingerprint })
    const input = googleItemToInput(existing, config.googleTimezone || 'Asia/Seoul')
    return { imported: input ? reconcileRemoteItem(eventDir, insertEvent.filePath, existing, input, conflicts) : 0, pushed: 0 }
  }
  addRemoteToIndex(index, result)
  checkpointRemoteWrite(eventDir, insertEvent.filePath, result.id, localValue, uid, result.etag || '')
  return { imported: 0, pushed: 1 }
}

async function resolveUpdateRace(
  api: calendar_v3.Calendar,
  config: AppConfig,
  eventDir: string,
  event: CalendarEvent,
  eventId: string,
  uid: string,
  index: RemoteIndex,
  conflicts: Set<string>,
  latest: calendar_v3.Schema$Event | undefined,
  attempts: number
): Promise<SyncDelta> {
  const current = parseIcsFile(event.filePath)
  if (!current) return { imported: 0, pushed: 0 }
  const localValue = fingerprint(current)
  if (!latest?.id || latest.status === 'cancelled') {
    recordDeletionConflict(current, latest?.id || eventId, localValue)
    conflicts.add(latest?.id || eventId)
    return { imported: 0, pushed: 0 }
  }
  addRemoteToIndex(index, latest)
  const input = googleItemToInput(latest, config.googleTimezone || 'Asia/Seoul')
  if (!input) {
    conflicts.add(latest.id)
    return { imported: 0, pushed: 0 }
  }
  const remoteValue = fingerprint(calendarEventFromInput(input))
  const base = loadStore().state.fingerprints[current.filePath]
  if (localValue === remoteValue) {
    checkpointRemoteWrite(eventDir, current.filePath, latest.id, localValue, uid, latest.etag || '')
    markConflictResolved(current.filePath, localValue, remoteValue)
    return { imported: 0, pushed: 0 }
  }
  if (base) {
    const localChanged = localValue !== base
    const remoteChanged = remoteValue !== base
    if (!localChanged && remoteChanged) {
      const written = writeEventAtomic(current.filePath, input, remoteUid(latest))
      checkpointMapping(current.filePath, latest.id, fingerprint(written), remoteUid(latest), latest.etag || '')
      markConflictResolved(current.filePath, fingerprint(written), remoteValue)
      return { imported: 1, pushed: 0 }
    }
    if (localChanged && !remoteChanged && attempts < 3) {
      return updateRemote(api, config, eventDir, current, latest.id, uid, index, conflicts, latest, attempts + 1)
    }
  }
  recordConflict(eventDir, current, latest, input, localValue, remoteValue)
  conflicts.add(latest.id)
  return { imported: 0, pushed: 0 }
}

async function updateRemote(
  api: calendar_v3.Calendar,
  config: AppConfig,
  eventDir: string,
  event: CalendarEvent,
  eventId: string,
  uid: string,
  index: RemoteIndex,
  conflicts: Set<string>,
  expectedRemote?: calendar_v3.Schema$Event,
  attempts = 0
): Promise<SyncDelta> {
  if (!expectedRemote?.etag) {
    const latest = await fetchRemoteById(api, config, eventId)
    return resolveUpdateRace(api, config, eventDir, event, eventId, uid, index, conflicts, latest, attempts)
  }
  const current = parseIcsFile(event.filePath)
  if (!current) return { imported: 0, pushed: 0 }
  const localValue = fingerprint(current)
  try {
    const result = (await api.events.patch({
      calendarId: config.googleCalendarId || 'primary', eventId,
      requestBody: googleBody(current, config.googleTimezone || 'Asia/Seoul', uid)
    }, { headers: { 'If-Match': expectedRemote.etag } })).data
    if (result.id) addRemoteToIndex(index, result)
    checkpointRemoteWrite(eventDir, current.filePath, result.id || eventId, localValue, uid, result.etag || '')
    return { imported: 0, pushed: 1 }
  } catch (error) {
    const code = errorCode(error)
    if (code === 412) {
      const latest = await fetchRemoteById(api, config, eventId)
      return resolveUpdateRace(api, config, eventDir, current, eventId, uid, index, conflicts, latest, attempts)
    }
    if (![404, 410].includes(code)) throw error
    const adopted = await findRemoteByUid(api, config, uid)
    if (adopted?.id) {
      linkMapping(current.filePath, adopted.id, uid)
      return resolveUpdateRace(api, config, eventDir, current, adopted.id, uid, index, conflicts, adopted, attempts)
    }
    return resolveUpdateRace(api, config, eventDir, current, eventId, uid, index, conflicts, undefined, attempts)
  }
}

async function pushLocal(
  api: calendar_v3.Calendar,
  config: AppConfig,
  eventDir: string,
  index: RemoteIndex,
  conflicts: Set<string>
): Promise<SyncDelta> {
  let imported = 0
  let pushed = 0
  for (const seed of loadEvents(eventDir)) {
    const event = parseIcsFile(seed.filePath)
    if (!event) continue
    let store = loadStore()
    const artifacts = conflictArtifactPaths(store)
    if (artifacts.has(event.filePath)) {
      const unresolved = Object.values(store.state.conflicts).find((item) => item.artifactPath === event.filePath && !item.resolved)
      if (unresolved) conflicts.add(unresolved.eventId)
      continue
    }
    const conflict = store.state.conflicts[event.filePath]
    if (conflict && !conflict.resolved) {
      conflicts.add(conflict.eventId)
      continue
    }
    const uid = ensureLocalUid(event)
    store = loadStore()
    let eventId = store.map[event.filePath]
    let remote = eventId ? index.byId.get(eventId) : index.byUid.get(uid)
    if (!remote && !eventId) remote = await findRemoteByUid(api, config, uid)
    const checkedMappedRemote = Boolean(eventId && !remote)
    if (checkedMappedRemote) remote = await fetchRemoteById(api, config, eventId)
    const current = parseIcsFile(event.filePath)
    if (!current) continue
    const localValue = fingerprint(current)

    if (eventId && checkedMappedRemote && !remote) {
      imported += handleRemoteDeletion(eventDir, current.filePath, { id: eventId, status: 'cancelled' }, conflicts)
      continue
    }

    if (remote?.id) {
      addRemoteToIndex(index, remote)
      eventId = remote.id
      if (!store.map[current.filePath]) {
        updateStore((latest) => {
          latest.map[current.filePath] = String(remote!.id)
          latest.state.uids[current.filePath] = uid
        })
      }
      if (remote.status === 'cancelled') {
        imported += handleRemoteDeletion(eventDir, current.filePath, remote, conflicts)
        continue
      }
      const input = googleItemToInput(remote, config.googleTimezone || 'Asia/Seoul')
      if (!input) continue
      store = loadStore()
      const base = store.state.fingerprints[current.filePath]
      const remoteValue = fingerprint(calendarEventFromInput(input))
      if (localValue === remoteValue) {
        if (remoteMarker(remote) !== uid) {
          const delta = await updateRemote(api, config, eventDir, current, eventId, uid, index, conflicts, remote)
          imported += delta.imported
          pushed += delta.pushed
          continue
        }
        checkpointMapping(current.filePath, eventId, localValue, uid, remote.etag || '')
        markConflictResolved(current.filePath, localValue, remoteValue)
        continue
      }
      if (!base) {
        recordConflict(eventDir, current, remote, input, localValue, remoteValue)
        conflicts.add(eventId)
        continue
      }
      const localChanged = localValue !== base
      const remoteChanged = remoteValue !== base
      if (localChanged && remoteChanged) {
        recordConflict(eventDir, current, remote, input, localValue, remoteValue)
        conflicts.add(eventId)
        continue
      }
      if (!localChanged && remoteChanged) {
        const written = writeEventAtomic(current.filePath, input, remoteUid(remote))
        checkpointMapping(current.filePath, eventId, fingerprint(written), remoteUid(remote), remote.etag || '')
        continue
      }
      if (localChanged) {
        const delta = await updateRemote(api, config, eventDir, current, eventId, uid, index, conflicts, remote)
        imported += delta.imported
        pushed += delta.pushed
      }
      continue
    }

    if (eventId) {
      const base = loadStore().state.fingerprints[current.filePath]
      if (base === localValue) continue
      const delta = await updateRemote(api, config, eventDir, current, eventId, uid, index, conflicts)
      imported += delta.imported
      pushed += delta.pushed
    } else {
      const delta = await insertOrAdopt(api, config, eventDir, current, uid, index, conflicts)
      imported += delta.imported
      pushed += delta.pushed
    }
  }
  return { imported, pushed }
}

export async function syncGoogle(config: AppConfig, eventDir: string): Promise<GoogleSyncResult> {
  if (!config.googleCalendarEnabled) throw new Error('Google Calendar 동기화를 먼저 활성화해 주세요.')
  mkdirSync(eventDir, { recursive: true })
  const api = await calendar(config)
  // Persist a combined v2 store before the first remote side effect. This also migrates legacy map/state files.
  prepareSyncStore(config)
  // Persist missing/unsafe/duplicate local UIDs before remote discovery so a
  // target switch cannot import or insert against an obsolete sidecar identity.
  for (const event of loadEvents(eventDir)) ensureLocalUid(event)
  const conflicts = new Set<string>()
  const deleted = await flushTombstones(api, config, conflicts) + await flushUidTombstones(api, config, conflicts)
  const remoteItems = await listRemoteEvents(api, config)
  const index: RemoteIndex = { byId: new Map(), byUid: new Map() }
  for (const item of remoteItems) addRemoteToIndex(index, item)
  const remoteImported = await importAndReconcileRemote(config, eventDir, remoteItems, index, conflicts)
  const localDelta = await pushLocal(api, config, eventDir, index, conflicts)
  return { imported: remoteImported + localDelta.imported, pushed: localDelta.pushed, deleted, conflicts: conflicts.size }
}

export function moveSyncMapping(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  updateEveryTargetStore((store) => {
    if (store.map[oldPath]) { store.map[newPath] = store.map[oldPath]; delete store.map[oldPath] }
    if (store.state.fingerprints[oldPath]) { store.state.fingerprints[newPath] = store.state.fingerprints[oldPath]; delete store.state.fingerprints[oldPath] }
    if (store.state.etags[oldPath]) { store.state.etags[newPath] = store.state.etags[oldPath]; delete store.state.etags[oldPath] }
    if (store.state.uids[oldPath]) { store.state.uids[newPath] = store.state.uids[oldPath]; delete store.state.uids[oldPath] }
    if (store.state.deletedUids[oldPath]) { store.state.deletedUids[newPath] = store.state.deletedUids[oldPath]; delete store.state.deletedUids[oldPath] }
    if (store.state.deleteGuards[oldPath]) { store.state.deleteGuards[newPath] = store.state.deleteGuards[oldPath]; delete store.state.deleteGuards[oldPath] }
    for (const pending of Object.values(store.state.pendingInserts)) {
      if (pending.path === oldPath) pending.path = newPath
    }
    if (store.state.conflicts[oldPath]) {
      const conflict = store.state.conflicts[oldPath]
      delete store.state.conflicts[oldPath]
      if (conflict.artifactPath === oldPath) conflict.artifactPath = newPath
      store.state.conflicts[newPath] = conflict
    }
    for (const conflict of Object.values(store.state.conflicts)) {
      if (conflict.artifactPath === oldPath) conflict.artifactPath = newPath
    }
  })
}

export function moveSyncMappingToTrash(oldPath: string, trashPath: string): void {
  const rawDiskUid = syncFileUid(trashPath)
  const diskUid = rawDiskUid ? safeSyncUid(rawDiskUid) : ''
  updateEveryTargetStore((store) => {
    const storedUid = store.state.uids[oldPath]
    const uid = diskUid || (storedUid ? safeSyncUid(storedUid) : '')
    const importedId = uid.endsWith('@google.calendar') ? uid.slice(0, -'@google.calendar'.length) : ''
    const id = store.map[oldPath] || importedId
    if (id) {
      store.state.tombstones[trashPath] = id
      delete store.state.deletedUids[trashPath]
    } else if (uid) {
      store.state.deletedUids[trashPath] = uid
    }
    if (store.state.fingerprints[oldPath]) store.state.fingerprints[trashPath] = store.state.fingerprints[oldPath]
    if (store.state.etags[oldPath]) store.state.etags[trashPath] = store.state.etags[oldPath]
    if (uid) store.state.uids[trashPath] = uid
    if (store.state.deleteGuards[oldPath]) {
      store.state.deleteGuards[trashPath] = store.state.deleteGuards[oldPath]
      delete store.state.deleteGuards[oldPath]
    }
    for (const pending of Object.values(store.state.pendingInserts)) {
      if (pending.path === oldPath) pending.path = trashPath
    }
    delete store.map[oldPath]
    delete store.state.fingerprints[oldPath]
    delete store.state.etags[oldPath]
    delete store.state.uids[oldPath]
    if (store.state.conflicts[oldPath]) {
      const conflict = store.state.conflicts[oldPath]
      delete store.state.conflicts[oldPath]
      if (conflict.artifactPath === oldPath) conflict.artifactPath = trashPath
      store.state.conflicts[trashPath] = conflict
    }
    for (const [path, conflict] of Object.entries(store.state.conflicts)) {
      if (conflict.artifactPath === oldPath && path !== trashPath) delete store.state.conflicts[path]
    }
  })
}

export function restoreSyncMapping(trashPath: string, restoredPath: string): void {
  const rawDiskUid = syncFileUid(restoredPath)
  const diskUid = rawDiskUid ? safeSyncUid(rawDiskUid) : ''
  updateEveryTargetStore((store) => {
    const deletedUid = store.state.deletedUids[trashPath]
    const uid = diskUid || store.state.uids[trashPath] || deletedUid
    // Restoration is a new local intent. Never revive the old remote ID/base/etag:
    // the next sync must re-adopt a still-existing UID or create a fresh event.
    delete store.map[trashPath]
    delete store.map[restoredPath]
    delete store.state.fingerprints[restoredPath]
    delete store.state.etags[restoredPath]
    if (uid) store.state.uids[restoredPath] = uid
    for (const pending of Object.values(store.state.pendingInserts)) {
      if (pending.path === trashPath) pending.path = restoredPath
    }
    delete store.state.tombstones[trashPath]
    delete store.state.deletedUids[trashPath]
    delete store.state.deleteGuards[trashPath]
    delete store.state.deleteGuards[restoredPath]
    delete store.state.fingerprints[trashPath]
    delete store.state.etags[trashPath]
    delete store.state.uids[trashPath]
    if (store.state.conflicts[trashPath]) {
      const conflict = store.state.conflicts[trashPath]
      delete store.state.conflicts[trashPath]
      if (conflict.artifactPath === trashPath) conflict.artifactPath = restoredPath
      store.state.conflicts[restoredPath] = conflict
    }
  })
}
