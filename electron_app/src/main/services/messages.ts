import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { Message, MessageAttachment, MessageContentBlock, MessageDirection, MessageReceipt } from '../../shared/types'

interface MessageRow {
  MessageKey: number
  MemoID: number
  IsUnRead: number
  Peer: string | null
  Title: string | null
  MessageDate: string | null
  MessageText: string | null
  FilePath: string | null
  CoolFile2SessionID: string | null
  LinkURL: string | null
  ReceiverKey: string | null
  AnswerBack: string | null
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'])
const RECEIVED_FILES = join(homedir(), 'Documents', 'CoolMessenger Files', 'Received Files')
const MAX_RICH_BODY_BYTES = 8 * 1024 * 1024
const MAX_INLINE_IMAGE_CHARACTERS = 12 * 1024 * 1024
interface ReceivedFileIndex {
  expiresAt: number
  files: Map<string, string[]>
}

interface DatabaseSnapshot {
  sourcePath: string
  sourceSignature: string
  directory: string
  path: string
}

interface RecentMessageCache {
  sourceSignature: string
  attachmentSignature: string
  messages: Message[]
}

const receivedFileIndexes = new Map<string, ReceivedFileIndex>()
const recentMessageCaches = new Map<string, RecentMessageCache>()
let databaseSnapshot: DatabaseSnapshot | undefined

function fileSignature(path: string): string {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return '-'
  }
}

function databaseSourceSignature(dbPath: string): string {
  return ['', '-wal'].map((suffix) => `${suffix}:${fileSignature(dbPath + suffix)}`).join('|')
}

function cleanupDatabaseSnapshot(snapshot: DatabaseSnapshot | undefined): void {
  if (!snapshot) return
  try { rmSync(snapshot.directory, { recursive: true, force: true }) } catch { /* Best-effort temporary cleanup. */ }
  if (snapshot === databaseSnapshot) databaseSnapshot = undefined
}

function ensureDatabaseSnapshot(dbPath: string): DatabaseSnapshot {
  const sourcePath = resolve(dbPath)
  const sourceSignature = databaseSourceSignature(sourcePath)
  if (databaseSnapshot?.sourcePath === sourcePath && databaseSnapshot.sourceSignature === sourceSignature && existsSync(databaseSnapshot.path)) {
    return databaseSnapshot
  }

  const directory = mkdtempSync(join(tmpdir(), 'coolcalendar-udb-'))
  const path = join(directory, basename(sourcePath))
  try {
    copyFileSync(sourcePath, path)
    for (const suffix of ['-wal']) {
      if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, path + suffix)
    }
  } catch (error) {
    cleanupDatabaseSnapshot({ sourcePath, sourceSignature, directory, path })
    throw error
  }

  const previous = databaseSnapshot
  databaseSnapshot = { sourcePath, sourceSignature, directory, path }
  recentMessageCaches.clear()
  cleanupDatabaseSnapshot(previous)
  return databaseSnapshot
}

function readDatabase<T>(dbPath: string, reader: (db: Database.Database) => T): T {
  const sourcePath = resolve(dbPath)
  let directError: unknown
  try {
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true, timeout: 750 })
    try {
      return reader(db)
    } finally {
      db.close()
    }
  } catch (error) {
    directError = error
  }

  try {
    const snapshot = ensureDatabaseSnapshot(sourcePath)
    const db = new Database(snapshot.path, { readonly: true, fileMustExist: true })
    try {
      return reader(db)
    } finally {
      db.close()
    }
  } catch {
    throw directError
  }
}

function attachmentSearchSignature(searchDirectories: string[]): string {
  const minute = Math.floor(Date.now() / 60_000)
  const roots = [...new Set([...searchDirectories, RECEIVED_FILES].filter(Boolean).map((directory) => resolve(directory)))]
  return `${minute}|${roots.map((root) => `${root}:${fileSignature(root)}`).join('|')}`
}

process.once('exit', () => cleanupDatabaseSnapshot(databaseSnapshot))

function refreshReceivedFileIndex(root: string): Map<string, string[]> {
  const cached = receivedFileIndexes.get(root)
  if (cached && Date.now() < cached.expiresAt) return cached.files
  const next = new Map<string, string[]>()
  const pending = [root]
  let visited = 0
  while (pending.length > 0 && visited < 20_000) {
    const directory = pending.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (entry.isFile()) {
        const key = entry.name.toLocaleLowerCase('ko')
        next.set(key, [...(next.get(key) ?? []), target])
      }
      visited += 1
      if (visited >= 20_000) break
    }
  }
  receivedFileIndexes.set(root, { files: next, expiresAt: Date.now() + 60_000 })
  return next
}

function matchingFile(path: string, expectedSize: number): boolean {
  if (!path || !existsSync(path)) return false
  try { return expectedSize > 0 ? statSync(path).size === expectedSize : statSync(path).isFile() } catch { return false }
}

function localAttachmentPath(sourcePath: string, name: string, size: number, direction: MessageDirection, searchDirectories: string[]): string {
  if (matchingFile(sourcePath, size)) return sourcePath
  if (direction === 'recv') {
    const roots = [...new Set([...searchDirectories, RECEIVED_FILES].filter(Boolean).map((directory) => resolve(directory)))]
    for (const root of roots) {
      const direct = join(root, name)
      if (matchingFile(direct, size)) return direct
    }
    const normalizedName = name.toLocaleLowerCase('ko')
    for (const root of roots) {
      const match = (refreshReceivedFileIndex(root).get(normalizedName) ?? []).find((path) => matchingFile(path, size))
      if (match) return match
    }
  }
  return ''
}

function refreshAttachmentPaths(messages: Message[], searchDirectories: string[]): Message[] {
  let changed = false
  const next = messages.map((message) => {
    let attachmentChanged = false
    const attachments = message.attachments.map((attachment) => {
      const localPath = localAttachmentPath(attachment.sourcePath, attachment.name, attachment.size, message.direction, searchDirectories)
      if (localPath === attachment.localPath) return attachment
      attachmentChanged = true
      return { ...attachment, localPath }
    })
    if (!attachmentChanged) return message
    changed = true
    return { ...message, attachments }
  })
  return changed ? next : messages
}

export function parseMessageAttachments(rawValue: string, direction: MessageDirection, searchDirectories: string[] = []): MessageAttachment[] {
  const raw = String(rawValue || '').trim()
  if (!raw) return []
  if (!raw.startsWith('|')) {
    const name = basename(raw)
    return [{ name, size: 0, sourcePath: raw, localPath: localAttachmentPath(raw, name, 0, direction, searchDirectories), kind: IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? 'image' : 'file' }]
  }
  const parts = raw.split('|')
  const count = Math.max(0, Number(parts[1]) || 0)
  const sizes = String(parts[2] || '').split(';').slice(1).map((value) => Number(value) || 0)
  const attachments: MessageAttachment[] = []
  for (let index = 0; index < count; index += 1) {
    const directory = String(parts[3 + index * 3] || '').trim()
    const name = String(parts[4 + index * 3] || '').trim()
    if (!name) continue
    const sourcePath = directory ? join(directory, name) : name
    attachments.push({
      name,
      size: sizes[index] || 0,
      sourcePath,
      localPath: localAttachmentPath(sourcePath, name, sizes[index] || 0, direction, searchDirectories),
      kind: IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? 'image' : 'file'
    })
  }
  return attachments
}

function encodedKeys(value: string): number[] {
  const parts = String(value || '').split('|').filter(Boolean)
  const count = Math.max(0, Number(parts[0]) || 0)
  return parts.slice(1, count + 1).map(Number).filter((key) => Number.isInteger(key) && key > 0)
}

function answerBackDates(value: string): Map<number, string> {
  const parts = String(value || '').split('|').filter(Boolean)
  const count = Math.max(0, Number(parts[0]) || 0)
  const dates = new Map<number, string>()
  for (let index = 0; index < count; index += 1) {
    const key = Number(parts[1 + index * 2])
    const receivedAt = String(parts[2 + index * 2] || '').trim()
    if (Number.isInteger(key) && key > 0 && receivedAt) dates.set(key, receivedAt)
  }
  return dates
}

function sentMessageReceipts(row: MessageRow, memberNames: Map<number, string>): MessageReceipt[] {
  const keys = encodedKeys(String(row.ReceiverKey || ''))
  const receivedDates = answerBackDates(String(row.AnswerBack || ''))
  const displayNames = String(row.Peer || '').split(';').map((name) => name.trim()).filter(Boolean)
  return keys.map((memberKey, index) => ({
    memberKey,
    recipient: displayNames[index] || memberNames.get(memberKey) || `수신자 ${memberKey}`,
    received: receivedDates.has(memberKey),
    receivedAt: receivedDates.get(memberKey) || ''
  }))
}

function readTable(db: Database.Database, table: 'tbl_recv' | 'tbl_send', limit: number, memberNames: Map<number, string>, attachmentDirectories: string[]): Message[] {
  const incoming = table === 'tbl_recv'
  const personColumn = incoming ? 'Sender' : 'Receiver'
  const dateColumn = incoming ? 'ReceiveDate' : 'SendDate'
  const rows = db.prepare(`
    SELECT MessageKey,
      COALESCE(MemoID, 0) AS MemoID,
      ${incoming ? 'COALESCE(IsUnRead, 0)' : '0'} AS IsUnRead,
      COALESCE(${personColumn}, '') AS Peer,
      COALESCE(Title, '') AS Title,
      COALESCE(${dateColumn}, '') AS MessageDate,
      COALESCE(MessageText, '') AS MessageText,
      COALESCE(FilePath, '') AS FilePath,
      ${incoming ? "COALESCE(CoolFile2SessionID, '')" : "''"} AS CoolFile2SessionID,
      COALESCE(LinkURL, '') AS LinkURL,
      ${incoming ? "''" : "COALESCE(ReceiverKey, '')"} AS ReceiverKey,
      ${incoming ? "''" : "COALESCE(AnswerBack, '')"} AS AnswerBack
    FROM ${table}
    ORDER BY MessageKey DESC
    LIMIT ?
  `).all(limit) as MessageRow[]

  return rows.reverse().map((row) => {
    const direction: MessageDirection = incoming ? 'recv' : 'send'
    const filePath = String(row.FilePath ?? '').trim()
    return {
    key: Number(row.MessageKey),
    memoId: Number(row.MemoID),
    direction,
    unread: incoming && Number(row.IsUnRead) !== 0,
    recalled: false,
    peer: String(row.Peer ?? '').trim(),
    title: String(row.Title ?? '').trim(),
    whenText: String(row.MessageDate ?? '').trim(),
    body: String(row.MessageText ?? ''),
    filePath,
    fileSessionId: String(row.CoolFile2SessionID ?? '').trim(),
    attachments: parseMessageAttachments(filePath, direction, attachmentDirectories),
    linkUrl: String(row.LinkURL ?? '').trim(),
    receipts: incoming ? [] : sentMessageReceipts(row, memberNames)
  }})
}

export function readRecentMessages(dbPath: string, limit = 250, includeSent = false, attachmentDirectories: string[] = []): Message[] {
  if (!dbPath || !existsSync(dbPath)) throw new Error('CoolMessenger UDB 파일을 찾을 수 없습니다.')
  const sourcePath = resolve(dbPath)
  const sourceSignature = databaseSourceSignature(sourcePath)
  const cacheKey = `${sourcePath}|${limit}|${includeSent ? 1 : 0}|${attachmentDirectories.map((directory) => resolve(directory)).sort().join('|')}`
  const attachmentSignature = attachmentSearchSignature(attachmentDirectories)
  const cached = recentMessageCaches.get(cacheKey)
  if (cached?.sourceSignature === sourceSignature) {
    if (cached.attachmentSignature !== attachmentSignature) {
      cached.messages = refreshAttachmentPaths(cached.messages, attachmentDirectories)
      cached.attachmentSignature = attachmentSignature
    }
    return cached.messages
  }

  const messages = readDatabase(sourcePath, (db) => {
    const memberNames = new Map((db.prepare(`
      SELECT K_MemberID, COALESCE(MemberName, '') AS MemberName FROM tbl_member
    `).all() as Array<{ K_MemberID: number; MemberName: string }>).map((row) => [Number(row.K_MemberID), String(row.MemberName || '').trim()]))
    const messages = readTable(db, 'tbl_recv', limit, memberNames, attachmentDirectories)
    if (includeSent) messages.push(...readTable(db, 'tbl_send', limit, memberNames, attachmentDirectories))
    return messages.sort((a, b) => a.key - b.key)
  })
  recentMessageCaches.set(cacheKey, { sourceSignature, attachmentSignature, messages })
  if (recentMessageCaches.size > 8) recentMessageCaches.delete(recentMessageCaches.keys().next().value!)
  return messages
}

function richMessageHtml(value: unknown): string {
  const body = String(value || '')
  try {
    if (Buffer.byteLength(body, 'utf8') > MAX_INLINE_IMAGE_CHARACTERS) return ''
    if (body.startsWith('{COMP}')) return inflateSync(Buffer.from(body.slice(6), 'base64'), { maxOutputLength: MAX_RICH_BODY_BYTES }).toString('utf16le')
    if (body.includes('\0')) return Buffer.from(body, 'binary').toString('utf16le')
    return body
  } catch {
    return ''
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

function htmlText(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(div|p|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(withBreaks)
    .replaceAll('\r', '')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function imageSource(tag: string): string {
  const match = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/is)
  if (!match) return ''
  let source = decodeHtmlEntities(String(match[2] || '').trim())
  const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,\s*([\s\S]+)$/i)
  if (dataMatch) source = `data:${dataMatch[1]};base64,${dataMatch[2].replace(/\s/g, '')}`
  if (!source.startsWith('data:image/') || source.length > MAX_INLINE_IMAGE_CHARACTERS) return ''
  return source
}

function richMessageBlocks(html: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = []
  const imagePattern = /<img\b[^>]*>/gis
  let cursor = 0
  for (const match of html.matchAll(imagePattern)) {
    const index = match.index ?? cursor
    const text = htmlText(html.slice(cursor, index))
    if (text) blocks.push({ type: 'text', content: text })
    const source = imageSource(match[0])
    if (source) blocks.push({ type: 'image', content: source })
    cursor = index + match[0].length
  }
  const remaining = htmlText(html.slice(cursor))
  if (remaining) blocks.push({ type: 'text', content: remaining })
  return blocks
}

export function readMessageRichContent(dbPath: string, messageKey: number): MessageContentBlock[] {
  if (!dbPath || !existsSync(dbPath)) return []
  return readDatabase(dbPath, (db) => {
    const row = db.prepare('SELECT MessageBody FROM tbl_recv WHERE MessageKey = ?').get(messageKey) as { MessageBody?: unknown } | undefined
    return richMessageBlocks(richMessageHtml(row?.MessageBody)).slice(0, 16)
  })
}

export function normalizeText(value: string): string {
  return (value || '')
    .replaceAll('\0', '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n')
}

export function messageBaseDate(message: Message): string {
  const match = message.whenText.match(/(\d{4})\/(\d{2})\/(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  return new Date().toLocaleDateString('sv-SE')
}

export function summarizeMessage(message: Message): string {
  const body = normalizeText(message.body)
  const core = (body || message.title || '(내용 없음)').slice(0, 120)
  const source = `${message.title}\n${body}`
  const tags = [
    ['긴급', '긴급'], ['마감', '마감'], ['까지', '기한'], ['공지', '공지'],
    ['안내', '안내'], ['요청', '요청'], ['회의', '회의'], ['첨부', '첨부']
  ].filter(([keyword]) => source.includes(keyword)).map(([, tag]) => tag)
  return `[${[...new Set(tags)].join(', ') || '일반'}] ${core}${core.length >= 120 ? '…' : ''}`
}

export function buildEventDescription(message: Message): string {
  const parts = [
    `상대: ${message.peer}`,
    `원본 일시: ${message.whenText}`,
    '',
    summarizeMessage(message),
    '',
    normalizeText(message.body)
  ]
  if (message.attachments.length > 0) parts.push('', `첨부: ${message.attachments.map((attachment) => attachment.name).join(', ')}`)
  if (message.linkUrl) parts.push('', `링크: ${message.linkUrl}`)
  return parts.join('\n').trim()
}
