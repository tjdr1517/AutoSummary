import Database from 'better-sqlite3'
import iconv from 'iconv-lite'
import { KISA_SEED_CBC } from 'kisa-seed'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Socket } from 'node:net'
import { powerMonitor } from 'electron'
import type {
  ContactPresence,
  MarkReadResult,
  MessengerContact,
  MessengerDirectory,
  MessengerGroup
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
    private readonly onUpdate: (directory: MessengerDirectory) => void
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
      this.publish()
      this.scheduleReconnect()
    })
    socket.connect(MAIN_SERVER_PORT, credentials.host)
  }

  private handleMainPacket(plain: Buffer, credentials: Credentials): void {
    const command = plain.readInt32BE(0)
    const payload = plain.subarray(16)
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
