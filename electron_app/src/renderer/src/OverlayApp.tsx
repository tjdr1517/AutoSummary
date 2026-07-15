import { useEffect, useMemo, useState } from 'react'
import type { CalendarEvent } from '../../shared/types'
import { CalendarBoard, EmptyState, EventEditor, Toast, WindowControls } from './components'
import { eventTime, monthStart, occursOn, shiftMonth, shortDate, todayIso } from './date-utils'
import { useAppSnapshot } from './hooks'

export function OverlayApp(): React.JSX.Element {
  const { snapshot } = useAppSnapshot()
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [month, setMonth] = useState(monthStart(todayIso()))
  const [editor, setEditor] = useState<CalendarEvent | null | undefined>(undefined)
  const [toast, setToast] = useState('')
  const events = snapshot?.events ?? []
  const dayEvents = useMemo(() => events.filter((event) => occursOn(event, selectedDate)), [events, selectedDate])

  useEffect(() => {
    if (!snapshot) return
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.style.setProperty('--overlay-font-scale', String(snapshot.config.overlayFontScale / 100))
  }, [snapshot])

  if (!snapshot) return <div className="overlay-loading" />
  const selectDate = (date: string): void => { setSelectedDate(date); setMonth(monthStart(date)) }
  return <div className={`overlay-shell overlay-${snapshot.config.overlayTheme}`}>
    <header className="overlay-titlebar drag-region">
      <div className="brand"><span className="brand-mark">C</span><div><b>CoolCalendar</b><small>바탕화면 캘린더</small></div></div>
      <div className="overlay-actions no-drag"><button onClick={() => void window.coolcalendar.showMain()}>앱 열기</button><button onClick={() => setEditor(null)}>＋ 새 일정</button><WindowControls overlay /></div>
    </header>
    <main className="overlay-content">
      <CalendarBoard month={month} selectedDate={selectedDate} events={events} onSelectDate={selectDate} onEditEvent={(event) => setEditor(event)} onPrev={() => setMonth((value) => shiftMonth(value, -1))} onNext={() => setMonth((value) => shiftMonth(value, 1))} compact />
      <aside className="overlay-agenda">
        <header><span className="eyebrow">TODAY'S FOCUS</span><h2>{shortDate(selectedDate)}</h2><p>{dayEvents.filter((event) => !event.completed).length}개의 남은 일정</p></header>
        <div>{dayEvents.length === 0 ? <EmptyState title="일정이 없습니다" detail="더블 클릭하거나 새 일정 버튼으로 추가하세요." /> : dayEvents.map((event) => <article key={event.filePath} className={event.completed ? 'completed' : ''} onDoubleClick={() => setEditor(event)}>
          <button className="overlay-check" onClick={() => void window.coolcalendar.setCompleted(event.filePath, !event.completed)}>{event.completed ? '✓' : ''}</button><span><small>{eventTime(event)}</small><b>{event.title}</b><p>{event.description.split('\n').find(Boolean) || '메모 없음'}</p></span>
        </article>)}</div>
      </aside>
    </main>
    {editor !== undefined && <EventEditor event={editor || undefined} date={selectedDate} onClose={() => setEditor(undefined)} onSaved={(event) => { setSelectedDate(event.date); setMonth(monthStart(event.date)); setToast('일정을 저장했습니다.') }} />}
    {toast && <Toast message={toast} kind="success" onClose={() => setToast('')} />}
  </div>
}
