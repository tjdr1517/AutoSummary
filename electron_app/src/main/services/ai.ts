import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import OpenAI from 'openai'
import type { CalendarEvent, EventInput, Message, MessageAnalysis } from '../../shared/types'
import { dataPath } from './config'
import { buildEventDescription, messageBaseDate, normalizeText } from './messages'
import { saveEvent } from './events'

const ANALYSIS_SCHEMA = {
  type: 'json_schema' as const,
  name: 'coolmessenger_task_analysis',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      has_action_item: { type: 'boolean' },
      should_create_event: { type: 'boolean' },
      event_title: { type: 'string' },
      due_date: { type: 'string' },
      due_time: { type: 'string' },
      all_day: { type: 'boolean' },
      reason: { type: 'string' }
    },
    required: ['summary', 'has_action_item', 'should_create_event', 'event_title', 'due_date', 'due_time', 'all_day', 'reason'],
    additionalProperties: false
  }
}

interface StoredAnalysis {
  message_key?: number
  messageKey?: number
  summary?: string
  has_action_item?: boolean
  hasActionItem?: boolean
  should_create_event?: boolean
  shouldCreateEvent?: boolean
  event_title?: string
  eventTitle?: string
  due_date?: string
  dueDate?: string
  due_time?: string
  dueTime?: string
  all_day?: boolean
  allDay?: boolean
  reason?: string
  auto_created_event_path?: string
  autoCreatedEventPath?: string
  analyzed_at?: string
  analyzedAt?: string
  model?: string
  error?: string
}

export function analysisStorePath(dbPath: string): string {
  const digest = createHash('sha1').update(resolve(dbPath || 'default')).digest('hex').slice(0, 12)
  return dataPath('ai_analyses', `${digest}.json`)
}

function normalizeStored(item: StoredAnalysis): MessageAnalysis | null {
  const messageKey = Number(item.messageKey ?? item.message_key ?? 0)
  if (!messageKey) return null
  return {
    messageKey,
    summary: String(item.summary || ''),
    hasActionItem: Boolean(item.hasActionItem ?? item.has_action_item),
    shouldCreateEvent: Boolean(item.shouldCreateEvent ?? item.should_create_event),
    eventTitle: String(item.eventTitle ?? item.event_title ?? ''),
    dueDate: String(item.dueDate ?? item.due_date ?? ''),
    dueTime: String(item.dueTime ?? item.due_time ?? ''),
    allDay: Boolean(item.allDay ?? item.all_day ?? true),
    reason: String(item.reason || ''),
    autoCreatedEventPath: String(item.autoCreatedEventPath ?? item.auto_created_event_path ?? ''),
    analyzedAt: String(item.analyzedAt ?? item.analyzed_at ?? ''),
    model: String(item.model || ''),
    error: String(item.error || '')
  }
}

export function loadAnalyses(dbPath: string): Record<number, MessageAnalysis> {
  const path = analysisStorePath(dbPath)
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { analyses?: StoredAnalysis[] }
    return Object.fromEntries((raw.analyses ?? []).map(normalizeStored).filter((item): item is MessageAnalysis => item !== null).map((item) => [item.messageKey, item]))
  } catch {
    return {}
  }
}

export function saveAnalysis(dbPath: string, analysis: MessageAnalysis): void {
  const all = loadAnalyses(dbPath)
  all[analysis.messageKey] = analysis
  const path = analysisStorePath(dbPath)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify({ analyses: Object.values(all).sort((a, b) => a.messageKey - b.messageKey) }, null, 2), 'utf8')
  renameSync(temp, path)
}

function validDate(value: unknown): string {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T12:00:00`)) ? text : ''
}

function validTime(value: unknown): string {
  const text = String(value || '').trim()
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : ''
}

export async function analyzeMessage(message: Message, apiKey: string, model: string): Promise<MessageAnalysis> {
  const key = (apiKey || process.env.OPENAI_API_KEY || '').trim()
  if (!key) throw new Error('OpenAI API 키가 설정되지 않았습니다.')
  const useModel = model.trim() || 'gpt-5.4-mini'
  const client = new OpenAI({ apiKey: key })
  const baseDate = messageBaseDate(message)
  const prompt = [
    `기준 날짜: ${baseDate}`,
    '상대 날짜 표현(오늘/내일/이번 주 등)은 기준 날짜를 기준으로 해석하세요.',
    '제출 마감, 회의, 행사, 검사, 준비 요청처럼 실제 행동이 필요한 경우만 일정으로 추천하세요.',
    '단순 공지나 일반 정보는 일정으로 만들지 마세요.',
    'due_date는 YYYY-MM-DD 또는 빈 문자열, due_time은 HH:MM 또는 빈 문자열로 반환하세요.',
    '',
    `보낸 사람/상대: ${message.peer || '(이름 없음)'}`,
    `원본 시각: ${message.whenText}`,
    `제목: ${message.title}`,
    `첨부: ${message.filePath}`,
    `링크: ${message.linkUrl}`,
    '본문:',
    normalizeText(message.body)
  ].join('\n')

  const response = await client.responses.create({
    model: useModel,
    store: false,
    input: [
      {
        role: 'developer',
        content: '당신은 한국어 메신저 메시지를 캘린더 업무로 정리하는 비서입니다. 내용을 짧게 요약하고 구체적인 날짜가 확실할 때만 일정 생성을 추천하세요.'
      },
      { role: 'user', content: prompt }
    ],
    text: { format: ANALYSIS_SCHEMA }
  })
  const payload = JSON.parse(response.output_text || '{}') as Record<string, unknown>
  const dueDate = validDate(payload.due_date)
  const dueTime = validTime(payload.due_time)
  const allDay = Boolean(payload.all_day) || !dueTime
  return {
    messageKey: message.key,
    summary: String(payload.summary || '').trim(),
    hasActionItem: Boolean(payload.has_action_item),
    shouldCreateEvent: Boolean(payload.should_create_event) && Boolean(dueDate),
    eventTitle: String(payload.event_title || '').trim(),
    dueDate,
    dueTime: allDay ? '' : dueTime,
    allDay,
    reason: String(payload.reason || '').trim(),
    autoCreatedEventPath: '',
    analyzedAt: new Date().toISOString(),
    model: useModel,
    error: ''
  }
}

export function createEventFromAnalysis(eventDir: string, message: Message, analysis: MessageAnalysis): CalendarEvent | null {
  if (!analysis.shouldCreateEvent || !analysis.dueDate) return null
  const input: EventInput = {
    date: analysis.dueDate,
    title: analysis.eventTitle || message.title || message.body.slice(0, 60) || '메시지 일정',
    description: [
      '[AI 자동 정리]',
      `요약: ${analysis.summary || '요약 없음'}`,
      `판단 근거: ${analysis.reason || '메시지에서 일정 또는 마감 맥락을 감지했습니다.'}`,
      '',
      '[원본 메시지]',
      buildEventDescription(message)
    ].join('\n'),
    allDay: analysis.allDay,
    timeText: analysis.allDay ? '' : analysis.dueTime
  }
  return saveEvent(eventDir, input)
}
