import Database from 'better-sqlite3'
import iconv from 'iconv-lite'
import { KISA_SEED_CBC } from 'kisa-seed'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Socket } from 'node:net'
import { deflateSync } from 'node:zlib'
import { powerMonitor } from 'electron'
import type {
  ContactPresence,
  MarkReadResult,
  MessengerContact,
  MessengerDirectory,
  MessengerGroup,
  RecallMessageInput,
  RecallMessageResult,
  SendMessageInput,
  SendMessageResult
} from '../../shared/types'

const CONNECT_REGISTRY = 'HKCU\\Software\\Jiransoft\\CoolMsg50\\Option\\Connect'
const INFORMATION_REGISTRY = 'HKCU\\Software\\Jiransoft\\CoolMsg50\\Information'
const AWAY_REGISTRY = 'HKCU\\Software\\Jiransoft\\CoolMsg50\\Option\\OffMsg'
const MAIN_SERVER_PORT = 55051
const DIRECTORY_SERVER_PORT = 55052
const SEED_KEY = Buffer.from('      1197667669', 'ascii')
const SEED_IV = Buffer.from('0123456789012345', 'ascii')

interface RegistryValues {
  OfficeID?: string
  ServerAddress?: string
  Passwd?: string
  MessengerVersion?: string
  AutoMsgOff?: string
  AutoMsgOffTimer?: string
}

interface Credentials {
  host: string
  officeId: string
  version: string
  password: string
  passwordHash: string
}

interface ReceiptRow {
  MessageKey: number
  SenderKey: string
  IsUnRead: number
  MemoID: number
}

interface MemberRow {
  K_MemberID: number
  MemberID: string
  MemberName: string
}

interface PendingSend {
  resolve: (memoId: number) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PendingRecall {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface OutgoingRow {
  MessageKey: number
  MemoID: number
  ReceiverKey: string
  AnswerBack: string
}

interface IncomingReceipt {
  memberKey: number
  memberId: string
  memberName: string
  memoId: number
  receivedAt: string
}

class DefiniteSendFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefiniteSendFailure'
  }
}

interface DirectoryData {
  groups: Array<{ key: number; name: string; memberKeys: number[] }>
  contacts: Array<{ key: number; name: string; displayName: string; extension: string }>
}

const EMPTY_DIRECTORY: MessengerDirectory = {
  connected: false,
  syncing: true,
  groups: [],
  contacts: [],
  error: '',
  updatedAt: ''
}

function queryRegistry(path: string): RegistryValues {
  const rawOutput = execFileSync('reg.exe', ['query', path], { windowsHide: true, timeout: 3000 })
  let output: string
  try {
    output = new TextDecoder('utf-8', { fatal: true }).decode(rawOutput)
  } catch {
    output = iconv.decode(rawOutput, 'cp949')
  }
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/)
    if (match) values[match[1]] = match[2].trim()
  }
  return values
}

function loadCredentials(): Credentials {
  const connect = queryRegistry(CONNECT_REGISTRY)
  const information = queryRegistry(INFORMATION_REGISTRY)
  const host = String(connect.ServerAddress || '').trim()
  const officeId = String(connect.OfficeID || '').trim()
  const version = String(information.MessengerVersion || '').trim()
  const encryptedPassword = String(connect.Passwd || '').trim()
  if (!host || !officeId || !version || !encryptedPassword) {
    throw new Error('쿨메신저 로그인 정보를 레지스트리에서 읽을 수 없습니다.')
  }
  const passwordBytes = seedDecrypt(Buffer.from(encryptedPassword, 'base64'))
  const password = iconv.decode(passwordBytes, 'cp949').replace(/\0+$/, '')
  return {
    host,
    officeId,
    version,
    password,
    passwordHash: createHash('sha256').update(iconv.encode(password, 'cp949')).digest('base64')
  }
}

export function coolMessengerOfficeId(): string {
  return loadCredentials().officeId
}

function loadAwaySettings(): { enabled: boolean; idleSeconds: number } {
  try {
    const values = queryRegistry(AWAY_REGISTRY)
    const minutes = Number(values.AutoMsgOffTimer || 5)
    return {
      enabled: Number(values.AutoMsgOff || 0) !== 0,
      idleSeconds: Math.max(1, Number.isFinite(minutes) ? minutes : 5) * 60
    }
  } catch {
    return { enabled: true, idleSeconds: 5 * 60 }
  }
}

function seedEncrypt(plain: Buffer): Buffer {
  return Buffer.from(KISA_SEED_CBC.SEED_CBC_Encrypt(SEED_KEY, SEED_IV, plain, 0, plain.length))
}

function seedDecrypt(ciphertext: Buffer): Buffer {
  return Buffer.from(KISA_SEED_CBC.SEED_CBC_Decrypt(SEED_KEY, SEED_IV, ciphertext, 0, ciphertext.length))
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value)
  return buffer
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}

function wideString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.alloc(2)])
}

function narrowString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'ascii'), Buffer.alloc(1)])
}

function encryptedFrame(command: number, payload = Buffer.alloc(0)): Buffer {
  const encrypted = seedEncrypt(Buffer.concat([int32(command), Buffer.alloc(12), payload]))
  return Buffer.concat([uint32(encrypted.length), encrypted])
}

function plainFrame(command: number, payload = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([int32(command), Buffer.alloc(12), payload])
  return Buffer.concat([uint32(body.length), body])
}

function senderKey(value: string): number {
  const match = value.match(/(\d+)\|?$/)
  const parsed = Number(match?.[1])
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('보낸 사람의 서버 식별 번호를 확인할 수 없습니다.')
  return parsed
}

function readReceiptRow(dbPath: string, messageKey: number): ReceiptRow {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT MessageKey, COALESCE(SenderKey, '') AS SenderKey,
        COALESCE(IsUnRead, 0) AS IsUnRead, COALESCE(MemoID, 0) AS MemoID
      FROM tbl_recv WHERE MessageKey = ?
    `).get(messageKey) as ReceiptRow | undefined
    if (!row) throw new Error('읽음 처리할 메시지를 찾을 수 없습니다.')
    return row
  } finally {
    db.close()
  }
}

function readMember(dbPath: string, memberKey: number): MemberRow {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT K_MemberID, COALESCE(MemberID, '') AS MemberID,
        COALESCE(MemberName, '') AS MemberName
      FROM tbl_member WHERE K_MemberID = ?
    `).get(memberKey) as MemberRow | undefined
    if (!row?.MemberID) throw new Error('현재 사용자의 쿨메신저 정보를 확인할 수 없습니다.')
    return row
  } finally {
    db.close()
  }
}

function readOutgoingRow(dbPath: string, messageKey: number): OutgoingRow {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare(`
      SELECT MessageKey, COALESCE(MemoID, 0) AS MemoID,
        COALESCE(ReceiverKey, '') AS ReceiverKey,
        COALESCE(AnswerBack, '') AS AnswerBack
      FROM tbl_send WHERE MessageKey = ?
    `).get(messageKey) as OutgoingRow | undefined
    if (!row) throw new Error('회수할 보낸 쪽지를 찾을 수 없습니다.')
    if (row.MemoID <= 0) throw new Error('서버 발송 번호가 없는 쪽지는 회수할 수 없습니다.')
    if (parseAnswerBack(row.AnswerBack).length > 0) throw new Error('받는 사람이 이미 수신한 쪽지는 회수할 수 없습니다.')
    return row
  } finally {
    db.close()
  }
}

function outgoingReceiverKeys(value: string): number[] {
  const values = String(value || '')
    .split('|')
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item))
    .map(Number)
  const declaredCount = values[0] || 0
  const keys = [...new Set(values.slice(1).filter((item) => item > 0))]
  const result = declaredCount > 0 ? keys.slice(0, declaredCount) : keys
  if (!result.length) throw new Error('회수할 쪽지의 받는 사람 정보를 확인할 수 없습니다.')
  return result
}

function parseAnswerBack(value: string): Array<{ memberKey: number; receivedAt: string }> {
  const parts = String(value || '').split('|').filter(Boolean)
  const count = Math.max(0, Number(parts[0]) || 0)
  const receipts: Array<{ memberKey: number; receivedAt: string }> = []
  for (let index = 0; index < count; index += 1) {
    const memberKey = Number(parts[1 + index * 2])
    const receivedAt = String(parts[2 + index * 2] || '').trim()
    if (Number.isInteger(memberKey) && memberKey > 0 && receivedAt) receipts.push({ memberKey, receivedAt })
  }
  return receipts
}

function saveOutgoingReceipt(dbPath: string, receipt: IncomingReceipt): boolean {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    return db.transaction(() => {
      const row = db.prepare(`
        SELECT MessageKey, COALESCE(ReceiverKey, '') AS ReceiverKey,
          COALESCE(AnswerBack, '') AS AnswerBack
        FROM tbl_send WHERE MemoID = ? ORDER BY MessageKey DESC LIMIT 1
      `).get(receipt.memoId) as { MessageKey: number; ReceiverKey: string; AnswerBack: string } | undefined
      if (!row || !outgoingReceiverKeys(row.ReceiverKey).includes(receipt.memberKey)) return false
      const receipts = parseAnswerBack(row.AnswerBack)
      if (receipts.some((item) => item.memberKey === receipt.memberKey)) return false
      receipts.push({ memberKey: receipt.memberKey, receivedAt: receipt.receivedAt })
      const answerBack = `|${receipts.length}|${receipts.map((item) => `${item.memberKey}|${item.receivedAt}|`).join('')}`
      return db.prepare('UPDATE tbl_send SET AnswerBack = ? WHERE MessageKey = ?').run(answerBack, row.MessageKey).changes > 0
    })()
  } finally {
    db.close()
  }
}

function setLocallyRead(dbPath: string, row: ReceiptRow): void {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 3000')
    db.prepare(`
      UPDATE tbl_recv SET IsUnRead = 0
      WHERE MessageKey = ? AND MemoID = ? AND IsUnRead = ?
    `).run(row.MessageKey, row.MemoID, row.IsUnRead)
  } finally {
    db.close()
  }
}

function escapeMessageHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>')
}

function compressedMessageBody(body: string): string {
  const html = `<div style="line-height: 1.35;"><code>${escapeMessageHtml(body)}</code></div>`
  return deflateSync(Buffer.from(html, 'utf16le')).toString('base64')
}

function outgoingDate(): string {
  const now = new Date()
  const weekday = '일월화수목금토'[now.getDay()]
  return `${protocolDate(now)} (${weekday})`
}

function reserveOutgoingMessage(
  dbPath: string,
  recipients: MemberRow[],
  title: string,
  body: string,
  compressedBody: string
): number {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    return db.transaction(() => {
      const row = db.prepare('SELECT COALESCE(MAX(MessageKey), 0) + 1 AS MessageKey FROM tbl_send').get() as { MessageKey: number }
      const messageKey = Number(row.MessageKey)
      const receiverKey = `|${recipients.length}|${recipients.map((recipient) => recipient.K_MemberID).join('|')}|`
      const receiverNames = recipients.map((recipient) => `${recipient.MemberName}(${recipient.MemberID});`).join(' ')
      db.prepare(`
        INSERT INTO tbl_send (
          MessageKey, MessageBody, Title, Receiver, ReceiverKey, ReferenceList, CCList,
          MessageType, SendDate, FilePath, FileHost, AnswerBack, CoolFile2SessionID,
          ScheduledDate, MessageText, MemoID, IsChecked, IsMoved, LinkURL,
          MessageCategory, DeletedDate
        ) VALUES (?, ?, ?, ?, ?, ?, '|0|', 5, ?, '', '', '', '', '', ?, 0, 0, NULL, '', 0, NULL)
      `).run(
        messageKey,
        `{COMP}${compressedBody}`,
        title,
        receiverNames,
        receiverKey,
        receiverKey,
        outgoingDate(),
        `\r\n${body}`
      )
      return messageKey
    })()
  } finally {
    db.close()
  }
}

function deleteReservedOutgoingMessage(dbPath: string, messageKey: number): boolean {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    return db.prepare(`
      DELETE FROM tbl_send
      WHERE MessageKey = ? AND COALESCE(MemoID, 0) = 0
    `).run(messageKey).changes > 0
  } finally {
    db.close()
  }
}

function discardDefinitelyFailedOutgoing(dbPath: string, messageKey: number): void {
  try {
    if (!deleteReservedOutgoingMessage(dbPath, messageKey)) {
      console.warn(`[CoolMessenger] 확정 실패한 발송 예약 행을 정리하지 못했습니다. messageKey=${messageKey}`)
    }
  } catch (error) {
    console.warn(`[CoolMessenger] 확정 실패한 발송 예약 행 정리 중 오류가 발생했습니다. messageKey=${messageKey}`, error)
  }
}

function setOutgoingMemoId(dbPath: string, messageKey: number, memoId: number): boolean {
  const db = new Database(dbPath, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 5000')
    const updated = db.prepare('UPDATE tbl_send SET MemoID = ? WHERE MessageKey = ? AND MemoID = 0').run(memoId, messageKey)
    if (updated.changes > 0) return true
    const row = db.prepare('SELECT COALESCE(MemoID, 0) AS MemoID FROM tbl_send WHERE MessageKey = ?').get(messageKey) as { MemoID: number } | undefined
    return Number(row?.MemoID || 0) === memoId
  } finally {
    db.close()
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function protocolDate(date: Date, hourOnly = false): string {
  const time = hourOnly ? `${pad(date.getHours())}:00:00 ` : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`
}

function receiptTimestamp(): string {
  const now = new Date()
  const weekday = '일월화수목금토'[now.getDay()]
  return `${protocolDate(now)} (${weekday})`
}

function ipv4(address: string | undefined): string {
  const value = String(address || '').replace(/^::ffff:/, '')
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('쿨메신저 서버에 사용할 로컬 IP 주소를 확인할 수 없습니다.')
  }
  return value
}

function ipv4Bytes(address: string | undefined): Buffer {
  return Buffer.from(ipv4(address).split('.').map(Number))
}

class BufferReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  remaining(): number { return this.buffer.length - this.offset }

  u8(): number {
    this.ensure(1)
    return this.buffer[this.offset++]
  }

  u32(): number {
    this.ensure(4)
    const result = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    return result
  }

  i32(): number {
    this.ensure(4)
    const result = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return result
  }

  peekU32(): number {
    this.ensure(4)
    return this.buffer.readUInt32BE(this.offset)
  }

  wide(): string {
    let end = this.offset
    while (end + 1 < this.buffer.length && (this.buffer[end] !== 0 || this.buffer[end + 1] !== 0)) end += 2
    if (end + 1 >= this.buffer.length) throw new Error('주소록 문자열이 올바르지 않습니다.')
    const result = this.buffer.subarray(this.offset, end).toString('utf16le')
    this.offset = end + 2
    return result
  }

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) throw new Error('주소록 데이터가 예상보다 짧습니다.')
  }
}

function parseIncomingReceipt(payload: Buffer): IncomingReceipt | undefined {
  // The server may forward the original routing key or strip it before delivery.
  for (const offset of [4, 0]) {
    if (payload.length <= offset + 16) continue
    try {
      const reader = new BufferReader(payload.subarray(offset))
      const memberKey = reader.u32()
      const memberId = reader.wide().trim()
      const memberName = reader.wide().trim()
      const memoId = reader.i32()
      const unreadValue = reader.wide().trim()
      const receivedAt = reader.wide().trim()
      if (
        Number.isInteger(memberKey) && memberKey > 0 &&
        memberId.length > 0 && memberId.length <= 200 &&
        memberName.length > 0 && memberName.length <= 200 &&
        Number.isInteger(memoId) && memoId > 0 &&
        /^\d+$/.test(unreadValue) &&
        /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?: \([A-Za-z]{3}\))?$/.test(receivedAt)
      ) return { memberKey, memberId, memberName, memoId, receivedAt }
    } catch {
      // Try the alternate forwarded-payload layout.
    }
  }
  return undefined
}

function parseDirectory(payload: Buffer): DirectoryData {
  const reader = new BufferReader(payload)
  reader.u32()
  reader.u32()
  reader.u32()
  reader.wide()
  const groupCount = reader.u32()
  reader.i32()
  reader.i32()
  reader.wide()
  reader.u32()

  const groups: DirectoryData['groups'] = []
  for (let index = 0; index < groupCount; index += 1) {
    reader.u32()
    const key = reader.u32()
    reader.u32()
    if (index === groupCount - 1 && reader.peekU32() === 1) reader.u32()
    const name = reader.wide()
    reader.u32()
    groups.push({ key, name, memberKeys: [] })
  }

  reader.u32()
  const userCount = reader.u32()
  const contacts: DirectoryData['contacts'] = []
  for (let index = 0; index < userCount; index += 1) {
    const key = reader.u32()
    const name = reader.wide()
    const displayName = reader.wide()
    reader.u8()
    reader.u32()
    reader.u32()
    contacts.push({ key, name, displayName, extension: '' })
  }

  const relationCount = reader.u32()
  const groupMap = new Map(groups.map((group) => [group.key, group]))
  for (let index = 0; index < relationCount; index += 1) {
    const userKey = reader.u32()
    const groupKey = reader.u32()
    reader.u32()
    reader.u32()
    reader.u8()
    const group = groupMap.get(groupKey)
    if (group && !group.memberKeys.includes(userKey)) group.memberKeys.push(userKey)
  }
  return { groups, contacts }
}

function parseExtensions(payload: Buffer): Map<number, string> {
  const reader = new BufferReader(payload)
  const count = reader.u32()
  const extensions = new Map<number, string>()
  for (let index = 0; index < count && reader.remaining() >= 8; index += 1) {
    const key = reader.u32()
    const primary = reader.wide()
    const secondary = reader.wide()
    extensions.set(key, primary || secondary)
  }
  return extensions
}

function presence(code: number | undefined, statusLoaded: boolean, connected: boolean): ContactPresence {
  if (!connected || !statusLoaded) return 'unknown'
  if (code === 1) return 'online'
  if (code === 3) return 'away'
  return 'offline'
}

export class CoolMessengerSession {
  private mainSocket?: Socket
  private mainIncoming = Buffer.alloc(0)
  private currentUserKey = 0
  private loggedIn = false
  private initialFrames = 0
  private loginSent = false
  private statusLoaded = false
  private stopped = false
  private reconnectTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private statusTimer?: NodeJS.Timeout
  private directoryTimer?: NodeJS.Timeout
  private idleTimer?: NodeJS.Timeout
  private resumeTimer?: NodeJS.Timeout
  private awaySettings = { enabled: true, idleSeconds: 5 * 60 }
  private desiredPresence: 1 | 3 = 1
  private directoryData: DirectoryData = { groups: [], contacts: [] }
  private statuses = new Map<number, number>()
  private directory: MessengerDirectory = { ...EMPTY_DIRECTORY }
  private readonly pendingSends = new Map<number, PendingSend>()
  private readonly pendingRecalls = new Map<number, PendingRecall>()
  private readonly sendRequests = new Map<string, Promise<SendMessageResult>>()
  private readonly recallRequests = new Map<string, Promise<RecallMessageResult>>()
  private readonly handleSuspend = (): void => {
    this.mainSocket?.destroy()
  }
  private readonly handleResume = (): void => {
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined
      this.reconnectImmediately()
      setTimeout(() => this.updateIdlePresence(), 1000)
    }, 400)
  }
  private readonly handleUserActive = (): void => {
    this.setPresence(1)
  }

  constructor(
    private dbPath: string,
    private readonly onUpdate: (directory: MessengerDirectory) => void,
    private readonly onReceipt: () => void
  ) {}

  start(): void {
    this.stopped = false
    this.awaySettings = loadAwaySettings()
    this.updateIdlePresence()
    this.connectMain()
    void this.syncDirectory()
    this.directoryTimer = setInterval(() => void this.syncDirectory(), 30 * 60 * 1000)
    this.idleTimer = setInterval(() => this.updateIdlePresence(), 5000)
    powerMonitor.on('suspend', this.handleSuspend)
    powerMonitor.on('resume', this.handleResume)
    powerMonitor.on('unlock-screen', this.handleResume)
    powerMonitor.on('user-did-become-active', this.handleUserActive)
  }

  dispose(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.statusTimer) clearInterval(this.statusTimer)
    if (this.directoryTimer) clearInterval(this.directoryTimer)
    if (this.idleTimer) clearInterval(this.idleTimer)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    powerMonitor.off('suspend', this.handleSuspend)
    powerMonitor.off('resume', this.handleResume)
    powerMonitor.off('unlock-screen', this.handleResume)
    powerMonitor.off('user-did-become-active', this.handleUserActive)
    this.mainSocket?.destroy()
    this.rejectPendingSends(new Error('쿨메신저 연결이 종료되었습니다.'))
  }

  updateDbPath(dbPath: string): void {
    this.dbPath = dbPath
  }

  getSnapshot(): MessengerDirectory {
    return this.directory
  }

  async login(): Promise<void> {
    if (this.loggedIn) return
    this.reconnectImmediately()
    await this.waitForLogin()
  }

  async markMessageRead(messageKey: number): Promise<MarkReadResult> {
    const row = readReceiptRow(this.dbPath, messageKey)
    if (row.IsUnRead === 0) return { marked: false, alreadyRead: true }
    if (row.MemoID <= 0) throw new Error('이 메시지에는 서버 읽음 번호가 없습니다.')
    await this.waitForLogin()
    const socket = this.mainSocket
    if (!socket || socket.destroyed || !this.currentUserKey) throw new Error('쿨메신저 서버에 연결되어 있지 않습니다.')
    const member = readMember(this.dbPath, this.currentUserKey)
    const payload = Buffer.concat([
      uint32(senderKey(row.SenderKey)),
      int32(this.currentUserKey),
      wideString(member.MemberID),
      wideString(member.MemberName),
      int32(row.MemoID),
      wideString(String(row.IsUnRead)),
      wideString(receiptTimestamp())
    ])
    await new Promise<void>((resolve, reject) => {
      socket.write(encryptedFrame(11, payload), (error) => error ? reject(error) : setTimeout(resolve, 500))
    })
    setLocallyRead(this.dbPath, row)
    return { marked: true, alreadyRead: false }
  }

  sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const clientSendId = String(input.clientSendId || '').trim()
    if (!/^[0-9a-z-]{8,128}$/i.test(clientSendId)) {
      return Promise.reject(new Error('쪽지 발송 식별자가 올바르지 않습니다.'))
    }
    const existing = this.sendRequests.get(clientSendId)
    if (existing) return existing
    const request = this.performSendMessage(input)
    this.sendRequests.set(clientSendId, request)
    if (this.sendRequests.size > 100) {
      const oldest = this.sendRequests.keys().next().value
      if (oldest && oldest !== clientSendId) this.sendRequests.delete(oldest)
    }
    return request
  }

  recallMessage(input: RecallMessageInput): Promise<RecallMessageResult> {
    const clientRecallId = String(input.clientRecallId || '').trim()
    if (!/^[0-9a-z-]{8,128}$/i.test(clientRecallId)) {
      return Promise.reject(new Error('쪽지 회수 식별자가 올바르지 않습니다.'))
    }
    const existing = this.recallRequests.get(clientRecallId)
    if (existing) return existing
    const request = this.performRecallMessage(input)
    this.recallRequests.set(clientRecallId, request)
    if (this.recallRequests.size > 100) {
      const oldest = this.recallRequests.keys().next().value
      if (oldest && oldest !== clientRecallId) this.recallRequests.delete(oldest)
    }
    return request
  }

  private async performRecallMessage(input: RecallMessageInput): Promise<RecallMessageResult> {
    const messageKey = Number(input.messageKey)
    if (!Number.isInteger(messageKey) || messageKey <= 0) throw new Error('회수할 쪽지 번호가 올바르지 않습니다.')
    const row = readOutgoingRow(this.dbPath, messageKey)
    await this.waitForLogin()
    const socket = this.mainSocket
    if (!socket || socket.destroyed) throw new Error('쿨메신저 서버에 연결되어 있지 않습니다.')
    await this.sendRecall(socket, row.MemoID, outgoingReceiverKeys(row.ReceiverKey))
    return { recalled: true, alreadyRecalled: false, memoId: row.MemoID, recalledAt: new Date().toISOString() }
  }

  private sendRecall(socket: Socket, memoId: number, recipientKeys: number[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRecalls.get(memoId)
        if (!pending) return
        this.pendingRecalls.delete(memoId)
        pending.reject(new Error('쿨메신저 서버에서 회수 결과를 확인하지 못했습니다. 로그인 연결을 새로 고친 뒤 다시 시도해 주세요.'))
        if (this.mainSocket === socket) socket.destroy()
      }, 12_000)
      this.pendingRecalls.set(memoId, { resolve, reject, timer })
      const payload = Buffer.concat([
        int32(memoId),
        int32(recipientKeys.length),
        ...recipientKeys.map(int32)
      ])
      socket.write(encryptedFrame(106, payload), (error) => {
        if (!error) return
        const pending = this.pendingRecalls.get(memoId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingRecalls.delete(memoId)
        pending.reject(error)
      })
    })
  }

  private async performSendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const recipientKeys = [...new Set(input.recipientKeys.map(Number))]
    const title = String(input.title || '').trim()
    const body = String(input.body || '').trim()
    if (recipientKeys.length === 0 || recipientKeys.some((key) => !Number.isInteger(key) || key <= 0)) {
      throw new Error('받는 사람을 한 명 이상 선택해 주세요.')
    }
    if (!title || title.length > 200) throw new Error('제목은 1자 이상 200자 이하로 입력해 주세요.')
    if (!body || body.length > 20_000) throw new Error('본문은 1자 이상 20,000자 이하로 입력해 주세요.')
    await this.waitForLogin()
    const socket = this.mainSocket
    if (!socket || socket.destroyed || !this.currentUserKey) throw new Error('쿨메신저 서버에 연결되어 있지 않습니다.')
    if (recipientKeys.includes(this.currentUserKey)) {
      throw new Error('본인에게 보내기는 쿨메신저의 5분 예약 발송 방식이 필요합니다. 현재는 다른 사람에게 보내기를 이용해 주세요.')
    }
    if (recipientKeys.length > 1) {
      throw new Error('단체 쪽지 패킷 확인이 필요합니다. 현재는 한 명에게 보내기만 사용할 수 있습니다.')
    }

    const sender = readMember(this.dbPath, this.currentUserKey)
    const recipients = recipientKeys.map((recipientKey) => readMember(this.dbPath, recipientKey))
    const compressedBody = compressedMessageBody(body)
    const messageKey = reserveOutgoingMessage(this.dbPath, recipients, title, body, compressedBody)
    let payloads: Buffer[]
    try {
      payloads = recipientKeys.map((recipientKey) => Buffer.concat([
        int32(recipientKey),
        int32(this.currentUserKey),
        wideString(sender.MemberID),
        wideString(sender.MemberName),
        randomBytes(4),
        int32(0),
        narrowString(compressedBody),
        wideString(title),
        wideString(`\r\n${body}`),
        int32(0),
        int32(messageKey),
        int32(0),
        int32(0),
        int32(0)
      ]))
    } catch (error) {
      discardDefinitelyFailedOutgoing(this.dbPath, messageKey)
      throw error
    }

    let memoId: number
    try {
      memoId = await this.sendPacketAndWaitForAck(socket, messageKey, payloads)
    } catch (error) {
      if (error instanceof DefiniteSendFailure) discardDefinitelyFailedOutgoing(this.dbPath, messageKey)
      throw error
    }
    try {
      if (!setOutgoingMemoId(this.dbPath, messageKey, memoId)) {
        console.warn(`[CoolMessenger] 서버 발송은 성공했지만 로컬 MemoID를 확인하지 못했습니다. messageKey=${messageKey}, memoId=${memoId}`)
      }
    } catch (error) {
      console.warn(`[CoolMessenger] 서버 발송은 성공했지만 로컬 MemoID 저장에 실패했습니다. messageKey=${messageKey}, memoId=${memoId}`, error)
    }
    return { sent: true, memoId, recipientCount: recipientKeys.length, sentAt: new Date().toISOString() }
  }

  private sendPacketAndWaitForAck(socket: Socket, messageKey: number, payloads: Buffer[]): Promise<number> {
    if (socket.destroyed || this.mainSocket !== socket) {
      throw new DefiniteSendFailure('쪽지 패킷을 보내기 전에 쿨메신저 연결이 종료되었습니다.')
    }
    let frame: Buffer
    try {
      const plain = Buffer.concat([int32(8), int32(0), int32(payloads.length), int32(0), ...payloads])
      const encrypted = seedEncrypt(plain)
      frame = Buffer.concat([uint32(encrypted.length), encrypted])
    } catch {
      throw new DefiniteSendFailure('쪽지 패킷을 준비하지 못했습니다.')
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(messageKey)
        reject(new Error('서버의 쪽지 발송 확인이 지연되고 있습니다. 중복 발송을 막기 위해 자동 재시도하지 않았습니다.'))
      }, 12_000)
      this.pendingSends.set(messageKey, { resolve, reject, timer })
      try {
        socket.write(frame, (error) => {
          if (!error) return
          const pending = this.pendingSends.get(messageKey)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pendingSends.delete(messageKey)
          pending.reject(error)
        })
      } catch {
        const pending = this.pendingSends.get(messageKey)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingSends.delete(messageKey)
        pending.reject(new DefiniteSendFailure('쪽지 패킷을 서버에 전달하지 못했습니다.'))
      }
    })
  }

  private rejectPendingSends(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingSends.clear()
    for (const pending of this.pendingRecalls.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRecalls.clear()
  }

  private connectMain(): void {
    if (this.stopped || (this.mainSocket && !this.mainSocket.destroyed)) return
    let credentials: Credentials
    try {
      credentials = loadCredentials()
    } catch (error) {
      this.setConnectionError(error)
      this.scheduleReconnect()
      return
    }

    const socket = new Socket()
    this.mainSocket = socket
    this.mainIncoming = Buffer.alloc(0)
    this.loggedIn = false
    this.initialFrames = 0
    this.loginSent = false
    this.statusLoaded = false
    let loginFallback: NodeJS.Timeout | undefined

    const sendLogin = (): void => {
      if (this.loginSent || socket.destroyed) return
      try {
        this.loginSent = true
        const tail = Buffer.alloc(9)
        ipv4Bytes(socket.localAddress).copy(tail)
        tail.writeInt32BE(0, 4)
        tail[8] = 1
        socket.write(encryptedFrame(3, Buffer.concat([
          wideString(credentials.version),
          wideString(credentials.officeId),
          wideString(credentials.passwordHash),
          tail
        ])))
      } catch (error) {
        this.setConnectionError(error)
        socket.destroy()
      }
    }

    socket.setNoDelay(true)
    socket.setKeepAlive(true, 2000)
    socket.on('connect', () => {
      socket.write(encryptedFrame(1))
      loginFallback = setTimeout(sendLogin, 800)
    })
    socket.on('data', (chunk) => {
      if (this.mainSocket !== socket) return
      this.mainIncoming = Buffer.concat([this.mainIncoming, chunk])
      while (this.mainIncoming.length >= 4) {
        const length = this.mainIncoming.readUInt32BE(0)
        if (length <= 0 || length > 8 * 1024 * 1024) {
          this.setConnectionError(new Error('쿨메신저 서버가 올바르지 않은 패킷을 반환했습니다.'))
          socket.destroy()
          return
        }
        if (this.mainIncoming.length < length + 4) return
        const encrypted = this.mainIncoming.subarray(4, length + 4)
        this.mainIncoming = this.mainIncoming.subarray(length + 4)
        const plain = seedDecrypt(encrypted)
        if (plain.length < 16) continue
        if (!this.loginSent && ++this.initialFrames >= 3) sendLogin()
        this.handleMainPacket(plain, credentials)
      }
    })
    socket.on('error', (error) => {
      if (this.mainSocket === socket) this.setConnectionError(error)
    })
    socket.on('close', () => {
      if (loginFallback) clearTimeout(loginFallback)
      if (this.mainSocket !== socket) return
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      if (this.statusTimer) clearInterval(this.statusTimer)
      this.mainSocket = undefined
      this.loggedIn = false
      this.currentUserKey = 0
      this.statusLoaded = false
      this.statuses.clear()
      this.rejectPendingSends(new Error('쪽지를 보내는 중 쿨메신저 연결이 끊어졌습니다.'))
      this.publish()
      this.scheduleReconnect()
    })
    socket.connect(MAIN_SERVER_PORT, credentials.host)
  }

  private handleMainPacket(plain: Buffer, credentials: Credentials): void {
    const command = plain.readInt32BE(0)
    const payload = plain.subarray(16)
    if (command === 11) {
      const receipt = parseIncomingReceipt(payload)
      if (receipt) {
        try {
          if (saveOutgoingReceipt(this.dbPath, receipt)) this.onReceipt()
        } catch {
          // The periodic refresh and a later server receipt remain available if the DB is briefly locked.
        }
      }
      return
    }
    if (command === 107 && payload.length >= 8) {
      const memoId = payload.readInt32BE(0)
      const resultCode = payload.readInt32BE(4)
      const pending = this.pendingRecalls.get(memoId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRecalls.delete(memoId)
        if (resultCode === 0) pending.resolve()
        else if (resultCode === 3) {
          pending.reject(new Error('상대방이 이미 읽은 쪽지라 회수할 수 없습니다. 쿨메신저는 읽지 않은 메시지만 회수할 수 있습니다.'))
        } else {
          pending.reject(new Error(`쿨메신저 서버가 쪽지 회수를 거절했습니다. (결과 코드 ${resultCode})`))
        }
      }
      return
    }
    if (command === 149) return
    if (command === 56 && payload.length >= 8) {
      const messageKey = payload.readInt32BE(0)
      const memoId = payload.readInt32BE(4)
      const pending = this.pendingSends.get(messageKey)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingSends.delete(messageKey)
        if (memoId > 0) pending.resolve(memoId)
        else pending.reject(new DefiniteSendFailure('쿨메신저 서버가 쪽지 발송을 거부했습니다.'))
      }
      return
    }
    if (command === 3) {
      if (payload.length < 4 || payload.readInt32BE(0) <= 0) {
        this.setConnectionError(new Error('쿨메신저 서버 로그인이 거부되었습니다.'))
        this.mainSocket?.destroy()
        return
      }
      this.currentUserKey = payload.readInt32BE(0)
      this.loggedIn = true
      this.directory = { ...this.directory, error: '' }
      this.requestInitialStatus(credentials.officeId)
      this.heartbeatTimer = setInterval(() => this.writeMain(1), 10_000)
      this.statusTimer = setInterval(() => this.requestStatus(), 60_000)
      this.updateIdlePresence(true)
      this.publish()
      return
    }
    if (command === 6 && payload.length >= 4) {
      const count = payload.readUInt32BE(0)
      const statuses = new Map<number, number>()
      for (let index = 0, offset = 4; index < count && offset + 5 <= payload.length; index += 1, offset += 5) {
        statuses.set(payload.readUInt32BE(offset), payload[offset + 4])
      }
      this.statuses = statuses
      this.statusLoaded = true
      this.publish()
      return
    }
    if (command === 7 && payload.length >= 5) {
      this.statuses.set(payload.readUInt32BE(0), payload[4])
      this.statusLoaded = true
      this.publish()
      return
    }
    if (command === 8 && payload.length >= 4) {
      this.statuses.delete(payload.readUInt32BE(0))
      this.publish()
    }
  }

  private requestInitialStatus(officeId: string): void {
    this.writeMain(25, int32(this.currentUserKey))
    this.writeMain(34, Buffer.concat([int32(this.currentUserKey), wideString(officeId), int32(0), int32(0)]))
    this.requestStatus()
  }

  private requestStatus(): void {
    const now = new Date()
    this.writeMain(5, Buffer.concat([wideString(protocolDate(now, true)), wideString(protocolDate(now))]))
  }

  private writeMain(command: number, payload = Buffer.alloc(0)): void {
    const socket = this.mainSocket
    if (!socket || socket.destroyed) return
    socket.write(encryptedFrame(command, payload))
  }

  private updateIdlePresence(force = false): void {
    const nextPresence: 1 | 3 = this.awaySettings.enabled && powerMonitor.getSystemIdleTime() >= this.awaySettings.idleSeconds ? 3 : 1
    if (!force && nextPresence === this.desiredPresence) return
    this.setPresence(nextPresence, force)
  }

  private setPresence(nextPresence: 1 | 3, force = false): void {
    if (!force && nextPresence === this.desiredPresence) return
    this.desiredPresence = nextPresence
    if (!this.loggedIn || !this.currentUserKey) return
    this.writeMain(7, Buffer.concat([
      int32(this.currentUserKey),
      Buffer.from([nextPresence]),
      int32(0)
    ]))
    if (this.statusLoaded) {
      this.statuses.set(this.currentUserKey, nextPresence)
      this.publish()
    }
  }

  private waitForLogin(timeout = 12_000): Promise<void> {
    if (this.loggedIn) return Promise.resolve()
    if (!this.mainSocket || this.mainSocket.destroyed) this.connectMain()
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const timer = setInterval(() => {
        if (this.loggedIn) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve()
        } else if (this.stopped || Date.now() - startedAt >= timeout) {
          clearInterval(timer)
          clearTimeout(deadline)
          reject(new Error('쿨메신저 서버 로그인 시간이 초과되었습니다.'))
        }
      }, 100)
      const deadline = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('쿨메신저 서버 로그인 시간이 초과되었습니다.'))
      }, timeout + 100)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.mainSocket = undefined
      this.connectMain()
    }, 2500)
  }

  private reconnectImmediately(): void {
    if (this.stopped) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const socket = this.mainSocket
    this.mainSocket = undefined
    if (socket && !socket.destroyed) socket.destroy()
    this.connectMain()
  }

  private async syncDirectory(): Promise<void> {
    if (this.stopped) return
    this.directory = { ...this.directory, syncing: true, error: '' }
    this.publish()
    try {
      this.directoryData = await this.fetchDirectory()
      this.directory = { ...this.directory, syncing: false, error: '', updatedAt: new Date().toISOString() }
    } catch (error) {
      this.directory = {
        ...this.directory,
        syncing: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    this.publish()
  }

  private fetchDirectory(): Promise<DirectoryData> {
    const credentials = loadCredentials()
    return new Promise((resolve, reject) => {
      const socket = new Socket()
      let incoming = Buffer.alloc(0)
      let data: DirectoryData | undefined
      let settled = false
      const timeout = setTimeout(() => finish(new Error('쿨메신저 주소록을 불러오는 시간이 초과되었습니다.')), 12_000)

      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        socket.destroy()
        if (error) reject(error)
        else if (data) resolve(data)
        else reject(new Error('쿨메신저 주소록 데이터가 비어 있습니다.'))
      }

      socket.setNoDelay(true)
      socket.on('connect', () => {
        try {
          socket.write(plainFrame(3000, Buffer.concat([
            int32(0),
            wideString(ipv4(socket.localAddress)),
            wideString(credentials.officeId),
            wideString(credentials.password),
            int32(-1),
            int32(0)
          ])))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.on('data', (chunk) => {
        incoming = Buffer.concat([incoming, chunk])
        while (incoming.length >= 4) {
          const length = incoming.readUInt32BE(0)
          if (length < 16 || length > 16 * 1024 * 1024) {
            finish(new Error('쿨메신저 주소록 패킷이 올바르지 않습니다.'))
            return
          }
          if (incoming.length < length + 4) return
          const body = incoming.subarray(4, length + 4)
          incoming = incoming.subarray(length + 4)
          const command = body.readInt32BE(0)
          const payload = body.subarray(16)
          try {
            if (command === 3002) {
              data = parseDirectory(payload)
              socket.write(plainFrame(3003))
              setTimeout(() => finish(), 700)
            } else if (command === 3003 && data) {
              const extensions = parseExtensions(payload)
              data.contacts = data.contacts.map((contact) => ({
                ...contact,
                extension: extensions.get(contact.key) || ''
              }))
              finish()
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
      socket.on('error', (error) => finish(error))
      socket.on('close', () => {
        if (!settled) finish(data ? undefined : new Error('쿨메신저 주소록 연결이 종료되었습니다.'))
      })
      socket.connect(DIRECTORY_SERVER_PORT, credentials.host)
    })
  }

  private setConnectionError(error: unknown): void {
    this.directory = {
      ...this.directory,
      error: error instanceof Error ? error.message : String(error)
    }
    this.publish()
  }

  private publish(): void {
    const contacts: MessengerContact[] = this.directoryData.contacts.map((contact) => ({
      ...contact,
      role: contact.displayName.startsWith(contact.name) ? contact.displayName.slice(contact.name.length).trim() : contact.displayName,
      status: presence(this.statuses.get(contact.key), this.statusLoaded, this.loggedIn)
    }))
    const groups: MessengerGroup[] = this.directoryData.groups.map((group) => ({ ...group }))
    this.directory = {
      ...this.directory,
      connected: this.loggedIn,
      groups,
      contacts
    }
    this.onUpdate(this.directory)
  }
}
