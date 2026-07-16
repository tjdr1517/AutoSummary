import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, CalendarEvent, Message, MessageAnalysis } from '../../shared/types'
import { CalendarBoard, DirectoryModal, EmptyState, EventEditor, SettingsModal, Toast, TrashModal, WindowControls } from './components'
import { eventTime, monthStart, occursOn, shiftMonth, shortDate, todayIso } from './date-utils'
import { useAppSnapshot } from './hooks'

type ToastState = { message: string; kind: 'success' | 'error' | 'info' }

export function MainApp(): React.JSX.Element {
  const { snapshot, loading, error, refresh } = useAppSnapshot()
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [month, setMonth] = useState(monthStart(todayIso()))
  const [selectedMessageKey, setSelectedMessageKey] = useState<number | null>(null)
  const [selectedEventPath, setSelectedEventPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<'unread' | 'read'>('unread')
  const [messageFilter, setMessageFilter] = useState<'all' | 'schedule' | 'analyzed' | 'attachment'>('all')
  const [editor, setEditor] = useState<{ event?: CalendarEvent; message?: Message; date?: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [messengerLoggingIn, setMessengerLoggingIn] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const markingRead = useRef(new Set<number>())

  const notify = (message: string, kind: ToastState['kind'] = 'info'): void => setToast({ message, kind })

  useEffect(() => {
    if (snapshot?.messages.length && selectedMessageKey === null) setSelectedMessageKey(snapshot.messages.at(-1)?.key ?? null)
  }, [snapshot?.messages.length, selectedMessageKey])

  useEffect(() => window.coolcalendar.on('sync-status', (payload) => {
    const status = payload as { running?: boolean; message?: string; error?: string }
    setSyncing(Boolean(status.running))
    if (status.error) notify(status.error, 'error')
  }), [])

  useEffect(() => window.coolcalendar.on('overlay-visibility', (payload) => setOverlayVisible(Boolean(payload))), [])

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.config.uiTheme ?? 'light'
    document.documentElement.dataset.font = snapshot?.config.uiFontFamily ?? 'coolcalendar'
    window.coolcalendar.setUiZoom((snapshot?.config.uiFontScale ?? 110) / 100)
  }, [snapshot?.config.uiTheme, snapshot?.config.uiFontFamily, snapshot?.config.uiFontScale])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); void refresh() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); setEditor({}) }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [refresh])

  const messages = useMemo(() => {
    if (!snapshot) return []
    const normalized = query.trim().toLocaleLowerCase('ko')
    return [...snapshot.messages].reverse().filter((message) => {
      const analysis = snapshot.analyses[message.key]
      if (readFilter === 'unread' && (message.direction !== 'recv' || !message.unread)) return false
      if (readFilter === 'read' && (message.direction !== 'recv' || message.unread)) return false
      if (messageFilter === 'schedule' && !analysis?.shouldCreateEvent) return false
      if (messageFilter === 'analyzed' && !analysis) return false
      if (messageFilter === 'attachment' && !message.filePath) return false
      return !normalized || `${message.peer} ${message.title} ${message.body}`.toLocaleLowerCase('ko').includes(normalized)
    })
  }, [snapshot, query, readFilter, messageFilter])

  const selectedMessage = snapshot?.messages.find((message) => message.key === selectedMessageKey)
  const selectedEvent = snapshot?.events.find((event) => event.filePath === selectedEventPath)
  const selectedAnalysis = selectedMessage ? snapshot?.analyses[selectedMessage.key] : undefined
  const dayEvents = snapshot?.events.filter((event) => occursOn(event, selectedDate)) ?? []
  const unreadCount = snapshot?.messages.filter((message) => message.direction === 'recv' && message.unread).length ?? 0
  const readCount = snapshot?.messages.filter((message) => message.direction === 'recv' && !message.unread).length ?? 0

  const selectDate = (date: string): void => {
    setSelectedDate(date)
    setMonth(monthStart(date))
    setSelectedEventPath(null)
  }

  const selectMessage = (message: Message): void => {
    setSelectedMessageKey(message.key)
    setSelectedEventPath(null)
    if (message.direction !== 'recv' || !message.unread || markingRead.current.has(message.key)) return
    markingRead.current.add(message.key)
    void window.coolcalendar.markMessageRead(message.key)
      .catch((reason) => notify(reason instanceof Error ? reason.message : String(reason), 'error'))
      .finally(() => markingRead.current.delete(message.key))
  }

  const analyze = async (createEvent: boolean): Promise<void> => {
    if (!selectedMessage) return
    setAnalyzing(true)
    try {
      const result = await window.coolcalendar.analyzeMessage(selectedMessage.key, createEvent)
      if (result.error) notify(result.error, 'error')
      else if (result.autoCreatedEventPath) notify('AI 추천 일정을 생성했습니다.', 'success')
      else notify('메시지 분석을 완료했습니다.', 'success')
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error') }
    finally { setAnalyzing(false) }
  }

  const sync = async (): Promise<void> => {
    setSyncing(true)
    try {
      const result = await window.coolcalendar.syncGoogle()
      notify(`동기화 완료 · 가져오기 ${result.imported}, 보내기 ${result.pushed}, 삭제 ${result.deleted}`, 'success')
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error') }
    finally { setSyncing(false) }
  }

  const trashEvent = async (event: CalendarEvent): Promise<void> => {
    if (!confirm(`“${event.title}” 일정을 휴지통으로 이동할까요?`)) return
    try { await window.coolcalendar.trashEvent(event.filePath); setSelectedEventPath(null); notify('일정을 휴지통으로 이동했습니다.', 'success') }
    catch (reason) { notify(String(reason), 'error') }
  }

  const setCompleted = async (event: CalendarEvent, completed: boolean): Promise<void> => {
    try { await window.coolcalendar.setCompleted(event.filePath, completed) }
    catch (reason) { notify(String(reason), 'error') }
  }

  const loginCoolMessenger = async (): Promise<void> => {
    setMessengerLoggingIn(true)
    try {
      await window.coolcalendar.loginCoolMessenger()
      notify('쿨메신저에 로그인했습니다.', 'success')
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason), 'error')
    } finally {
      setMessengerLoggingIn(false)
    }
  }

  if (!snapshot) return <div className="startup-screen"><div className="startup-mark">C</div><p>{error || 'CoolCalendar를 준비하고 있습니다…'}</p></div>

  return <div className="app-shell">
    <header className="titlebar drag-region">
      <div className="brand"><span className="brand-mark">C</span><div><b>CoolCalendar</b><small>메시지와 일정</small></div></div>
      <div className="title-status no-drag">
        <span className={`status-dot ${snapshot.directory.connected ? '' : 'warning'}`} />
        <span>{snapshot.directory.connected ? '쿨메신저 로그인됨' : '쿨메신저 로그아웃됨'}</span>
        {!snapshot.directory.connected && <button className="messenger-login-button" disabled={messengerLoggingIn} onClick={() => void loginCoolMessenger()}>
          {messengerLoggingIn ? <><span className="spinner" />로그인 중</> : '로그인하기'}
        </button>}
      </div>
      <div className="title-actions no-drag">
        <button className={`top-action ${overlayVisible ? 'active' : ''}`} onClick={() => void window.coolcalendar.showOverlay(!overlayVisible)}>바탕화면</button>
        <button className={`top-action ${directoryOpen ? 'active' : ''}`} onClick={() => setDirectoryOpen(true)}>주소록</button>
        <button className="top-action" onClick={() => setTrashOpen(true)}>휴지통</button>
        <button className="top-action" onClick={() => setSettingsOpen(true)}>설정</button>
        <WindowControls />
      </div>
    </header>

    <main className="workspace">
      <aside className="message-panel panel">
        <header className="panel-head">
          <div><span className="eyebrow">받은 메시지</span><h1>메시지</h1></div>
          <button className={`icon-button refresh-button ${loading ? 'spinning' : ''}`} onClick={() => void refresh()} title="새로고침">↻</button>
        </header>
        <div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="보낸 사람, 제목, 내용 검색" /><kbd>⌘ F</kbd></div>
        <div className="read-filter" aria-label="읽음 상태 필터">
          <button className={readFilter === 'unread' ? 'active' : ''} onClick={() => setReadFilter('unread')}>안 읽음 <span>{unreadCount}</span></button>
          <button className={readFilter === 'read' ? 'active' : ''} onClick={() => setReadFilter('read')}>읽음 <span>{readCount}</span></button>
        </div>
        <div className="segmented">
          <button className={messageFilter === 'all' ? 'active' : ''} onClick={() => setMessageFilter('all')}>전체</button>
          <button className={messageFilter === 'schedule' ? 'active' : ''} onClick={() => setMessageFilter('schedule')}>일정 제안</button>
          <button className={messageFilter === 'analyzed' ? 'active' : ''} onClick={() => setMessageFilter('analyzed')}>분석됨</button>
          <button className={messageFilter === 'attachment' ? 'active' : ''} onClick={() => setMessageFilter('attachment')}>첨부</button>
        </div>
        {snapshot.dbError && <div className="inline-alert"><b>DB를 읽지 못했습니다</b><span>{snapshot.dbError}</span><button onClick={() => setSettingsOpen(true)}>경로 설정</button></div>}
        <div className="message-list">
          {messages.length === 0 ? <EmptyState title="표시할 메시지가 없습니다" detail="검색어나 필터를 바꿔 보세요." /> : messages.map((message) => {
            const analysis = snapshot.analyses[message.key]
            return <button key={message.key} draggable className={`message-row ${message.unread ? 'unread' : ''} ${message.key === selectedMessageKey && !selectedEvent ? 'selected' : ''}`} onDragStart={(event) => { event.dataTransfer.setData('application/x-coolcalendar-message', String(message.key)); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => selectMessage(message)}>
              <span className="avatar">{(message.peer || '?').slice(0, 1)}</span>
              <span className="message-copy"><span className="message-meta"><b>{message.peer || '알 수 없음'}</b><time>{formatMessageTime(message.whenText)}</time></span><strong>{message.title || '(제목 없음)'}</strong><small>{analysis?.summary || message.body || '내용 없음'}</small><span className="message-badges">{analysis?.hasActionItem && <i>할 일</i>}{analysis?.shouldCreateEvent && <i className="accent">일정 추천</i>}{message.filePath && <i>첨부</i>}</span></span>
            </button>
          })}
        </div>
      </aside>

      <section className="calendar-column">
        <CalendarBoard
          month={month} selectedDate={selectedDate} events={snapshot.events}
          onSelectDate={selectDate}
          onEditEvent={(event) => { setSelectedEventPath(event.filePath); setEditor({ event }) }}
          onPrev={() => setMonth((value) => shiftMonth(value, -1))}
          onNext={() => setMonth((value) => shiftMonth(value, 1))}
          onMessageDrop={(date, messageKey) => {
            const message = snapshot.messages.find((item) => item.key === messageKey)
            if (message) { setSelectedDate(date); setMonth(monthStart(date)); setEditor({ message, date }) }
          }}
        />
        <section className="agenda-strip panel">
          <header><div><span className="eyebrow">선택한 날짜</span><h3>{shortDate(selectedDate)}</h3></div><button className="button secondary small" onClick={() => setEditor({})}>＋ 일정 추가</button></header>
          <div className="agenda-list">{dayEvents.length === 0 ? <p className="agenda-empty">이 날에는 등록된 일정이 없습니다.</p> : dayEvents.map((event) => <button key={event.filePath} className={`agenda-item ${event.completed ? 'completed' : ''}`} onClick={() => { setSelectedEventPath(event.filePath); setSelectedMessageKey(null) }} onDoubleClick={() => setEditor({ event })}>
            <span className={`agenda-time ${event.allDay ? 'all-day' : ''}`}>{eventTime(event)}</span><span><b>{event.title}</b><small>{event.description.split('\n').find(Boolean) || '메모 없음'}</small></span><i>›</i>
          </button>)}</div>
        </section>
      </section>

      <aside className="detail-panel panel">
        {selectedEvent ? <EventDetail event={selectedEvent} onEdit={() => setEditor({ event: selectedEvent })} onTrash={() => void trashEvent(selectedEvent)} onComplete={(done) => void setCompleted(selectedEvent, done)} />
          : selectedMessage ? <MessageDetail message={selectedMessage} analysis={selectedAnalysis} analyzing={analyzing} onAnalyze={() => void analyze(false)} onCreateSuggested={() => void analyze(true)} onSchedule={() => setEditor({ message: selectedMessage })} />
          : <EmptyState title="항목을 선택해 주세요" detail="메시지나 일정을 선택하면 자세한 내용이 여기에 표시됩니다." />}
      </aside>
    </main>

    {editor && <EventEditor event={editor.event} message={editor.message} date={editor.date || selectedDate} onClose={() => setEditor(null)} onSaved={(event) => { setSelectedDate(event.date); setMonth(monthStart(event.date)); setSelectedEventPath(event.filePath); notify('일정을 저장했습니다.', 'success') }} />}
    {directoryOpen && <DirectoryModal directory={snapshot.directory} onClose={() => setDirectoryOpen(false)} />}
    {settingsOpen && <SettingsModal config={snapshot.config} onClose={() => setSettingsOpen(false)} onSaved={(config: AppConfig) => {
      document.documentElement.dataset.theme = config.uiTheme
      document.documentElement.dataset.font = config.uiFontFamily
      window.coolcalendar.setUiZoom(config.uiFontScale / 100)
      void refresh()
    }} notify={notify} />}
    {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={() => void refresh()} notify={notify} />}
    {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    {syncing && <div className="sync-pill"><span className="spinner" /> Google Calendar 동기화 중</div>}
    <button className="sync-fab" disabled={syncing} onClick={() => void sync()} title="Google Calendar 동기화">↥</button>
  </div>
}

function MessageDetail({ message, analysis, analyzing, onAnalyze, onCreateSuggested, onSchedule }: {
  message: Message; analysis?: MessageAnalysis; analyzing: boolean; onAnalyze: () => void; onCreateSuggested: () => void; onSchedule: () => void
}): React.JSX.Element {
  return <div className="detail-content">
    <header className="detail-head"><span className="avatar large">{(message.peer || '?').slice(0, 1)}</span><div><span className="eyebrow">메시지</span><h2>{message.peer || '알 수 없음'}</h2><small>{message.whenText}</small></div></header>
    <section className="detail-section"><label>제목</label><h3>{message.title || '(제목 없음)'}</h3><div className="message-body">{message.body || '내용이 없습니다.'}</div></section>
    {(message.filePath || message.linkUrl) && <section className="attachments"><label>연결된 항목</label>{message.filePath && <button onClick={() => void window.coolcalendar.openExternal(message.filePath)}><span>▣</span><b>{message.filePath.split(/[\\/]/).at(-1)}</b><i>열기</i></button>}{message.linkUrl && <button onClick={() => void window.coolcalendar.openExternal(message.linkUrl)}><span>↗</span><b>메시지 링크</b><i>열기</i></button>}</section>}
    <section className={`ai-card ${analysis?.error ? 'has-error' : ''}`}>
      <header><div><span className="summary-mark">요약</span><b>메시지 정리</b></div>{analysis && <small>{analysis.model}</small>}</header>
      {analysis ? <>{analysis.error ? <p className="form-error">{analysis.error}</p> : <><p>{analysis.summary || '요약 내용이 없습니다.'}</p><div className="analysis-grid"><span><small>할 일</small><b>{analysis.hasActionItem ? '있음' : '없음'}</b></span><span><small>제안 날짜</small><b>{analysis.dueDate || '없음'} {analysis.dueTime}</b></span></div>{analysis.reason && <details><summary>정리 기준</summary><p>{analysis.reason}</p></details>}</>}</> : <p>핵심 내용과 일정 후보를 간단히 정리할 수 있습니다.</p>}
      <button className="button ai-button" disabled={analyzing} onClick={onAnalyze}>{analyzing ? <><span className="spinner" /> 정리 중…</> : analysis ? '다시 정리' : '메시지 정리'}</button>
    </section>
    <footer className="detail-actions"><button className="button primary" onClick={onSchedule}>＋ 일정으로 만들기</button>{analysis?.shouldCreateEvent && !analysis.autoCreatedEventPath && <button className="button secondary" disabled={analyzing} onClick={onCreateSuggested}>AI 추천 일정 생성</button>}</footer>
  </div>
}

function EventDetail({ event, onEdit, onTrash, onComplete }: { event: CalendarEvent; onEdit: () => void; onTrash: () => void; onComplete: (done: boolean) => void }): React.JSX.Element {
  return <div className="detail-content">
    <header className="event-detail-head"><span className={`event-date-badge ${event.completed ? 'done' : ''}`}><b>{Number(event.date.slice(-2))}</b><small>{new Intl.DateTimeFormat('ko-KR', { month: 'short' }).format(new Date(`${event.date}T12:00:00`))}</small></span><div><span className="eyebrow">일정</span><h2>{event.title}</h2><small>{event.date} · {eventTime(event)}</small></div></header>
    <button className={`complete-row ${event.completed ? 'completed' : ''}`} onClick={() => onComplete(!event.completed)}><span>{event.completed ? '✓' : ''}</span><div><b>{event.completed ? '완료된 일정' : '할 일로 표시'}</b></div></button>
    <section className="detail-section"><label>메모</label><div className="message-body event-description">{event.description || '메모가 없습니다.'}</div></section>
    <section className="event-meta"><span><small>시작</small><b>{event.date} {eventTime(event)}</b></span>{event.endDate && <span><small>종료</small><b>{event.endDate} {event.endTimeText}</b></span>}</section>
    <footer className="detail-actions"><button className="button primary" onClick={onEdit}>일정 편집</button><button className="button danger" onClick={onTrash}>휴지통으로 이동</button></footer>
  </div>
}

function formatMessageTime(value: string): string {
  const match = value.match(/(\d{2}:\d{2})/)
  return match?.[1] || value.slice(-8) || ''
}
