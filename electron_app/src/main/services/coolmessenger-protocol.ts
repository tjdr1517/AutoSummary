import Database from 'better-sqlite3'
import iconv from 'iconv-lite'
import { KISA_SEED_CBC } from 'kisa-seed'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Socket } from 'node:net'
import type { MarkReadResult } from '../../shared/types'

const CONNECT_REGISTRY = 'HKCU\\Software\\Jiransoft\\CoolMsg50\\Option\\Connect'
const INFORMATION_REGISTRY = 'HKCU\\Software\\Jiransoft\\CoolMsg50\\Information'
const SERVER_PORT = 55051
const SEED_KEY = Buffer.from('      1197667669', 'ascii')
const SEED_IV = Buffer.from('0123456789012345', 'ascii')

interface RegistryValues {
  OfficeID?: string
  ServerAddress?: string
  Passwd?: string
  MessengerVersion?: string
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

function queryRegistry(path: string): RegistryValues {
  const output = execFileSync('reg.exe', ['query', path], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000
  })
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/)
    if (match) values[match[1]] = match[2].trim()
  }
  return values
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

function protocolFrame(command: number, payload = Buffer.alloc(0)): Buffer {
  const plain = Buffer.concat([int32(command), Buffer.alloc(12), payload])
  const encrypted = seedEncrypt(plain)
  const frame = Buffer.alloc(4 + encrypted.length)
  frame.writeUInt32BE(encrypted.length)
  encrypted.copy(frame, 4)
  return frame
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

function currentTimestamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const weekday = '일월화수목금토'[now.getDay()]
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} (${weekday})`
}

function ipv4Bytes(address: string | undefined): Buffer {
  const parts = String(address || '').replace(/^::ffff:/, '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('쿨메신저 서버에 사용할 로컬 IP 주소를 확인할 수 없습니다.')
  }
  return Buffer.from(parts)
}

async function sendReceipt(dbPath: string, row: ReceiptRow): Promise<void> {
  const connect = queryRegistry(CONNECT_REGISTRY)
  const information = queryRegistry(INFORMATION_REGISTRY)
  const host = String(connect.ServerAddress || '').trim()
  const officeId = String(connect.OfficeID || '').trim()
  const version = String(information.MessengerVersion || '').trim()
  const encryptedPassword = String(connect.Passwd || '').trim()
  if (!host || !officeId || !version || !encryptedPassword) {
    throw new Error('쿨메신저 로그인 설정을 레지스트리에서 읽을 수 없습니다.')
  }

  const passwordBytes = seedDecrypt(Buffer.from(encryptedPassword, 'base64'))
  const password = iconv.decode(passwordBytes, 'cp949')
  const passwordHash = createHash('sha256').update(iconv.encode(password, 'cp949')).digest('base64')

  await new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    let incoming = Buffer.alloc(0)
    let initialFrames = 0
    let loginSent = false
    let receiptSent = false
    let settled = false
    let loginFallback: NodeJS.Timeout | undefined
    let receiptTimer: NodeJS.Timeout | undefined

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (loginFallback) clearTimeout(loginFallback)
      if (receiptTimer) clearTimeout(receiptTimer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    const sendLogin = (): void => {
      if (loginSent || settled) return
      loginSent = true
      try {
        const tail = Buffer.alloc(9)
        ipv4Bytes(socket.localAddress).copy(tail)
        tail.writeInt32BE(0, 4)
        tail[8] = 1
        const payload = Buffer.concat([
          wideString(version),
          wideString(officeId),
          wideString(passwordHash),
          tail
        ])
        socket.write(protocolFrame(3, payload))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    const sendReadReceipt = (currentUserKey: number): void => {
      if (receiptSent || settled) return
      try {
        const member = readMember(dbPath, currentUserKey)
        const payload = Buffer.concat([
          uint32(senderKey(row.SenderKey)),
          int32(currentUserKey),
          wideString(member.MemberID),
          wideString(member.MemberName),
          int32(row.MemoID),
          wideString(String(row.IsUnRead)),
          wideString(currentTimestamp())
        ])
        receiptSent = true
        socket.write(protocolFrame(11, payload), (error) => {
          if (error) finish(error)
          else receiptTimer = setTimeout(() => finish(), 700)
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }

    socket.setTimeout(6000, () => finish(new Error('쿨메신저 서버의 읽음 처리 응답 시간이 초과되었습니다.')))
    socket.on('error', (error) => finish(error))
    socket.on('close', () => {
      if (!settled) finish(new Error('읽음 처리가 끝나기 전에 쿨메신저 서버 연결이 종료되었습니다.'))
    })
    socket.on('connect', () => {
      socket.write(protocolFrame(1))
      loginFallback = setTimeout(sendLogin, 800)
    })
    socket.on('data', (chunk) => {
      incoming = Buffer.concat([incoming, chunk])
      while (incoming.length >= 4) {
        const encryptedLength = incoming.readUInt32BE(0)
        if (encryptedLength <= 0 || encryptedLength > 8 * 1024 * 1024) {
          finish(new Error('쿨메신저 서버가 올바르지 않은 패킷을 반환했습니다.'))
          return
        }
        if (incoming.length < encryptedLength + 4) return
        const encrypted = incoming.subarray(4, encryptedLength + 4)
        incoming = incoming.subarray(encryptedLength + 4)
        const plain = seedDecrypt(encrypted)
        if (plain.length < 16) continue
        const command = plain.readInt32BE(0)
        if (!loginSent && ++initialFrames >= 3) sendLogin()
        if (command === 3 && plain.length >= 20) {
          const currentUserKey = plain.readInt32BE(16)
          if (currentUserKey <= 0) {
            finish(new Error('쿨메신저 서버 로그인이 거부되었습니다.'))
            return
          }
          sendReadReceipt(currentUserKey)
        }
      }
    })

    socket.connect(SERVER_PORT, host)
  })
}

export async function markMessageReadOnServer(dbPath: string, messageKey: number): Promise<MarkReadResult> {
  const row = readReceiptRow(dbPath, messageKey)
  if (row.IsUnRead === 0) return { marked: false, alreadyRead: true }
  if (row.MemoID <= 0) throw new Error('이 메시지에는 서버 읽음 번호가 없습니다.')
  await sendReceipt(dbPath, row)
  setLocallyRead(dbPath, row)
  return { marked: true, alreadyRead: false }
}
