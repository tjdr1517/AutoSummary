import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shell } from 'electron'
import { google, type calendar_v3 } from 'googleapis'
import type { AppConfig, CalendarEvent, EventInput, GoogleSyncResult } from '../../shared/types'
import { dataPath } from './config'
import { buildEventText, eventUid, loadEvents, moveEventToTrash, parseIcsFile } from './events'
import { mkdirSync, rmSync } from 'node:fs'

interface SyncState {
  fingerprints: Record<string, string>
  tokens: Record<string, string>
  tombstones: Record<string, string>
}

const syncMapPath = (): string => dataPath('google_sync.json')
const syncStatePath = (): string => dataPath('google_sync_state.json')

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

function loadMap(): Record<string, string> { return readJson(syncMapPath(), {}) }
function saveMap(value: Record<string, string>): void { writeJson(syncMapPath(), value) }
function loadState(): SyncState {
  const raw = readJson<Partial<SyncState>>(syncStatePath(), {})
  return { fingerprints: raw.fingerprints ?? {}, tokens: raw.tokens ?? {}, tombstones: raw.tombstones ?? {} }
}
function saveState(value: SyncState): void { writeJson(syncStatePath(), { version: 1, ...value }) }

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

function createOauthClient(config: AppConfig, redirectUri = 'http://127.0.0.1'): InstanceType<typeof google.auth.OAuth2> {
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
        const client = createOauthClient(config, redirectUri)
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
        const client = createOauthClient(config, redirectUri)
        const url = client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: ['https://www.googleapis.com/auth/calendar.events']
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
  const auth = createOauthClient(config)
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
    time_text: event.allDay ? '' : event.timeText,
    title: event.title
  })).digest('hex')
}

function googleBody(event: CalendarEvent, timezone: string): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {
    summary: event.title || '새 일정',
    description: event.description || '',
    extendedProperties: { private: { coolcalendar_file: event.filePath } }
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

async function flushTombstones(api: calendar_v3.Calendar, config: AppConfig, state: SyncState): Promise<number> {
  let deleted = 0
  for (const [path, id] of Object.entries(state.tombstones)) {
    try { await api.events.delete({ calendarId: config.googleCalendarId || 'primary', eventId: id }) }
    catch (error) {
      const status = (error as { code?: number }).code
      if (![404, 410].includes(Number(status))) throw error
    }
    delete state.tombstones[path]
    delete state.fingerprints[path]
    deleted += 1
  }
  saveState(state)
  return deleted
}

async function pushLocal(api: calendar_v3.Calendar, config: AppConfig, events: CalendarEvent[], map: Record<string, string>, state: SyncState): Promise<number> {
  let pushed = 0
  for (const event of events) {
    const localFingerprint = fingerprint(event)
    if (map[event.filePath] && state.fingerprints[event.filePath] === localFingerprint) continue
    const body = googleBody(event, config.googleTimezone || 'Asia/Seoul')
    let result: calendar_v3.Schema$Event
    const eventId = map[event.filePath]
    try {
      result = eventId
        ? (await api.events.update({ calendarId: config.googleCalendarId || 'primary', eventId, requestBody: body })).data
        : (await api.events.insert({ calendarId: config.googleCalendarId || 'primary', requestBody: body })).data
    } catch (error) {
      if (eventId && Number((error as { code?: number }).code) === 404) {
        result = (await api.events.insert({ calendarId: config.googleCalendarId || 'primary', requestBody: body })).data
      } else throw error
    }
    if (result.id) map[event.filePath] = result.id
    state.fingerprints[event.filePath] = localFingerprint
    pushed += 1
  }
  saveMap(map)
  saveState(state)
  return pushed
}

function googleItemToInput(item: calendar_v3.Schema$Event, timezone: string): EventInput | null {
  const startDate = item.start?.date
  if (startDate) return {
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
  const formatterTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
  return {
    date: formatterDate.format(start),
    title: item.summary || 'Google 일정',
    description: item.description || '',
    allDay: false,
    timeText: formatterTime.format(start),
    endDate: end ? formatterDate.format(end) : undefined,
    endTimeText: end ? formatterTime.format(end) : undefined
  }
}

async function importRemote(api: calendar_v3.Calendar, config: AppConfig, eventDir: string, map: Record<string, string>, state: SyncState): Promise<number> {
  const today = new Date().toLocaleDateString('sv-SE')
  const min = new Date(`${addDays(today, -90)}T00:00:00`).toISOString()
  const max = new Date(`${addDays(today, 550)}T00:00:00`).toISOString()
  const response = await api.events.list({
    calendarId: config.googleCalendarId || 'primary', singleEvents: true, showDeleted: true,
    timeMin: min, timeMax: max, orderBy: 'startTime', maxResults: 2500
  })
  let imported = 0
  for (const item of response.data.items ?? []) {
    if (!item.id) continue
    const existingPath = Object.keys(map).find((path) => map[path] === item.id)
    if (item.status === 'cancelled') {
      if (existingPath && existsSync(existingPath)) rmSync(existingPath)
      if (existingPath) { delete map[existingPath]; delete state.fingerprints[existingPath] }
      continue
    }
    if (Object.values(state.tombstones).includes(item.id)) continue
    const input = googleItemToInput(item, config.googleTimezone || 'Asia/Seoul')
    if (!input) continue
    const suggested = join(eventDir, `${input.date}-${input.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80) || 'Google 일정'}.ics`)
    let target = existingPath || suggested
    if (!existingPath && existsSync(target)) {
      let index = 2
      const base = target.slice(0, -4)
      while (existsSync(`${base} (${index}).ics`)) index += 1
      target = `${base} (${index}).ics`
    }
    writeFileSync(target, buildEventText({ ...input, filePath: target }, `${item.id}@google.calendar`), 'utf8')
    if (existingPath && existingPath !== target && existsSync(existingPath)) rmSync(existingPath)
    if (existingPath && existingPath !== target) delete map[existingPath]
    map[target] = item.id
    const parsed = parseIcsFile(target)
    if (parsed) state.fingerprints[target] = fingerprint(parsed)
    imported += 1
  }
  saveMap(map)
  saveState(state)
  return imported
}

export async function syncGoogle(config: AppConfig, eventDir: string): Promise<GoogleSyncResult> {
  if (!config.googleCalendarEnabled) throw new Error('Google Calendar 동기화를 먼저 활성화해 주세요.')
  mkdirSync(eventDir, { recursive: true })
  const api = await calendar(config)
  const map = loadMap()
  const state = loadState()
  const deleted = await flushTombstones(api, config, state)
  const imported = await importRemote(api, config, eventDir, map, state)
  const pushed = await pushLocal(api, config, loadEvents(eventDir), map, state)
  return { imported, pushed, deleted }
}

export function moveSyncMapping(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return
  const map = loadMap()
  const state = loadState()
  if (map[oldPath]) { map[newPath] = map[oldPath]; delete map[oldPath] }
  if (state.fingerprints[oldPath]) { state.fingerprints[newPath] = state.fingerprints[oldPath]; delete state.fingerprints[oldPath] }
  saveMap(map); saveState(state)
}

export function moveSyncMappingToTrash(oldPath: string, trashPath: string): void {
  const map = loadMap()
  const state = loadState()
  const id = map[oldPath] || eventUid(trashPath).replace(/@google\.calendar$/, '')
  if (id) state.tombstones[trashPath] = id
  if (state.fingerprints[oldPath]) state.fingerprints[trashPath] = state.fingerprints[oldPath]
  delete map[oldPath]; delete state.fingerprints[oldPath]
  saveMap(map); saveState(state)
}

export function restoreSyncMapping(trashPath: string, restoredPath: string): void {
  const map = loadMap()
  const state = loadState()
  const id = state.tombstones[trashPath]
  if (id) map[restoredPath] = id
  if (state.fingerprints[trashPath]) state.fingerprints[restoredPath] = state.fingerprints[trashPath]
  delete state.tombstones[trashPath]; delete state.fingerprints[trashPath]
  saveMap(map); saveState(state)
}
