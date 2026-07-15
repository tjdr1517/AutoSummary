import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import type { CalendarEvent, EventInput, TrashedEvent } from '../../shared/types'
import { dataPath } from './config'

interface TrashRecord {
  trashedName: string
  originalPath: string
  deletedAt: string
}

const completionPath = (): string => dataPath('event_completion.json')

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

export function eventKey(path: string): string {
  return resolve(path).toLocaleLowerCase('en-US')
}

function completedKeys(): Set<string> {
  return new Set(readJson<string[]>(completionPath(), []))
}

function saveCompleted(keys: Set<string>): void {
  writeJsonAtomic(completionPath(), [...keys].sort())
}

export function setEventCompleted(path: string, completed: boolean): void {
  const keys = completedKeys()
  if (completed) keys.add(eventKey(path)); else keys.delete(eventKey(path))
  saveCompleted(keys)
}

function moveCompletion(oldPath: string, newPath: string): void {
  const keys = completedKeys()
  if (!keys.delete(eventKey(oldPath))) return
  keys.add(eventKey(newPath))
  saveCompleted(keys)
}

function clearCompletion(path: string): void {
  const keys = completedKeys()
  if (keys.delete(eventKey(path))) saveCompleted(keys)
}

function escapeIcs(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n')
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/gi, '\n').replaceAll('\\,', ',').replaceAll('\\;', ';').replaceAll('\\\\', '\\')
}

function safeFilename(value: string): string {
  const clean = value.replace(/[<>:"/\\|?*]/g, '_').trim().replace(/\s+/g, ' ')
  return clean.slice(0, 80) || 'event'
}

function availableEventPath(eventDir: string, date: string, title: string, excludePath = ''): string {
  const first = join(eventDir, `${date}-${safeFilename(title)}.ics`)
  if (first === excludePath || !existsSync(first)) return first
  for (let index = 2; ; index += 1) {
    const candidate = join(eventDir, `${date}-${safeFilename(title)} (${index}).ics`)
    if (candidate === excludePath || !existsSync(candidate)) return candidate
  }
}

function compactDate(value: string): string {
  return value.replaceAll('-', '')
}

export function buildEventText(input: EventInput, uid = `${randomUUID()}@coolcalendar`): string {
  const title = input.title.trim() || '새 일정'
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CoolCalendar//Electron App//KO',
    'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`,
    `SUMMARY:${escapeIcs(title)}`, `DESCRIPTION:${escapeIcs(input.description || '')}`
  ]
  if (input.allDay || !input.timeText) {
    const defaultEnd = addDays(input.date, 1)
    const end = input.endDate && input.endDate > input.date ? input.endDate : defaultEnd
    lines.push(`DTSTART;VALUE=DATE:${compactDate(input.date)}`)
    lines.push(`DTEND;VALUE=DATE:${compactDate(end)}`)
    lines.push('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE')
  } else {
    const start = `${compactDate(input.date)}T${input.timeText.replace(':', '')}00`
    let endDate = input.endDate || input.date
    let endTime = input.endTimeText || addMinutes(input.date, input.timeText, 30).time
    if (`${endDate}T${endTime}` <= `${input.date}T${input.timeText}`) {
      const fallback = addMinutes(input.date, input.timeText, 30)
      endDate = fallback.date
      endTime = fallback.time
    }
    lines.push(`DTSTART:${start}`)
    lines.push(`DTEND:${compactDate(endDate)}T${endTime.replace(':', '')}00`)
  }
  lines.push('END:VEVENT', 'END:VCALENDAR', '')
  return lines.join('\r\n')
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + amount)
  return value.toLocaleDateString('sv-SE')
}

function addMinutes(date: string, time: string, amount: number): { date: string; time: string } {
  const value = new Date(`${date}T${time}:00`)
  value.setMinutes(value.getMinutes() + amount)
  return { date: value.toLocaleDateString('sv-SE'), time: value.toTimeString().slice(0, 5) }
}

function unfoldIcs(text: string): string[] {
  const result: string[] = []
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (/^[ \t]/.test(line) && result.length) result[result.length - 1] += line.slice(1)
    else result.push(line)
  }
  return result
}

function parseDateTime(value: string): { date: string; time: string } | null {
  const clean = value.replace(/Z$/, '')
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  if (!match) return null
  return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}` }
}

export function parseIcsFile(path: string): CalendarEvent | null {
  let text = ''
  try { text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '') } catch { return null }
  let title = ''
  let description = ''
  let date = ''
  let endDate = ''
  let timeText = ''
  let endTimeText = ''
  let allDay = false
  for (const raw of unfoldIcs(text)) {
    const separator = raw.indexOf(':')
    if (separator < 0) continue
    const key = raw.slice(0, separator).toUpperCase()
    const value = raw.slice(separator + 1)
    if (key === 'SUMMARY') title = unescapeIcs(value)
    else if (key === 'DESCRIPTION') description = unescapeIcs(value)
    else if (key.startsWith('DTSTART;VALUE=DATE')) {
      date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
      allDay = true
      timeText = '종일'
    } else if (key.startsWith('DTEND;VALUE=DATE')) {
      endDate = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    } else if (key.startsWith('DTSTART')) {
      const parsed = parseDateTime(value)
      if (parsed) { date = parsed.date; timeText = parsed.time }
    } else if (key.startsWith('DTEND')) {
      const parsed = parseDateTime(value)
      if (parsed) { endDate = parsed.date; endTimeText = parsed.time }
    } else if (key === 'X-MICROSOFT-CDO-ALLDAYEVENT' && value.toUpperCase() === 'TRUE') {
      allDay = true
      timeText = '종일'
    }
  }
  if (!date) return null
  return {
    filePath: path,
    date,
    title: title || parse(path).name,
    description,
    timeText,
    allDay,
    endDate,
    endTimeText,
    completed: completedKeys().has(eventKey(path))
  }
}

export function loadEvents(eventDir: string): CalendarEvent[] {
  mkdirSync(eventDir, { recursive: true })
  return readdirSync(eventDir)
    .filter((name) => name.toLowerCase().endsWith('.ics'))
    .sort()
    .map((name) => parseIcsFile(join(eventDir, name)))
    .filter((event): event is CalendarEvent => event !== null)
    .sort((a, b) => `${a.date}-${a.allDay ? '0' : '1'}-${a.timeText}-${a.title}`.localeCompare(`${b.date}-${b.allDay ? '0' : '1'}-${b.timeText}-${b.title}`, 'ko'))
}

export function saveEvent(eventDir: string, input: EventInput): CalendarEvent {
  mkdirSync(eventDir, { recursive: true })
  const current = input.filePath || ''
  const destination = availableEventPath(eventDir, input.date, input.title.trim() || '새 일정', current)
  writeFileSync(destination, buildEventText(input), 'utf8')
  if (current && current !== destination && existsSync(current)) {
    rmSync(current)
    moveCompletion(current, destination)
  }
  const event = parseIcsFile(destination)
  if (!event) throw new Error('저장한 일정을 다시 읽을 수 없습니다.')
  return event
}

function trashDir(eventDir: string): string { return join(eventDir, '.coolcalendar-trash') }
function trashIndex(eventDir: string): string { return join(trashDir(eventDir), 'index.json') }

function loadTrashRecords(eventDir: string): TrashRecord[] {
  const raw = readJson<Array<Record<string, string>>>(trashIndex(eventDir), [])
  return raw.map((item) => ({
    trashedName: item.trashedName || item.trashed_name || '',
    originalPath: item.originalPath || item.original_path || '',
    deletedAt: item.deletedAt || item.deleted_at || ''
  })).filter((item) => item.trashedName && item.originalPath)
}

function saveTrashRecords(eventDir: string, records: TrashRecord[]): void {
  writeJsonAtomic(trashIndex(eventDir), records.map((record) => ({
    trashed_name: record.trashedName,
    original_path: record.originalPath,
    deleted_at: record.deletedAt
  })))
}

export function moveEventToTrash(eventDir: string, filePath: string): string | null {
  if (!existsSync(filePath)) return null
  mkdirSync(trashDir(eventDir), { recursive: true })
  const destination = join(trashDir(eventDir), `${randomUUID().replaceAll('-', '')}-${basename(filePath)}`)
  renameSync(filePath, destination)
  moveCompletion(filePath, destination)
  const records = loadTrashRecords(eventDir)
  records.push({ trashedName: basename(destination), originalPath: filePath, deletedAt: new Date().toISOString() })
  saveTrashRecords(eventDir, records)
  return destination
}

export function loadTrash(eventDir: string): TrashedEvent[] {
  return loadTrashRecords(eventDir).map((record) => {
    const path = join(trashDir(eventDir), record.trashedName)
    const event = parseIcsFile(path)
    return event ? { event, originalPath: record.originalPath, deletedAt: record.deletedAt } : null
  }).filter((entry): entry is TrashedEvent => entry !== null)
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

function availableRestorePath(original: string): string {
  if (!existsSync(original)) return original
  const details = parse(original)
  for (let index = 2; ; index += 1) {
    const candidate = join(details.dir, `${details.name} (${index})${details.ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

export function restoreEvent(eventDir: string, trashedPath: string): CalendarEvent | null {
  const records = loadTrashRecords(eventDir)
  const record = records.find((item) => join(trashDir(eventDir), item.trashedName) === trashedPath)
  if (!record || !existsSync(trashedPath)) return null
  let original = record.originalPath
  if (!resolve(original).toLowerCase().startsWith(resolve(eventDir).toLowerCase())) original = join(eventDir, basename(original))
  const destination = availableRestorePath(original)
  mkdirSync(dirname(destination), { recursive: true })
  renameSync(trashedPath, destination)
  moveCompletion(trashedPath, destination)
  saveTrashRecords(eventDir, records.filter((item) => item !== record))
  return parseIcsFile(destination)
}

export function deleteForever(eventDir: string, trashedPath: string): boolean {
  const records = loadTrashRecords(eventDir)
  const record = records.find((item) => join(trashDir(eventDir), item.trashedName) === trashedPath)
  if (!record) return false
  if (existsSync(trashedPath) && statSync(trashedPath).isFile()) rmSync(trashedPath)
  clearCompletion(trashedPath)
  saveTrashRecords(eventDir, records.filter((item) => item !== record))
  return true
}

export function eventUid(path: string): string {
  const event = parseIcsFile(path)
  if (!event) return ''
  const text = readFileSync(path, 'utf8')
  return unfoldIcs(text).find((line) => line.startsWith('UID:'))?.slice(4).trim() || ''
}

export function fileExtension(path: string): string { return extname(path).toLowerCase() }
