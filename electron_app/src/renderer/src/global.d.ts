import type { CoolCalendarApi } from '../../shared/types'

declare global {
  interface Window {
    coolcalendar: CoolCalendarApi
  }
}

export {}
