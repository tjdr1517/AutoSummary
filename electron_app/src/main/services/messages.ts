import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Message } from '../../shared/types'

interface MessageRow {
  MessageKey: number
  IsUnRead: number
  Peer: string | null
  Title: string | null
  MessageDate: string | null
  MessageText: string | null
  FilePath: string | null
  LinkURL: string | null
}

function readTable(db: Database.Database, table: 'tbl_recv' | 'tbl_send', limit: number): Message[] {
  const incoming = table === 'tbl_recv'
  const personColumn = incoming ? 'Sender' : 'Receiver'
  const dateColumn = incoming ? 'ReceiveDate' : 'SendDate'
  const rows = db.prepare(`
    SELECT MessageKey,
      ${incoming ? 'COALESCE(IsUnRead, 0)' : '0'} AS IsUnRead,
      COALESCE(${personColumn}, '') AS Peer,
      COALESCE(Title, '') AS Title,
      COALESCE(${dateColumn}, '') AS MessageDate,
      COALESCE(MessageText, '') AS MessageText,
      COALESCE(FilePath, '') AS FilePath,
      COALESCE(LinkURL, '') AS LinkURL
    FROM ${table}
    ORDER BY MessageKey DESC
    LIMIT ?
  `).all(limit) as MessageRow[]

  return rows.reverse().map((row) => ({
    key: Number(row.MessageKey),
    direction: incoming ? 'recv' : 'send',
    unread: incoming && Number(row.IsUnRead) !== 0,
    peer: String(row.Peer ?? '').trim(),
    title: String(row.Title ?? '').trim(),
    whenText: String(row.MessageDate ?? '').trim(),
    body: String(row.MessageText ?? ''),
    filePath: String(row.FilePath ?? '').trim(),
    linkUrl: String(row.LinkURL ?? '').trim()
  }))
}

export function readRecentMessages(dbPath: string, limit = 250, includeSent = false): Message[] {
  if (!dbPath || !existsSync(dbPath)) throw new Error('CoolMessenger UDB 파일을 찾을 수 없습니다.')
  const tempDir = mkdtempSync(join(tmpdir(), 'coolcalendar-udb-'))
  const snapshot = join(tempDir, basename(dbPath))
  try {
    mkdirSync(tempDir, { recursive: true })
    copyFileSync(dbPath, snapshot)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, snapshot + suffix)
    }
    const db = new Database(snapshot, { readonly: true, fileMustExist: true })
    try {
      const messages = readTable(db, 'tbl_recv', limit)
      if (includeSent) messages.push(...readTable(db, 'tbl_send', limit))
      return messages.sort((a, b) => a.key - b.key)
    } finally {
      db.close()
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
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
  if (message.filePath) parts.push('', `첨부: ${message.filePath}`)
  if (message.linkUrl) parts.push('', `링크: ${message.linkUrl}`)
  return parts.join('\n').trim()
}
