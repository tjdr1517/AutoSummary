import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AppConfig, CalendarEvent, EventInput, Message, MessageAnalysis, MessengerContact, MessengerDirectory, SendMessageResult, TrashedEvent } from '../../shared/types'
import { calendarDays, eventTime, guessMessageDate, guessMessageTime, monthStart, monthTitle, occursOn, shortDate, todayIso } from './date-utils'

function userErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

type ActiveModal = {
  backdrop: HTMLDivElement
  dialog: HTMLElement
}

type ShellAccessibilityState = {
  inert: boolean
  ariaHidden: string | null
}

const activeModals: ActiveModal[] = []
const isolatedShells = new Map<HTMLElement, ShellAccessibilityState>()

function visibleFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => (
    !element.closest('[inert]')
    && element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ))
}

function focusModalStart(dialog: HTMLElement): void {
  const focusable = visibleFocusableElements(dialog)
  const preferred = focusable.find((element) => element.matches('[autofocus], [data-autofocus]'))
  ;(preferred ?? dialog).focus({ preventScroll: true })
}

function updateModalIsolation(): void {
  const topModal = activeModals.at(-1)

  if (topModal) {
    document.querySelectorAll<HTMLElement>('.app-shell, .overlay-shell').forEach((shell) => {
      if (!isolatedShells.has(shell)) {
        isolatedShells.set(shell, { inert: shell.inert, ariaHidden: shell.getAttribute('aria-hidden') })
      }
      shell.inert = true
      shell.setAttribute('aria-hidden', 'true')
    })
  } else {
    isolatedShells.forEach((state, shell) => {
      shell.inert = state.inert
      if (state.ariaHidden === null) shell.removeAttribute('aria-hidden')
      else shell.setAttribute('aria-hidden', state.ariaHidden)
    })
    isolatedShells.clear()
  }

  activeModals.forEach((modal, index) => {
    const isTop = modal === topModal
    modal.backdrop.inert = !isTop
    modal.backdrop.style.zIndex = String(1000 + index)
    if (isTop) modal.backdrop.removeAttribute('aria-hidden')
    else modal.backdrop.setAttribute('aria-hidden', 'true')
  })
}

export function WindowControls({ overlay = false }: { overlay?: boolean }): React.JSX.Element {
  return <div className="window-controls no-drag">
    <button title="최소화" aria-label="창 최소화" onClick={() => window.coolcalendar.windowAction('minimize')}>—</button>
    {!overlay && <button title="최대화 또는 이전 크기로 복원" aria-label="창 최대화 또는 복원" onClick={() => window.coolcalendar.windowAction('maximize')}>□</button>}
    <button className="window-close" title="닫기" aria-label="창 닫기" onClick={() => window.coolcalendar.windowAction('close')}>×</button>
  </div>
}

export function Modal({ title, subtitle, children, onClose, size = 'medium' }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void; size?: 'small' | 'medium' | 'large'
}): React.JSX.Element {
  const titleId = useId()
  const subtitleId = useId()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
  )
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const backdrop = backdropRef.current
    const dialog = dialogRef.current
    if (!backdrop || !dialog) return

    const entry = { backdrop, dialog }
    activeModals.push(entry)
    focusModalStart(dialog)
    updateModalIsolation()

    const isTopModal = (): boolean => activeModals.at(-1) === entry
    const keydown = (event: KeyboardEvent): void => {
      if (!isTopModal()) return
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = visibleFocusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }

      const first = focusable[0]
      const last = focusable.at(-1)!
      const active = document.activeElement
      if (event.shiftKey && (active === dialog || active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === dialog || active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    const focusin = (event: FocusEvent): void => {
      if (!isTopModal() || !(event.target instanceof Node) || dialog.contains(event.target)) return
      focusModalStart(dialog)
    }

    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin, true)
      const index = activeModals.indexOf(entry)
      const wasTopModal = index === activeModals.length - 1
      if (index >= 0) activeModals.splice(index, 1)
      updateModalIsolation()
      if (!wasTopModal) return
      const restoreTarget = restoreFocusRef.current
      queueMicrotask(() => {
        if (!restoreTarget?.isConnected) return
        const nextTop = activeModals.at(-1)
        if (!nextTop || nextTop.dialog.contains(restoreTarget)) restoreTarget.focus({ preventScroll: true })
      })
    }
  }, [])

  return createPortal(<div ref={backdropRef} className="modal-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && activeModals.at(-1)?.backdrop === event.currentTarget) onCloseRef.current()
  }}>
    <section
      ref={dialogRef}
      className={`modal modal-${size}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subtitle ? subtitleId : undefined}
      tabIndex={-1}
    >
      <header className="modal-head">
        <div><h2 id={titleId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div>
        <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>
      </header>
      {children}
    </section>
  </div>, document.body)
}

export function CalendarBoard({ month, selectedDate, events, onSelectDate, onEditEvent, onPrev, onNext, compact = false, onMessageDrop }: {
  month: string; selectedDate: string; events: CalendarEvent[]; onSelectDate: (date: string) => void
  onEditEvent: (event: CalendarEvent) => void; onPrev: () => void; onNext: () => void; compact?: boolean
  onMessageDrop?: (date: string, messageKey: number) => void
}): React.JSX.Element {
  const days = useMemo(() => calendarDays(month), [month])
  const currentMonth = monthStart(month).slice(0, 7)
  const today = todayIso()
  const defaultFocusDate = selectedDate.slice(0, 7) === currentMonth && days.includes(selectedDate)
    ? selectedDate
    : days.find((date) => date.slice(0, 7) === currentMonth) ?? days[0]
  const [focusedDate, setFocusedDate] = useState(defaultFocusDate)
  const [focusVisibleDate, setFocusVisibleDate] = useState<string | null>(null)
  const dayRefs = useRef(new Map<string, HTMLDivElement>())
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  }), [])
  const rovingDate = days.includes(focusedDate) ? focusedDate : defaultFocusDate

  useEffect(() => { setFocusedDate(defaultFocusDate) }, [defaultFocusDate])

  const moveDayFocus = (currentIndex: number, offset: number): void => {
    const targetIndex = Math.max(0, Math.min(days.length - 1, currentIndex + offset))
    const targetDate = days[targetIndex]
    if (!targetDate || targetDate === days[currentIndex]) return
    setFocusedDate(targetDate)
    requestAnimationFrame(() => dayRefs.current.get(targetDate)?.focus({ preventScroll: true }))
  }

  return <section className={`calendar-board ${compact ? 'calendar-compact' : ''}`}>
    <header className="calendar-head">
      <div>
        <span className="eyebrow">월간 일정</span>
        <h2>{monthTitle(month)}</h2>
      </div>
      <div className="calendar-nav">
        <button onClick={onPrev} aria-label="이전 달">‹</button>
        <button onClick={() => onSelectDate(todayIso())}>오늘</button>
        <button onClick={onNext} aria-label="다음 달">›</button>
      </div>
    </header>
    <div className="weekday-row" aria-hidden="true">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-grid" role="grid" aria-label={`${monthTitle(month)} 달력`} aria-rowcount={6} aria-colcount={7}>
      {Array.from({ length: 6 }, (_, rowIndex) => <div key={`week-${rowIndex}`} role="row" aria-rowindex={rowIndex + 1} style={{ display: 'contents' }}>
        {days.slice(rowIndex * 7, rowIndex * 7 + 7).map((date, columnIndex) => {
          const index = rowIndex * 7 + columnIndex
          const dayEvents = events.filter((event) => occursOn(event, date))
          const isOther = date.slice(0, 7) !== currentMonth
          const visibleEventCount = compact ? 2 : 3
          const dateLabel = `${dateFormatter.format(new Date(`${date}T12:00:00`))}, ${dayEvents.length > 0 ? `일정 ${dayEvents.length}개` : '일정 없음'}`
          return <div
            key={date}
            ref={(element) => {
              if (element) dayRefs.current.set(date, element)
              else dayRefs.current.delete(date)
            }}
            role="gridcell"
            aria-label={dateLabel}
            aria-current={date === today ? 'date' : undefined}
            aria-selected={date === selectedDate}
            aria-colindex={columnIndex + 1}
            tabIndex={date === rovingDate ? 0 : -1}
            className={`day-cell ${isOther ? 'day-other' : ''} ${date === selectedDate ? 'day-selected' : ''} ${date === today ? 'day-today' : ''}`}
            style={focusVisibleDate === date ? { outline: '2px solid var(--accent)', outlineOffset: '-2px' } : undefined}
            onFocus={(event) => {
              if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) setFocusVisibleDate(date)
            }}
            onBlur={(event) => { if (event.target === event.currentTarget) setFocusVisibleDate(null) }}
            onClick={(event) => {
              setFocusedDate(date)
              onSelectDate(date)
              event.currentTarget.focus({ preventScroll: true })
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveDayFocus(index, -1) }
              else if (event.key === 'ArrowRight') { event.preventDefault(); moveDayFocus(index, 1) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); moveDayFocus(index, -7) }
              else if (event.key === 'ArrowDown') { event.preventDefault(); moveDayFocus(index, 7) }
              else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectDate(date) }
            }}
            onDragOver={(event) => { if (onMessageDrop) { event.preventDefault(); event.currentTarget.classList.add('drop-target') } }}
            onDragLeave={(event) => event.currentTarget.classList.remove('drop-target')}
            onDrop={(event) => {
              event.preventDefault()
              event.currentTarget.classList.remove('drop-target')
              const key = Number(event.dataTransfer.getData('application/x-coolcalendar-message'))
              if (key && onMessageDrop) onMessageDrop(date, key)
            }}
          >
            <span className={`day-number ${columnIndex === 0 ? 'sunday' : ''} ${columnIndex === 6 ? 'saturday' : ''}`}>{Number(date.slice(-2))}</span>
            <div className="day-events">
              {dayEvents.slice(0, visibleEventCount).map((calendarEvent) => <button
                type="button"
                key={calendarEvent.filePath}
                className={`event-chip ${calendarEvent.allDay ? 'all-day' : 'timed'} ${calendarEvent.completed ? 'completed' : ''}`}
                tabIndex={date === rovingDate ? 0 : -1}
                aria-label={`${eventTime(calendarEvent)} ${calendarEvent.title} 일정 편집`}
                aria-haspopup="dialog"
                title={`${eventTime(calendarEvent)} ${calendarEvent.title} · 편집`}
                style={{ width: '100%', borderTop: 0, borderRight: 0, borderBottom: 0, outlineOffset: '-2px', textAlign: 'left', font: 'inherit', cursor: 'pointer' }}
                onClick={(mouseEvent) => {
                  mouseEvent.stopPropagation()
                  setFocusedDate(date)
                  onSelectDate(date)
                  onEditEvent(calendarEvent)
                }}
              >{!compact && <b>{eventTime(calendarEvent)}</b>} {calendarEvent.title}</button>)}
              {dayEvents.length > visibleEventCount && <span className="more-events" aria-label={`추가 일정 ${dayEvents.length - visibleEventCount}개`}>+{dayEvents.length - visibleEventCount}</span>}
            </div>
          </div>
        })}
      </div>)}
    </div>
  </section>
}

export function AiEventSuggestionModal({ message, analysis, remaining, onClose, onReview }: {
  message: Message; analysis: MessageAnalysis; remaining: number; onClose: () => void; onReview: () => void
}): React.JSX.Element {
  const proposedTitle = analysis.eventTitle || message.title || '메시지 일정'
  return <Modal
    title="일정 후보를 찾았습니다"
    subtitle={`${message.peer.replace(/;\s*$/, '') || '받은 메시지'}의 날짜와 내용을 저장 전에 확인해 주세요.`}
    onClose={onClose}
    size="small"
  >
    <div className="ai-suggestion-body">
      <div className="ai-suggestion-kicker"><span aria-hidden="true">일정</span><b>일정으로 등록할까요?</b></div>
      <section className="ai-suggestion-card" aria-label="일정 후보">
        <div className="ai-suggestion-date"><b>{shortDate(analysis.dueDate)}</b><span>{analysis.allDay ? '종일' : analysis.dueTime || '시간 미정'}</span></div>
        <div><h3>{proposedTitle}</h3><p>{analysis.summary || message.body || '메시지에서 일정 후보를 찾았습니다.'}</p></div>
      </section>
      {analysis.reason && <details className="ai-suggestion-reason"><summary>정리 기준</summary><p>{analysis.reason}</p></details>}
      <p className="ai-suggestion-note"><b>등록 전 확인</b><span>날짜와 시간을 확인한 뒤 직접 저장합니다. 확인 없이 등록되지는 않습니다.</span></p>
      {remaining > 0 && <p className="ai-suggestion-remaining">확인할 일정 후보가 {remaining}개 더 있습니다.</p>}
      <footer className="modal-actions ai-suggestion-actions"><button type="button" className="button secondary" onClick={onClose}>나중에</button><button type="button" className="button primary" data-autofocus onClick={onReview}>일정 검토</button></footer>
    </div>
  </Modal>
}

function suggestionDescription(message: Message, analysis: MessageAnalysis): string {
  const analysisLines = [
    analysis.summary && `메시지 정리: ${analysis.summary}`,
    analysis.reason && `판단 근거: ${analysis.reason}`
  ].filter(Boolean)
  const sourceLines = [
    `보낸 사람: ${message.peer.replace(/;\s*$/, '') || '알 수 없음'}`,
    message.title && `메시지 제목: ${message.title}`,
    message.body && `원문: ${message.body}`
  ].filter(Boolean)
  return [...analysisLines, ...(analysisLines.length && sourceLines.length ? [''] : []), ...sourceLines].join('\n').trim()
}

export function EventEditor({ event, date, message, suggestion, onClose, onSaved }: {
  event?: CalendarEvent; date?: string; message?: Message; suggestion?: MessageAnalysis; onClose: () => void; onSaved: (event: CalendarEvent) => void
}): React.JSX.Element {
  const guessedTime = suggestion ? (suggestion.allDay ? '' : suggestion.dueTime) : message ? guessMessageTime(message) : ''
  const dateWasGuessed = Boolean(message && !event && !date && !suggestion)
  const errorId = useId()
  const [form, setForm] = useState<EventInput>({
    filePath: event?.filePath,
    date: event?.date || suggestion?.dueDate || date || (message ? guessMessageDate(message) : todayIso()),
    title: event?.title || suggestion?.eventTitle || message?.title || '',
    description: event?.description || (message && suggestion ? suggestionDescription(message, suggestion) : ''),
    allDay: event?.allDay ?? suggestion?.allDay ?? !guessedTime,
    timeText: event ? (event.allDay ? '' : event.timeText) : suggestion?.allDay ? '' : guessedTime,
    endDate: event?.endDate || '',
    endTimeText: event?.endTimeText || '',
    messageKey: event?.sourceMessageKey || message?.key,
    messageDbId: event?.sourceMessageDbId
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof EventInput>(key: K, value: EventInput[K]): void => setForm((previous) => ({ ...previous, [key]: value }))
  const submit = async (submitEvent: FormEvent): Promise<void> => {
    submitEvent.preventDefault()
    if (!form.title.trim()) { setError('일정 제목을 입력해 주세요.'); return }
    if (form.endDate && form.endDate < form.date) { setError('종료 날짜는 시작 날짜보다 빠를 수 없습니다.'); return }
    if (!form.allDay && form.endDate === form.date && form.endTimeText && form.timeText && form.endTimeText <= form.timeText) { setError('종료 시간은 시작 시간보다 늦어야 합니다.'); return }
    setSaving(true)
    try { onSaved(await window.coolcalendar.saveEvent(form)); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return <Modal title={event ? '일정 편집' : suggestion ? '일정 후보 확인' : '새 일정'} subtitle={suggestion ? '날짜와 내용을 확인하고 필요한 부분을 수정해 주세요.' : message ? `${message.peer}님의 메시지에서 일정을 만듭니다.` : shortDate(form.date)} onClose={onClose}>
    <form className="form-stack" onSubmit={(formEvent) => void submit(formEvent)}>
      <label><span>제목</span><input autoFocus data-autofocus required aria-invalid={Boolean(error && !form.title.trim())} aria-describedby={error ? errorId : undefined} value={form.title} onChange={(e) => { set('title', e.target.value); if (error) setError('') }} placeholder="일정 제목" /></label>
      <div className="form-row">
        <label><span>날짜 {dateWasGuessed && <small className="field-hint">메시지에서 추정</small>}</span><input type="date" required value={form.date} onChange={(e) => { set('date', e.target.value); if (error) setError('') }} /></label>
        <label className="switch-label"><span>종일</span><button type="button" role="switch" aria-checked={form.allDay} aria-label="종일 일정" className={`switch ${form.allDay ? 'on' : ''}`} onClick={() => set('allDay', !form.allDay)}><i aria-hidden="true" /></button></label>
        {!form.allDay && <label><span>시작 시간</span><input type="time" value={form.timeText} onChange={(e) => set('timeText', e.target.value)} required /></label>}
      </div>
      <details className="end-options"><summary>종료 시각 설정</summary><div className="form-row">
        <label><span>종료 날짜</span><input type="date" value={form.endDate || ''} onChange={(e) => set('endDate', e.target.value)} /></label>
        {!form.allDay && <label><span>종료 시간</span><input type="time" value={form.endTimeText || ''} onChange={(e) => set('endTimeText', e.target.value)} /></label>}
      </div></details>
      <label><span>메모</span><textarea rows={8} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={message ? '비워 두면 원본 메시지가 자동으로 들어갑니다.' : '일정에 필요한 내용을 적어 주세요.'} /></label>
      {error && <p id={errorId} className="form-error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={saving}>{saving ? '저장 중…' : '저장'}</button></footer>
    </form>
  </Modal>
}

export function SettingsModal({ config, onClose, onSaved, notify }: {
  config: AppConfig; onClose: () => void; onSaved: (config: AppConfig) => void; notify: (message: string, kind?: 'success' | 'error') => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'appearance' | 'general' | 'ai' | 'google' | 'overlay'>('appearance')
  const [draft, setDraft] = useState(config)
  const [saving, setSaving] = useState(false)
  const themeCommitted = useRef(false)
  const settingsPanelId = useId()
  const settingsTabs = [['appearance', '화면'], ['general', '일반'], ['ai', '메시지 정리'], ['google', 'Google Calendar'], ['overlay', '오버레이']] as const
  const patch = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => setDraft((current) => ({ ...current, [key]: value }))
  const selectTheme = (theme: AppConfig['uiTheme']): void => {
    patch('uiTheme', theme)
    document.documentElement.dataset.theme = theme
  }
  useEffect(() => () => {
    if (!themeCommitted.current) document.documentElement.dataset.theme = config.uiTheme
  }, [config.uiTheme])
  const choose = async (kind: 'db' | 'eventDir' | 'attachmentDir' | 'credentials', key: 'dbPath' | 'eventDir' | 'attachmentSaveDir' | 'googleCredentialsPath'): Promise<void> => {
    const path = await window.coolcalendar.choosePath(kind)
    if (path) patch(key, path)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try { const value = await window.coolcalendar.saveConfig(draft); themeCommitted.current = true; document.documentElement.dataset.theme = value.uiTheme; onSaved(value); notify('설정을 저장했습니다.', 'success'); onClose() }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error') }
    finally { setSaving(false) }
  }
  const connect = async (): Promise<void> => {
    try {
      const saved = await window.coolcalendar.saveConfig(draft)
      onSaved(saved)
      await window.coolcalendar.connectGoogle()
      notify('Google Calendar 연결이 완료되었습니다.', 'success')
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error') }
  }
  return <Modal title="설정" subtitle="앱 연결과 자동화를 관리합니다." onClose={onClose} size="large">
    <div className="settings-layout">
      <nav className="settings-nav" role="tablist" aria-label="설정 영역" aria-orientation="vertical">
        {settingsTabs.map(([key, label], index) => <button key={key} id={`${settingsPanelId}-${key}-tab`} role="tab" aria-selected={tab === key} aria-controls={`${settingsPanelId}-panel`} tabIndex={tab === key ? 0 : -1} className={tab === key ? 'active' : ''} onClick={() => setTab(key)} onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + settingsTabs.length) % settingsTabs.length
          const next = settingsTabs[nextIndex][0]
          setTab(next)
          requestAnimationFrame(() => document.getElementById(`${settingsPanelId}-${next}-tab`)?.focus())
        }}>{label}</button>)}
      </nav>
      <div className="settings-pane" id={`${settingsPanelId}-panel`} role="tabpanel" aria-labelledby={`${settingsPanelId}-${tab}-tab`}>
        {tab === 'appearance' && <>
          <h3>화면 테마</h3><p className="setting-help">눈에 편한 밝은 화면을 기본으로 사용합니다. 선택한 테마는 앱을 다시 열어도 유지됩니다.</p>
          <div className="theme-options">
            <button className={draft.uiTheme === 'light' ? 'active' : ''} onClick={() => selectTheme('light')} aria-pressed={draft.uiTheme === 'light'}>
              <span className="theme-preview theme-preview-light"><i /><i /><i /></span><span><b>밝게</b><small>기본</small></span>
            </button>
            <button className={draft.uiTheme === 'dark' ? 'active' : ''} onClick={() => selectTheme('dark')} aria-pressed={draft.uiTheme === 'dark'}>
              <span className="theme-preview theme-preview-dark"><i /><i /><i /></span><span><b>어둡게</b><small>저조도 환경</small></span>
            </button>
          </div>
          <section className="typography-settings">
            <div>
              <h3>글자</h3>
              <p className="setting-help">앱 전체의 글꼴과 글자 크기를 조정합니다. 일정, 메시지, 주소록과 설정 화면에 함께 적용됩니다.</p>
            </div>
            <div className="form-row typography-controls">
              <label><span>글꼴</span><select value={draft.uiFontFamily} onChange={(e) => patch('uiFontFamily', e.target.value as AppConfig['uiFontFamily'])}>
                <option value="coolcalendar">CoolCalendar Sans</option>
                <option value="malgun">맑은 고딕</option>
                <option value="system">Windows 시스템 글꼴</option>
              </select></label>
              <RangeField label="글자 크기" value={draft.uiFontScale} min={90} max={135} unit="%" onChange={(value) => patch('uiFontScale', value)} />
            </div>
            <div className={`font-preview font-preview-${draft.uiFontFamily}`} style={{ fontSize: `${draft.uiFontScale / 100}rem` }}>
              <b>일정과 메시지를 편안하게 읽어보세요</b>
              <span>가나다라마바사 · ABC 123</span>
            </div>
          </section>
          <div className="appearance-note"><b>절제된 화면</b><span>중성 색상과 얇은 구분선을 사용해 콘텐츠에 집중하도록 구성했습니다.</span></div>
        </>}
        {tab === 'general' && <>
          <h3>데이터 연결</h3><p className="setting-help">기존 CoolMessenger 데이터와 ICS 일정 폴더를 그대로 사용합니다.</p>
          <PathField label="CoolMessenger UDB" value={draft.dbPath} onChoose={() => void choose('db', 'dbPath')} />
          <PathField label="일정 폴더" value={draft.eventDir} onChoose={() => void choose('eventDir', 'eventDir')} />
          <div className="settings-section-divider" />
          <h3>첨부파일</h3><p className="setting-help">새로 받은 메시지의 첨부파일을 지정한 폴더에 자동으로 저장합니다.</p>
          <ToggleRow label="첨부파일 자동 저장" description="같은 메시지의 같은 파일은 한 번만 저장하며 기존 파일을 덮어쓰지 않습니다." value={draft.autoSaveAttachments} onChange={(value) => patch('autoSaveAttachments', value)} />
          {draft.autoSaveAttachments && <PathField label="첨부파일 저장 폴더" value={draft.attachmentSaveDir} onChoose={() => void choose('attachmentDir', 'attachmentSaveDir')} />}
          <div className="settings-section-divider" />
          <div className="form-row"><label><span>새로고침 주기(초)</span><input type="number" min={3} max={3600} value={draft.refreshSeconds} onChange={(e) => patch('refreshSeconds', Number(e.target.value))} /></label><label><span>불러올 메시지</span><input type="number" min={20} max={2000} value={draft.recentLimit} onChange={(e) => patch('recentLimit', Number(e.target.value))} /></label></div>
          <ToggleRow label="Windows 시작 시 자동 실행" description="로그인하면 CoolCalendar를 백그라운드에서 시작합니다." value={draft.launchAtLogin} onChange={(value) => patch('launchAtLogin', value)} />
        </>}
        {tab === 'ai' && <>
          <h3>메시지 정리</h3><p className="setting-help">메시지 내용을 짧게 정리하고 날짜가 있는 항목을 일정 후보로 표시합니다.</p>
          <label><span>OpenAI API 키</span><input type="password" value={draft.openaiApiKey} onChange={(e) => patch('openaiApiKey', e.target.value)} placeholder="환경 변수 OPENAI_API_KEY도 사용할 수 있습니다." /></label>
          <label><span>모델</span><input value={draft.openaiModel} onChange={(e) => patch('openaiModel', e.target.value)} /></label>
          <ToggleRow label="새 메시지 자동 정리" description="새로 받은 메시지를 백그라운드에서 정리합니다." value={draft.aiAutoEnabled} onChange={(value) => patch('aiAutoEnabled', value)} />
          <ToggleRow label="일정 후보 알림" description="등록할 수 있는 일정 후보가 있으면 저장 전에 확인 창을 엽니다." value={draft.aiEventSuggestionPopup} onChange={(value) => patch('aiEventSuggestionPopup', value)} />
        </>}
        {tab === 'google' && <>
          <h3>Google Calendar 동기화</h3><p className="setting-help">로컬 ICS와 Google Calendar를 변경된 항목만 동기화합니다.</p>
          <ToggleRow label="Google Calendar 사용" description="일정 생성·수정·삭제 후 자동으로 동기화합니다." value={draft.googleCalendarEnabled} onChange={(value) => patch('googleCalendarEnabled', value)} />
          <label><span>OAuth Client ID</span><input value={draft.googleOauthClientId} onChange={(e) => patch('googleOauthClientId', e.target.value)} /></label>
          <label><span>OAuth Client Secret</span><input type="password" value={draft.googleOauthClientSecret} onChange={(e) => patch('googleOauthClientSecret', e.target.value)} /></label>
          <PathField label="또는 credentials.json" value={draft.googleCredentialsPath} onChoose={() => void choose('credentials', 'googleCredentialsPath')} />
          <div className="form-row"><label><span>캘린더 ID</span><input value={draft.googleCalendarId} onChange={(e) => patch('googleCalendarId', e.target.value)} /></label><label><span>시간대</span><input value={draft.googleTimezone} onChange={(e) => patch('googleTimezone', e.target.value)} /></label></div>
          <button className="button secondary align-start" onClick={() => void connect()}>브라우저에서 Google 연결</button>
        </>}
        {tab === 'overlay' && <>
          <h3>바탕화면 캘린더</h3><p className="setting-help">작업 표시줄 뒤쪽에 유지되는 월간 캘린더의 모양을 조정합니다.</p>
          <label><span>테마</span><select value={draft.overlayTheme} onChange={(e) => patch('overlayTheme', e.target.value as AppConfig['overlayTheme'])}><option value="black">블랙</option><option value="navy">네이비</option><option value="glass">글래스</option></select></label>
          <RangeField label="불투명도" value={draft.overlayOpacity} min={20} max={100} unit="%" onChange={(value) => patch('overlayOpacity', value)} />
          <RangeField label="글자 크기" value={draft.overlayFontScale} min={75} max={150} unit="%" onChange={(value) => patch('overlayFontScale', value)} />
          <button className="button secondary align-start" onClick={() => void window.coolcalendar.showOverlay(true)}>바탕화면에서 미리 보기</button>
        </>}
      </div>
    </div>
    <footer className="modal-actions settings-actions"><button className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? '저장 중…' : '설정 저장'}</button></footer>
  </Modal>
}

function PathField({ label, value, onChoose }: { label: string; value: string; onChoose: () => void }): React.JSX.Element {
  return <label><span>{label}</span><div className="path-field"><input value={value} readOnly /><button type="button" onClick={onChoose}>찾기</button></div></label>
}

function ToggleRow({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void }): React.JSX.Element {
  const labelId = useId()
  const descriptionId = useId()
  return <div className="toggle-row"><div><b id={labelId}>{label}</b><span id={descriptionId}>{description}</span></div><button type="button" role="switch" aria-checked={value} aria-labelledby={labelId} aria-describedby={descriptionId} className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><i aria-hidden="true" /></button></div>
}

function RangeField({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }): React.JSX.Element {
  return <label><span>{label} · {value}{unit}</span><input className="range" type="range" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} /></label>
}

export function DirectoryModal({ directory, onClose, onMessage }: { directory: MessengerDirectory; onClose: () => void; onMessage?: (contactKey: number) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase('ko')
  const contactMap = useMemo(() => new Map(directory.contacts.map((contact) => [contact.key, contact])), [directory.contacts])
  const groups = useMemo(() => directory.groups.map((group) => {
    const groupMatches = Boolean(normalized) && group.name.toLocaleLowerCase('ko').includes(normalized)
    const contacts = group.memberKeys
      .map((key) => contactMap.get(key))
      .filter((contact): contact is NonNullable<typeof contact> => Boolean(contact))
      .filter((contact) => groupMatches || !normalized || `${contact.name} ${contact.displayName} ${contact.role} ${contact.extension}`.toLocaleLowerCase('ko').includes(normalized))
    return { ...group, contacts }
  }).filter((group) => group.contacts.length > 0), [contactMap, directory.groups, normalized])
  const onlineCount = directory.contacts.filter((contact) => contact.status === 'online').length
  const awayCount = directory.contacts.filter((contact) => contact.status === 'away').length

  return <Modal title="주소록" subtitle="쿨메신저 조직도와 현재 접속 상태" onClose={onClose} size="large">
    <div className="directory-shell">
      <div className="directory-toolbar">
        <label className="directory-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름, 부서, 담당 업무, 내선 검색" /></label>
        <div className="directory-connection">
          <span className={`presence-dot ${directory.connected ? 'online' : 'unknown'}`} />
          <b>{directory.connected ? '연결됨' : '연결 중'}</b>
          <span>{directory.contacts.length}명</span>
        </div>
      </div>
      <div className="directory-summary">
        <span><i className="presence-dot online" />온라인 {onlineCount}</span>
        <span><i className="presence-dot away" />자리 비움 {awayCount}</span>
        <span><i className="presence-dot offline" />오프라인 {Math.max(0, directory.contacts.length - onlineCount - awayCount)}</span>
        {directory.syncing && <span className="directory-syncing"><i className="spinner" />주소록 갱신 중</span>}
      </div>
      {directory.error && <div className="directory-alert">{directory.error} 다시 연결을 시도하고 있습니다.</div>}
      <div className="directory-tree">
        {groups.length === 0 && !directory.syncing
          ? <EmptyState title="검색 결과가 없습니다" detail="다른 이름이나 부서명으로 검색해 보세요." />
          : groups.map((group, index) => <details className="directory-group" key={`${group.key}-${group.name}`} open={Boolean(normalized) || index < 2}>
            <summary><span className="directory-chevron">›</span><b>{group.name}</b><small>{group.contacts.length}</small></summary>
            <div className="directory-members">
              {group.contacts.map((contact) => <button type="button" className="directory-contact" key={contact.key} disabled={!onMessage} aria-label={`${contact.name}님에게 쪽지 쓰기`} onClick={() => onMessage?.(contact.key)}>
                <span className={`presence-dot ${contact.status}`} title={presenceLabel(contact.status)} aria-hidden="true" />
                <span className="directory-avatar">{contact.name.slice(0, 1)}</span>
                <span className="directory-person"><b>{contact.name}</b>{contact.role && <small>{contact.role}</small>}{contact.extension && <span className="directory-extension">{contact.extension}</span>}</span>
                {onMessage && <span className="directory-message-action" aria-hidden="true">쪽지</span>}
              </button>)}
            </div>
          </details>)}
      </div>
    </div>
  </Modal>
}

export function ComposeMessageModal({ directory, initialRecipientKey, onClose, onSent }: {
  directory: MessengerDirectory
  initialRecipientKey?: number
  onClose: () => void
  onSent: (result: SendMessageResult) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<number | null>(() => directory.contacts.some((contact) => contact.key === initialRecipientKey) ? initialRecipientKey! : null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [clientSendId] = useState(() => crypto.randomUUID())
  const normalized = query.trim().toLocaleLowerCase('ko')
  const selected = useMemo(() => selectedKey === null
    ? []
    : directory.contacts.filter((contact): contact is MessengerContact => contact.key === selectedKey), [directory.contacts, selectedKey])
  const contacts = useMemo(() => directory.contacts
    .filter((contact) => !normalized || `${contact.name} ${contact.displayName} ${contact.role} ${contact.extension}`.toLocaleLowerCase('ko').includes(normalized))
    .sort((left, right) => {
      const selectedOrder = Number(right.key === selectedKey) - Number(left.key === selectedKey)
      return selectedOrder || left.name.localeCompare(right.name, 'ko')
    }), [directory.contacts, normalized, selectedKey])

  const toggle = (key: number): void => {
    setSelectedKey((current) => current === key ? null : key)
    setError('')
  }

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (sending) return
    if (selectedKey === null) { setError('받는 사람을 선택해 주세요.'); return }
    if (!body.trim()) { setError('메시지 내용을 입력해 주세요.'); return }
    setSending(true)
    setError('')
    try {
      const result = await window.coolcalendar.sendMessage({
        recipientKeys: [selectedKey],
        title: title.trim() || body.trim().split(/\r?\n/, 1)[0].slice(0, 80),
        body: body.trim(),
        clientSendId
      })
      onSent(result)
    } catch (reason) {
      setError(userErrorMessage(reason))
    } finally {
      setSending(false)
    }
  }

  return <Modal title="새 쪽지" subtitle="쿨메신저 주소록에서 받는 사람 한 명을 선택하세요" onClose={sending ? () => undefined : onClose} size="large">
    <form className="compose-layout" onSubmit={(event) => void send(event)}>
      <aside className="compose-recipients">
        <label className="directory-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름이나 부서 검색" /></label>
        <div className="compose-contact-list">
          {contacts.map((contact) => <button type="button" aria-pressed={selectedKey === contact.key} aria-label={`${contact.name}, ${[contact.role, contact.extension].filter(Boolean).join(' · ') || contact.displayName}, ${presenceLabel(contact.status)}`} className={`compose-contact ${selectedKey === contact.key ? 'selected' : ''}`} key={contact.key} onClick={() => toggle(contact.key)}>
            <span className={`presence-dot ${contact.status}`} aria-hidden="true" />
            <span className="compose-check" aria-hidden="true">{selectedKey === contact.key ? '✓' : ''}</span>
            <span><b>{contact.name}</b><small>{[contact.role, contact.extension].filter(Boolean).join(' · ') || contact.displayName}</small></span>
          </button>)}
          {contacts.length === 0 && <p className="compose-no-result">검색 결과가 없습니다.</p>}
        </div>
      </aside>
      <section className="compose-editor">
        <div className="compose-selected">
          <span>받는 사람</span>
          <div>{selected.length === 0 ? <small>왼쪽 주소록에서 한 명을 선택하세요.</small> : selected.map((contact) => <button type="button" key={contact.key} aria-label={`${contact.name} 받는 사람에서 제거`} onClick={() => toggle(contact.key)}>{contact.name}<i aria-hidden="true">×</i></button>)}</div>
        </div>
        <label><span>제목</span><input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="비워 두면 본문의 첫 줄을 사용합니다." /></label>
        <label className="compose-body"><span>내용 <small>{body.length.toLocaleString('ko-KR')} / 20,000자</small></span><textarea value={body} maxLength={20_000} aria-invalid={Boolean(error && !body.trim())} onChange={(event) => { setBody(event.target.value); if (error) setError('') }} placeholder="메시지를 입력하세요." /></label>
        {error && <p className="form-error compose-error">{error}</p>}
      </section>
      <footer className="modal-actions compose-actions">
        <span>{selected.length > 0 ? `${selected[0].name}님에게 보냅니다.` : '현재 한 명에게만 보낼 수 있습니다.'}</span>
        <button type="button" className="button secondary" disabled={sending} onClick={onClose}>취소</button>
        <button type="submit" className="button primary" disabled={sending || selected.length === 0 || !body.trim()}>{sending ? <><i className="spinner" /> 보내는 중…</> : '보내기'}</button>
      </footer>
    </form>
  </Modal>
}

function presenceLabel(status: 'online' | 'away' | 'offline' | 'unknown'): string {
  if (status === 'online') return '온라인'
  if (status === 'away') return '자리 비움'
  if (status === 'offline') return '오프라인'
  return '상태 확인 중'
}

export function TrashModal({ onClose, onChanged, notify }: { onClose: () => void; onChanged: () => void; notify: (message: string, kind?: 'success' | 'error') => void }): React.JSX.Element {
  const [items, setItems] = useState<TrashedEvent[]>([])
  const load = (): void => { void window.coolcalendar.listTrash().then(setItems) }
  useEffect(load, [])
  const restore = async (path: string): Promise<void> => {
    try { await window.coolcalendar.restoreEvent(path); load(); onChanged(); notify('일정을 복원했습니다.', 'success') } catch (error) { notify(String(error), 'error') }
  }
  const remove = async (path: string): Promise<void> => {
    if (!confirm('이 일정은 복구할 수 없습니다. 완전히 삭제할까요?')) return
    try { await window.coolcalendar.deleteForever(path); load(); notify('일정을 완전히 삭제했습니다.', 'success') } catch (error) { notify(String(error), 'error') }
  }
  return <Modal title="휴지통" subtitle={`${items.length}개의 삭제된 일정`} onClose={onClose}>
    <div className="trash-list">{items.length === 0 ? <EmptyState title="휴지통이 비어 있습니다" detail="삭제한 일정은 여기에서 복원할 수 있습니다." /> : items.map(({ event, deletedAt }) => <article className="trash-row" key={event.filePath}>
      <div><b>{event.title}</b><span>{event.date} · {new Date(deletedAt).toLocaleString('ko-KR')}</span></div>
      <div><button className="button secondary small" onClick={() => void restore(event.filePath)}>복원</button><button className="button danger small" onClick={() => void remove(event.filePath)}>완전 삭제</button></div>
    </article>)}</div>
  </Modal>
}

export function EmptyState({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return <div className="empty-state"><span>◇</span><b>{title}</b><p>{detail}</p></div>
}

export function Toast({ message, kind, onClose }: { message: string; kind: 'success' | 'error' | 'info'; onClose: () => void }): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (paused || kind === 'error') return
    const timer = setTimeout(() => onCloseRef.current(), kind === 'success' ? 3600 : 5000)
    return () => clearTimeout(timer)
  }, [kind, message, paused])
  return <div
    className={`toast toast-${kind}`}
    role={kind === 'error' ? 'alert' : 'status'}
    aria-live={kind === 'error' ? 'assertive' : 'polite'}
    aria-atomic="true"
    onMouseEnter={() => setPaused(true)}
    onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false) }}
  ><span aria-hidden="true">{kind === 'success' ? '✓' : kind === 'error' ? '!' : '·'}</span><p>{message}</p><button aria-label="알림 닫기" onClick={onClose}>×</button></div>
}
