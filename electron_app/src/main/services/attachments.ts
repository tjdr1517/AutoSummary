import { KISA_SEED_CBC } from 'kisa-seed'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Socket } from 'node:net'
import type { AppConfig, Message, MessageAttachment } from '../../shared/types'
import { dataPath } from './config'

const SEED_KEY = Buffer.from('      1197667669', 'ascii')
const SEED_IV = Buffer.from('0123456789012345', 'ascii')
const HISTORY_FILE = 'attachment-downloads.json'
const RECEIVED_FILES = join(homedir(), 'Documents', 'CoolMessenger Files', 'Received Files')
const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024
const MAX_HISTORY_RECORDS = 5_000

interface DownloadRecord {
  messageKey: number
  attachmentIndex: number
  sessionId: string
  name: string
  size: number
  destination: string
  status: 'pending' | 'complete' | 'failed'
  updatedAt: string
  error: string
}

interface DownloadHistory {
  records: Record<string, DownloadRecord>
}

export interface AttachmentSaveResult {
  saved: number
  skipped: number
  failed: number
}

function int32(value: number): Buffer {
  const result = Buffer.alloc(4)
  result.writeInt32BE(value)
  return result
}

function wideString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf16le'), Buffer.alloc(2)])
}

function encryptedFrame(command: number, payload = Buffer.alloc(0)): Buffer {
  const plain = Buffer.concat([int32(command), Buffer.alloc(12), payload])
  const encrypted = Buffer.from(KISA_SEED_CBC.SEED_CBC_Encrypt(SEED_KEY, SEED_IV, plain, 0, plain.length))
  return Buffer.concat([int32(encrypted.length), encrypted])
}

function decryptFrame(ciphertext: Buffer): Buffer {
  return Buffer.from(KISA_SEED_CBC.SEED_CBC_Decrypt(SEED_KEY, SEED_IV, ciphertext, 0, ciphertext.length))
}

function sessionParts(value: string): { sessionId: string; host: string; port: number } {
  const match = value.match(/^(.+)@([^@:]+):(\d+)$/)
  if (!match) throw new Error('첨부파일 서버 세션 정보가 올바르지 않습니다.')
  const port = Number(match[3])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('첨부파일 서버 포트가 올바르지 않습니다.')
  return { sessionId: match[1], host: match[2], port }
}

function recordKey(message: Message, attachment: MessageAttachment, index: number): string {
  return `${message.key}:${index}:${message.fileSessionId}:${attachment.size}:${attachment.name}`
}

function safeFilename(value: string): string {
  const cleaned = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  return cleaned || '첨부파일'
}

function sameSize(path: string, expected: number): boolean {
  if (!path || !existsSync(path) || expected <= 0) return false
  try { return statSync(path).size === expected } catch { return false }
}

function isInside(candidate: string, parent: string): boolean {
  if (!candidate || !parent) return false
  const result = relative(resolve(parent), resolve(candidate))
  return !result.startsWith('..') && !isAbsolute(result)
}

function availableDestination(directory: string, name: string, expectedSize: number): { path: string; existing: boolean } {
  const safeName = safeFilename(name)
  const direct = join(directory, safeName)
  if (!existsSync(direct)) return { path: direct, existing: false }
  if (sameSize(direct, expectedSize)) return { path: direct, existing: true }
  const extension = extname(safeName)
  const stem = safeName.slice(0, safeName.length - extension.length)
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = join(directory, `${stem} (${suffix})${extension}`)
    if (!existsSync(candidate)) return { path: candidate, existing: false }
    if (sameSize(candidate, expectedSize)) return { path: candidate, existing: true }
  }
  throw new Error('첨부파일을 저장할 빈 파일명을 만들 수 없습니다.')
}

function downloadAttachment(
  sessionValue: string,
  userId: string,
  fileIndex: number,
  expectedSize: number,
  targetPath: string
): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(new Error('첨부파일 크기가 안전한 저장 범위를 벗어났습니다.'))
  }
  const { sessionId, host, port } = sessionParts(sessionValue)
  mkdirSync(dirname(targetPath), { recursive: true })
  const partialPath = `${targetPath}.coolcalendar-part`
  rmSync(partialPath, { force: true })
  const handle = openSync(partialPath, 'wx')

  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let incoming = Buffer.alloc(0)
    let written = 0
    let firstFileId = 0
    let settled = false
    let timeout: NodeJS.Timeout

    const resetTimeout = (): void => {
      clearTimeout(timeout)
      timeout = setTimeout(() => finish(new Error('첨부파일 서버 응답 시간이 초과되었습니다.')), 20_000)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      try { closeSync(handle) } catch { /* already closed */ }
      if (error) {
        rmSync(partialPath, { force: true })
        reject(error)
        return
      }
      try {
        if (expectedSize > 0 && written !== expectedSize) throw new Error(`첨부파일 크기가 올바르지 않습니다. (${written}/${expectedSize}바이트)`)
        renameSync(partialPath, targetPath)
        resolve()
      } catch (reason) {
        rmSync(partialPath, { force: true })
        reject(reason)
      }
    }
    const send = (command: number, payload = Buffer.alloc(0)): void => {
      socket.write(encryptedFrame(command, payload))
    }
    const handlePacket = (command: number, payload: Buffer): void => {
      if (command === 1) {
        send(0x200, Buffer.concat([wideString(userId), wideString(userId), wideString('dummyPassword'), int32(2)]))
      } else if (command === 0x200) {
        send(0x209, wideString(sessionId))
      } else if (command === 0x209) {
        send(0x20a)
      } else if (command === 0x20a) {
        if (payload.length >= 4) firstFileId = payload.readUInt32BE(0)
        send(0x20b)
      } else if (command === 0x20c) {
        send(0x20d, Buffer.concat([int32(firstFileId + fileIndex), Buffer.alloc(8)]))
      } else if (command === 0x20d) {
        send(0x20e, Buffer.alloc(12))
      } else if (command === 0x20e) {
        if (payload.length === 0) {
          if (expectedSize === 0 || written === expectedSize) finish()
          else finish(new Error('첨부파일 전송이 예상보다 일찍 끝났습니다.'))
          return
        }
        if (payload.length < 4) throw new Error('첨부파일 조각이 올바르지 않습니다.')
        const length = payload.readUInt32BE(0)
        if (length > payload.length - 4) throw new Error('첨부파일 조각 길이가 올바르지 않습니다.')
        if (written + length > MAX_ATTACHMENT_BYTES || (expectedSize > 0 && written + length > expectedSize)) throw new Error('첨부파일 데이터가 허용된 크기를 초과했습니다.')
        const bytesWritten = writeSync(handle, payload, 4, length)
        if (bytesWritten !== length) throw new Error('첨부파일을 디스크에 모두 기록하지 못했습니다.')
        written += length
        if (expectedSize > 0 && written === expectedSize) finish()
        else send(0x20e, Buffer.alloc(12))
      }
    }

    resetTimeout()
    socket.setNoDelay(true)
    socket.on('data', (chunk) => {
      if (settled) return
      resetTimeout()
      incoming = Buffer.concat([incoming, chunk])
      try {
        while (incoming.length >= 4) {
          const length = incoming.readUInt32BE(0)
          if (length < 16 || length > 32 * 1024 * 1024) throw new Error('첨부파일 서버 패킷이 올바르지 않습니다.')
          if (incoming.length < length + 4) return
          const plain = decryptFrame(incoming.subarray(4, length + 4))
          incoming = incoming.subarray(length + 4)
          if (plain.length < 16) throw new Error('첨부파일 서버 응답이 너무 짧습니다.')
          handlePacket(plain.readInt32BE(0), plain.subarray(16))
          if (settled) return
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => {
      if (!settled) finish(new Error('첨부파일 서버 연결이 종료되었습니다.'))
    })
    socket.connect(port, host)
  })
}

function emptyHistory(): DownloadHistory { return { records: {} } }

function loadHistory(): DownloadHistory {
  try {
    const parsed = JSON.parse(readFileSync(dataPath(HISTORY_FILE), 'utf8')) as DownloadHistory
    return parsed && parsed.records && typeof parsed.records === 'object' ? parsed : emptyHistory()
  } catch {
    return emptyHistory()
  }
}

export class AttachmentAutoSaver {
  private history = loadHistory()

  hasPending(message: Message): boolean {
    return message.attachments.some((attachment, index) => {
      const record = this.history.records[recordKey(message, attachment, index)]
      if (record?.status === 'pending') return true
      return record?.status === 'failed' && Date.now() - Date.parse(record.updatedAt) >= 5 * 60 * 1000
    })
  }

  async saveMessages(messages: Message[], config: AppConfig, userId: string, isEnabled: () => boolean): Promise<AttachmentSaveResult> {
    const result: AttachmentSaveResult = { saved: 0, skipped: 0, failed: 0 }
    mkdirSync(config.attachmentSaveDir, { recursive: true })
    for (const message of messages) {
      if (!isEnabled()) break
      if (message.direction !== 'recv' || !message.fileSessionId) continue
      for (let index = 0; index < message.attachments.length; index += 1) {
        if (!isEnabled()) break
        const attachment = message.attachments[index]
        const key = recordKey(message, attachment, index)
        const previous = this.history.records[key]
        if (previous?.status === 'complete') {
          result.skipped += 1
          continue
        }
        if (
          sameSize(attachment.localPath, attachment.size) &&
          (isInside(attachment.localPath, config.attachmentSaveDir) || isInside(attachment.localPath, RECEIVED_FILES))
        ) {
          this.update(key, message, attachment, index, attachment.localPath, 'complete', '')
          result.skipped += 1
          continue
        }
        const destination = availableDestination(config.attachmentSaveDir, attachment.name, attachment.size)
        if (destination.existing) {
          this.update(key, message, attachment, index, destination.path, 'complete', '')
          result.skipped += 1
          continue
        }
        this.update(key, message, attachment, index, destination.path, 'pending', '')
        try {
          await downloadAttachment(message.fileSessionId, userId, index, attachment.size, destination.path)
          this.update(key, message, attachment, index, destination.path, 'complete', '')
          result.saved += 1
        } catch (error) {
          this.update(key, message, attachment, index, destination.path, 'failed', error instanceof Error ? error.message : String(error))
          result.failed += 1
        }
      }
    }
    return result
  }

  private update(
    key: string,
    message: Message,
    attachment: MessageAttachment,
    attachmentIndex: number,
    destination: string,
    status: DownloadRecord['status'],
    error: string
  ): void {
    this.history.records[key] = {
      messageKey: message.key,
      attachmentIndex,
      sessionId: message.fileSessionId,
      name: attachment.name,
      size: attachment.size,
      destination,
      status,
      updatedAt: new Date().toISOString(),
      error
    }
    const recordEntries = Object.entries(this.history.records)
    if (recordEntries.length > MAX_HISTORY_RECORDS) {
      recordEntries.sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)))
      this.history.records = Object.fromEntries(recordEntries.slice(0, MAX_HISTORY_RECORDS))
    }
    mkdirSync(dataPath(), { recursive: true })
    const destinationPath = dataPath(HISTORY_FILE)
    const tempPath = `${destinationPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempPath, JSON.stringify(this.history, null, 2), 'utf8')
      renameSync(tempPath, destinationPath)
    } finally {
      if (existsSync(tempPath)) rmSync(tempPath, { force: true })
    }
  }
}
