import type { CalendarEvent, Message } from '../../shared/types'

export const todayIso = (): string => new Date().toLocaleDateString('sv-SE')

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3])
}

export function isoDate(date: Date): string {
  return date.toLocaleDateString('sv-SE')
}

export function parseIso(value: string): Date {
  return new Date(`${value}T12:00:00`)
}

export function addDays(value: string, amount: number): string {
  const date = parseIso(value)
  date.setDate(date.getDate() + amount)
  return isoDate(date)
}

export function monthStart(value: string): string {
  const date = parseIso(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

export function shiftMonth(value: string, amount: number): string {
  const date = parseIso(value)
  date.setDate(1)
  date.setMonth(date.getMonth() + amount)
  return isoDate(date)
}

export function dateInMonth(month: string, preferredDate: string): string {
  const target = parseIso(monthStart(month))
  const preferredDay = Math.max(1, Number(preferredDate.slice(-2)) || 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(preferredDay, lastDay))
  return isoDate(target)
}

export function monthTitle(value: string): string {
  const date = parseIso(value)
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`
}

export function calendarDays(month: string): string[] {
  const first = parseIso(monthStart(month))
  const sunday = new Date(first)
  sunday.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(sunday)
    day.setDate(sunday.getDate() + index)
    return isoDate(day)
  })
}

export function occursOn(event: CalendarEvent, date: string): boolean {
  if (date < event.date) return false
  if (!event.endDate || event.endDate <= event.date) return date === event.date
  const visibleEnd = event.allDay ? addDays(event.endDate, -1) : event.endDate
  return date <= visibleEnd
}

export function eventTime(event: CalendarEvent): string {
  return event.allDay || event.timeText === '종일' ? '종일' : event.timeText
}

export function guessMessageDate(message: Message): string {
  const source = `${message.title}\n${message.body}`
  const baseMatch = message.whenText.match(/(\d{4})\/(\d{2})\/(\d{2})/)
  const parsedBase = baseMatch ? `${baseMatch[1]}-${baseMatch[2]}-${baseMatch[3]}` : ''
  const base = validIsoDate(parsedBase) ? parsedBase : todayIso()
  const full = source.match(/(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})/)
  if (full) {
    const candidate = `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`
    if (validIsoDate(candidate)) return candidate
  }
  const korean = source.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/)
  if (korean) {
    const baseYear = Number(base.slice(0, 4))
    let candidate = `${baseYear}-${korean[1].padStart(2, '0')}-${korean[2].padStart(2, '0')}`
    if (validIsoDate(candidate)) {
      const diff = (parseIso(candidate).getTime() - parseIso(base).getTime()) / 86_400_000
      if (diff < -180) candidate = `${baseYear + 1}${candidate.slice(4)}`
      if (validIsoDate(candidate)) return candidate
    }
  }
  if (source.includes('모레')) return addDays(base, 2)
  if (source.includes('내일')) return addDays(base, 1)
  return base
}

export function guessMessageTime(message: Message): string {
  const source = `${message.title}\n${message.body}`
  const colon = source.match(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/)
  if (colon && Number(colon[1]) <= 23 && Number(colon[2]) <= 59) return `${colon[1].padStart(2, '0')}:${colon[2]}`
  const korean = source.match(/(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/)
  if (!korean) return ''
  let hour = Number(korean[2])
  const minute = Number(korean[3] || 0)
  if (minute > 59 || (korean[1] ? hour < 1 || hour > 12 : hour > 23)) return ''
  if (korean[1] === '오후' && hour < 12) hour += 12
  if (korean[1] === '오전' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function shortDate(value: string): string {
  const date = parseIso(value)
  return `${date.getMonth() + 1}월 ${date.getDate()}일`
}
