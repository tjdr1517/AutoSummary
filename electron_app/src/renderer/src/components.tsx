import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AppConfig, CalendarEvent, EventInput, Message, TrashedEvent } from '../../shared/types'
import { calendarDays, eventTime, guessMessageDate, guessMessageTime, monthStart, monthTitle, occursOn, shortDate, todayIso } from './date-utils'

export function WindowControls({ overlay = false }: { overlay?: boolean }): React.JSX.Element {
  return <div className="window-controls no-drag">
    <button title="최소화" onClick={() => window.coolcalendar.windowAction('minimize')}>—</button>
    {!overlay && <button title="최대화" onClick={() => window.coolcalendar.windowAction('maximize')}>□</button>}
    <button className="window-close" title="닫기" onClick={() => window.coolcalendar.windowAction('close')}>×</button>
  </div>
}

export function Modal({ title, subtitle, children, onClose, size = 'medium' }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void; size?: 'small' | 'medium' | 'large'
}): React.JSX.Element {
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`modal modal-${size}`} role="dialog" aria-modal="true">
      <header className="modal-head">
        <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>
      </header>
      {children}
    </section>
  </div>
}

export function CalendarBoard({ month, selectedDate, events, onSelectDate, onEditEvent, onPrev, onNext, compact = false, onMessageDrop }: {
  month: string; selectedDate: string; events: CalendarEvent[]; onSelectDate: (date: string) => void
  onEditEvent: (event: CalendarEvent) => void; onPrev: () => void; onNext: () => void; compact?: boolean
  onMessageDrop?: (date: string, messageKey: number) => void
}): React.JSX.Element {
  const days = useMemo(() => calendarDays(month), [month])
  const currentMonth = monthStart(month).slice(0, 7)
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
    <div className="weekday-row">{['일', '월', '화', '수', '목', '금', '토'].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-grid">
      {days.map((date, index) => {
        const dayEvents = events.filter((event) => occursOn(event, date))
        const isOther = date.slice(0, 7) !== currentMonth
        return <button
          key={date}
          className={`day-cell ${isOther ? 'day-other' : ''} ${date === selectedDate ? 'day-selected' : ''} ${date === todayIso() ? 'day-today' : ''}`}
          onClick={() => onSelectDate(date)}
          onDragOver={(event) => { if (onMessageDrop) { event.preventDefault(); event.currentTarget.classList.add('drop-target') } }}
          onDragLeave={(event) => event.currentTarget.classList.remove('drop-target')}
          onDrop={(event) => {
            event.preventDefault()
            event.currentTarget.classList.remove('drop-target')
            const key = Number(event.dataTransfer.getData('application/x-coolcalendar-message'))
            if (key && onMessageDrop) onMessageDrop(date, key)
          }}
        >
          <span className={`day-number ${index % 7 === 0 ? 'sunday' : ''} ${index % 7 === 6 ? 'saturday' : ''}`}>{Number(date.slice(-2))}</span>
          <div className="day-events">
            {dayEvents.slice(0, compact ? 2 : 3).map((event) => <span
              key={event.filePath}
              className={`event-chip ${event.allDay ? 'all-day' : 'timed'} ${event.completed ? 'completed' : ''}`}
              onDoubleClick={(mouseEvent) => { mouseEvent.stopPropagation(); onEditEvent(event) }}
              title={`${eventTime(event)} ${event.title}`}
            >{!compact && <b>{eventTime(event)}</b>} {event.title}</span>)}
            {dayEvents.length > (compact ? 2 : 3) && <span className="more-events">+{dayEvents.length - (compact ? 2 : 3)}</span>}
          </div>
        </button>
      })}
    </div>
  </section>
}

export function EventEditor({ event, date, message, onClose, onSaved }: {
  event?: CalendarEvent; date: string; message?: Message; onClose: () => void; onSaved: (event: CalendarEvent) => void
}): React.JSX.Element {
  const guessedTime = message ? guessMessageTime(message) : ''
  const [form, setForm] = useState<EventInput>({
    filePath: event?.filePath,
    date: event?.date || date || (message ? guessMessageDate(message) : todayIso()),
    title: event?.title || message?.title || '',
    description: event?.description || '',
    allDay: event?.allDay ?? !guessedTime,
    timeText: event?.allDay ? '' : event?.timeText || guessedTime,
    endDate: event?.endDate || '',
    endTimeText: event?.endTimeText || '',
    messageKey: message?.key
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof EventInput>(key: K, value: EventInput[K]): void => setForm((previous) => ({ ...previous, [key]: value }))
  const submit = async (submitEvent: FormEvent): Promise<void> => {
    submitEvent.preventDefault()
    if (!form.title.trim()) { setError('일정 제목을 입력해 주세요.'); return }
    setSaving(true)
    try { onSaved(await window.coolcalendar.saveEvent(form)); onClose() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  return <Modal title={event ? '일정 편집' : '새 일정'} subtitle={message ? `${message.peer}님의 메시지에서 일정을 만듭니다.` : shortDate(form.date)} onClose={onClose}>
    <form className="form-stack" onSubmit={(formEvent) => void submit(formEvent)}>
      <label><span>제목</span><input autoFocus value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="일정 제목" /></label>
      <div className="form-row">
        <label><span>날짜</span><input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} /></label>
        <label className="switch-label"><span>종일</span><button type="button" className={`switch ${form.allDay ? 'on' : ''}`} onClick={() => set('allDay', !form.allDay)}><i /></button></label>
        {!form.allDay && <label><span>시작 시간</span><input type="time" value={form.timeText} onChange={(e) => set('timeText', e.target.value)} required /></label>}
      </div>
      <details className="end-options"><summary>종료 시각 설정</summary><div className="form-row">
        <label><span>종료 날짜</span><input type="date" value={form.endDate || ''} onChange={(e) => set('endDate', e.target.value)} /></label>
        {!form.allDay && <label><span>종료 시간</span><input type="time" value={form.endTimeText || ''} onChange={(e) => set('endTimeText', e.target.value)} /></label>}
      </div></details>
      <label><span>메모</span><textarea rows={8} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder={message ? '비워 두면 원본 메시지가 자동으로 들어갑니다.' : '일정에 필요한 내용을 적어 주세요.'} /></label>
      {error && <p className="form-error">{error}</p>}
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
  const patch = <K extends keyof AppConfig>(key: K, value: AppConfig[K]): void => setDraft((current) => ({ ...current, [key]: value }))
  const selectTheme = (theme: AppConfig['uiTheme']): void => {
    patch('uiTheme', theme)
    document.documentElement.dataset.theme = theme
  }
  useEffect(() => () => {
    if (!themeCommitted.current) document.documentElement.dataset.theme = config.uiTheme
  }, [config.uiTheme])
  const choose = async (kind: 'db' | 'eventDir' | 'credentials', key: 'dbPath' | 'eventDir' | 'googleCredentialsPath'): Promise<void> => {
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
      <nav className="settings-nav">
        {([['appearance', '화면'], ['general', '일반'], ['ai', '메시지 정리'], ['google', 'Google Calendar'], ['overlay', '오버레이']] as const).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      <div className="settings-pane">
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
          <div className="appearance-note"><b>절제된 화면</b><span>중성 색상과 얇은 구분선을 사용해 콘텐츠에 집중하도록 구성했습니다.</span></div>
        </>}
        {tab === 'general' && <>
          <h3>데이터 연결</h3><p className="setting-help">기존 CoolMessenger 데이터와 ICS 일정 폴더를 그대로 사용합니다.</p>
          <PathField label="CoolMessenger UDB" value={draft.dbPath} onChoose={() => void choose('db', 'dbPath')} />
          <PathField label="일정 폴더" value={draft.eventDir} onChoose={() => void choose('eventDir', 'eventDir')} />
          <div className="form-row"><label><span>새로고침 주기(초)</span><input type="number" min={3} max={3600} value={draft.refreshSeconds} onChange={(e) => patch('refreshSeconds', Number(e.target.value))} /></label><label><span>불러올 메시지</span><input type="number" min={20} max={2000} value={draft.recentLimit} onChange={(e) => patch('recentLimit', Number(e.target.value))} /></label></div>
          <ToggleRow label="Windows 시작 시 자동 실행" description="로그인하면 CoolCalendar를 백그라운드에서 시작합니다." value={draft.launchAtLogin} onChange={(value) => patch('launchAtLogin', value)} />
        </>}
        {tab === 'ai' && <>
          <h3>OpenAI 메시지 분석</h3><p className="setting-help">메시지를 요약하고 구체적인 마감이나 회의를 일정으로 제안합니다.</p>
          <label><span>OpenAI API 키</span><input type="password" value={draft.openaiApiKey} onChange={(e) => patch('openaiApiKey', e.target.value)} placeholder="환경 변수 OPENAI_API_KEY도 사용할 수 있습니다." /></label>
          <label><span>모델</span><input value={draft.openaiModel} onChange={(e) => patch('openaiModel', e.target.value)} /></label>
          <ToggleRow label="새 메시지 자동 분석" description="새로 받은 메시지를 백그라운드에서 분석합니다." value={draft.aiAutoEnabled} onChange={(value) => patch('aiAutoEnabled', value)} />
          <ToggleRow label="추천 일정 자동 생성" description="날짜가 명확한 AI 추천을 확인 없이 ICS로 저장합니다." value={draft.aiAutoCreateEvents} onChange={(value) => patch('aiAutoCreateEvents', value)} />
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
          <button className="button secondary align-start" onClick={() => void window.coolcalendar.showOverlay(true)}>오버레이 미리 보기</button>
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
  return <div className="toggle-row"><div><b>{label}</b><span>{description}</span></div><button type="button" className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><i /></button></div>
}

function RangeField({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }): React.JSX.Element {
  return <label><span>{label} · {value}{unit}</span><input className="range" type="range" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} /></label>
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
  useEffect(() => { const timer = setTimeout(onClose, kind === 'error' ? 6000 : 3200); return () => clearTimeout(timer) }, [kind, message, onClose])
  return <div className={`toast toast-${kind}`}><span>{kind === 'success' ? '✓' : kind === 'error' ? '!' : '·'}</span><p>{message}</p><button onClick={onClose}>×</button></div>
}
