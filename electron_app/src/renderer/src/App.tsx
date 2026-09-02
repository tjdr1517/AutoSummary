import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiEventSuggestion, AppConfig, CalendarEvent, Message, MessageAnalysis, MessageAttachment, MessageContentBlock } from '../../shared/types'
import { AiEventSuggestionModal, CalendarBoard, ComposeMessageModal, DirectoryModal, EmptyState, EventEditor, SettingsModal, Toast, TrashModal, WindowControls } from './components'
import { dateInMonth, eventTime, monthStart, occursOn, shiftMonth, shortDate, todayIso } from './date-utils'
import { useAppSnapshot } from './hooks'

type ToastState = { message: string; kind: 'success' | 'error' | 'info' }

function userErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function messagePeerLabel(message: Message): string {
  if (message.direction === 'send' && message.receipts.length > 1) {
    return `${message.receipts[0]?.recipient || '받는 사람'} 외 ${message.receipts.length - 1}명`
  }
  return message.peer.replace(/;\s*$/, '') || '알 수 없음'
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

export function MainApp(): React.JSX.Element {
  const { snapshot, loading, error, refresh } = useAppSnapshot()
  const [selectedDate, setSelectedDate] = useState(todayIso())
  const [month, setMonth] = useState(monthStart(todayIso()))
  const [selectedMessageKey, setSelectedMessageKey] = useState<number | null>(null)
  const [selectedMessageDirection, setSelectedMessageDirection] = useState<Message['direction'] | null>(null)
  const [selectedEventPath, setSelectedEventPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<'unread' | 'read' | 'sent'>('unread')
  const [messageFilter, setMessageFilter] = useState<'all' | 'schedule' | 'analyzed' | 'attachment'>('all')
  const [editor, setEditor] = useState<{ event?: CalendarEvent; message?: Message; suggestion?: MessageAnalysis; date?: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [composeRecipientKey, setComposeRecipientKey] = useState<number | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [messengerLoggingIn, setMessengerLoggingIn] = useState(false)
  const [recallingMessageKey, setRecallingMessageKey] = useState<number | null>(null)
  const [overlayVisible, setOverlayVisible] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [manualSuggestion, setManualSuggestion] = useState<AiEventSuggestion | null>(null)
  const [dismissedQueuedMessageKey, setDismissedQueuedMessageKey] = useState<number | null>(null)
  const markingRead = useRef(new Set<number>())
  const searchInput = useRef<HTMLInputElement>(null)
  const lastNotification = useRef({ message: '', at: 0 })

  const notify = useCallback((message: string, kind: ToastState['kind'] = 'info'): void => {
    const now = Date.now()
    if (lastNotification.current.message === message && now - lastNotification.current.at < 800) return
    lastNotification.current = { message, at: now }
    setToast({ message, kind })
  }, [])

  useEffect(() => {
    if (!snapshot?.messages.length || selectedMessageKey !== null) return
    const initial = snapshot.messages.filter((message) => message.direction === 'recv' && message.unread).at(-1)
    setSelectedMessageKey(initial?.key ?? null)
    setSelectedMessageDirection(initial?.direction ?? null)
  }, [snapshot?.messages.length, selectedMessageKey])

  useEffect(() => window.coolcalendar.on('sync-status', (payload) => {
    const status = payload as { running?: boolean; message?: string; error?: string }
    setSyncing(Boolean(status.running))
    if (status.error) notify(status.error, 'error')
    else if (!status.running && status.message) notify(status.message, 'success')
  }), [notify])

  useEffect(() => window.coolcalendar.on('overlay-visibility', (payload) => setOverlayVisible(Boolean(payload))), [])

  const queuedSuggestion = snapshot?.aiEventSuggestions[0]
  const visibleQueuedSuggestion = queuedSuggestion?.messageKey === dismissedQueuedMessageKey ? undefined : queuedSuggestion
  const activeSuggestion = editor ? undefined : manualSuggestion ?? visibleQueuedSuggestion
  const suggestionMessage = activeSuggestion
    ? snapshot?.messages.find((message) => message.direction === 'recv' && message.key === activeSuggestion.messageKey)
    : undefined

  useEffect(() => {
    if (queuedSuggestion?.messageKey !== dismissedQueuedMessageKey) setDismissedQueuedMessageKey(null)
  }, [queuedSuggestion?.messageKey, dismissedQueuedMessageKey])

  useEffect(() => {
    if (!activeSuggestion || !suggestionMessage) return
    void window.coolcalendar.showMain()
  }, [activeSuggestion?.messageKey, activeSuggestion?.analysis.analyzedAt, suggestionMessage?.key])

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.config.uiTheme ?? 'light'
    document.documentElement.dataset.font = snapshot?.config.uiFontFamily ?? 'coolcalendar'
    window.coolcalendar.setUiZoom((snapshot?.config.uiFontScale ?? 110) / 100)
  }, [snapshot?.config.uiTheme, snapshot?.config.uiFontFamily, snapshot?.config.uiFontScale])

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (document.querySelector('[role="dialog"]')) return
      const command = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (command && key === 'f') {
        event.preventDefault()
        searchInput.current?.focus()
        searchInput.current?.select()
        return
      }
      if (command && key === 'r') { event.preventDefault(); void refresh(); return }
      if (command && event.shiftKey && key === 'n' && snapshot?.directory.connected) {
        event.preventDefault()
        setComposeOpen(true)
        return
      }
      if (command && key === 'n' && !isEditableTarget(event.target)) { event.preventDefault(); setEditor({}); return }
      if (event.key === 'Escape' && detailOpen) {
        setDetailOpen(false)
        setSelectedEventPath(null)
        setSelectedMessageKey(null)
        setSelectedMessageDirection(null)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [detailOpen, refresh, snapshot?.directory.connected])

  const messages = useMemo(() => {
    if (!snapshot) return []
    const normalized = query.trim().toLocaleLowerCase('ko')
    return [...snapshot.messages].reverse().filter((message) => {
      const analysis = message.direction === 'recv' ? snapshot.analyses[message.key] : undefined
      if (readFilter === 'unread' && (message.direction !== 'recv' || !message.unread)) return false
      if (readFilter === 'read' && (message.direction !== 'recv' || message.unread)) return false
      if (readFilter === 'sent' && message.direction !== 'send') return false
      if (messageFilter === 'schedule' && !analysis?.shouldCreateEvent) return false
      if (messageFilter === 'analyzed' && !analysis) return false
      if (messageFilter === 'attachment' && message.attachments.length === 0) return false
      if (!normalized) return true
      const searchable = [
        message.peer,
        message.title,
        message.body,
        ...message.receipts.map((receipt) => receipt.recipient),
        ...message.attachments.map((attachment) => attachment.name)
      ].join(' ').toLocaleLowerCase('ko')
      return searchable.includes(normalized)
    })
  }, [snapshot, query, readFilter, messageFilter])

  const linkedEventsByMessage = useMemo(() => {
    const result = new Map<number, CalendarEvent>()
    if (!snapshot?.config.messageStateDbId) return result
    for (const event of snapshot.events) {
      if (event.sourceMessageKey && event.sourceMessageDbId === snapshot.config.messageStateDbId) {
        result.set(event.sourceMessageKey, event)
      }
    }
    return result
  }, [snapshot])

  const selectedMessage = snapshot?.messages.find((message) => message.key === selectedMessageKey && message.direction === selectedMessageDirection)
  const selectedEvent = snapshot?.events.find((event) => event.filePath === selectedEventPath)
  const selectedAnalysis = selectedMessage?.direction === 'recv' ? snapshot?.analyses[selectedMessage.key] : undefined
  const selectedLinkedEvent = selectedMessage?.direction === 'recv' ? linkedEventsByMessage.get(selectedMessage.key) : undefined
  const selectedEventSourceMessage = selectedEvent?.sourceMessageKey && selectedEvent.sourceMessageDbId === snapshot?.config.messageStateDbId
    ? snapshot.messages.find((message) => message.direction === 'recv' && message.key === selectedEvent.sourceMessageKey)
    : undefined
  const dayEvents = snapshot?.events.filter((event) => occursOn(event, selectedDate)) ?? []
  const unreadCount = snapshot?.messages.filter((message) => message.direction === 'recv' && message.unread).length ?? 0
  const readCount = snapshot?.messages.filter((message) => message.direction === 'recv' && !message.unread).length ?? 0
  const sentCount = snapshot?.messages.filter((message) => message.direction === 'send').length ?? 0
  const selectedMessageVisible = selectedMessage ? messages.some((message) => message.key === selectedMessage.key && message.direction === selectedMessage.direction) : true

  const selectDate = (date: string): void => {
    setSelectedDate(date)
    setMonth(monthStart(date))
    setSelectedEventPath(null)
    setSelectedMessageKey(null)
    setSelectedMessageDirection(null)
    setDetailOpen(false)
  }

  const selectMessage = (message: Message): void => {
    setSelectedMessageKey(message.key)
    setSelectedMessageDirection(message.direction)
    setSelectedEventPath(null)
    setDetailOpen(true)
    if (message.direction !== 'recv' || !message.unread || markingRead.current.has(message.key)) return
    markingRead.current.add(message.key)
    void window.coolcalendar.markMessageRead(message.key)
      .catch((reason) => notify(reason instanceof Error ? reason.message : String(reason), 'error'))
      .finally(() => markingRead.current.delete(message.key))
  }

  const openEvent = (event: CalendarEvent): void => {
    setSelectedDate(event.date)
    setMonth(monthStart(event.date))
    setSelectedEventPath(event.filePath)
    setSelectedMessageKey(null)
    setSelectedMessageDirection(null)
    setDetailOpen(true)
  }

  const openSourceMessage = (message: Message): void => {
    setQuery('')
    setMessageFilter('all')
    setReadFilter('read')
    selectMessage(message)
  }

  const analyze = async (): Promise<void> => {
    if (!selectedMessage) return
    setAnalyzing(true)
    try {
      const result = await window.coolcalendar.analyzeMessage(selectedMessage.key)
      if (result.error) notify(result.error, 'error')
      else {
        notify('메시지를 정리했습니다.', 'success')
        if (snapshot?.config.aiEventSuggestionPopup && result.shouldCreateEvent && result.dueDate) {
          setManualSuggestion({ messageKey: selectedMessage.key, analysis: result })
        }
      }
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error') }
    finally { setAnalyzing(false) }
  }

  const dismissSuggestion = (suggestion: AiEventSuggestion): void => {
    const queuedMatch = snapshot?.aiEventSuggestions.some((item) => item.messageKey === suggestion.messageKey) ?? false
    if (manualSuggestion?.messageKey === suggestion.messageKey && manualSuggestion.analysis.analyzedAt === suggestion.analysis.analyzedAt) {
      setManualSuggestion(null)
      if (!queuedMatch) return
    }
    setDismissedQueuedMessageKey(suggestion.messageKey)
    void window.coolcalendar.dismissAiEventSuggestion(suggestion.messageKey)
      .catch((reason) => notify(userErrorMessage(reason), 'error'))
  }

  const reviewSuggestion = (suggestion: AiEventSuggestion, message: Message): void => {
    dismissSuggestion(suggestion)
    setSelectedMessageKey(message.key)
    setSelectedMessageDirection('recv')
    setSelectedEventPath(null)
    setEditor({ message, suggestion: suggestion.analysis })
  }

  const recallMessage = async (message: Message): Promise<void> => {
    if (message.direction !== 'send' || message.recalled || message.receipts.some((receipt) => receipt.received) || recallingMessageKey !== null) return
    if (!confirm(`'${message.title || '(제목 없음)'}' 쪽지를 회수할까요?\n받는 사람의 쿨메신저에서도 본문이 회수 처리됩니다.`)) return
    setRecallingMessageKey(message.key)
    try {
      const result = await window.coolcalendar.recallMessage({
        messageKey: message.key,
        clientRecallId: crypto.randomUUID()
      })
      notify(result.alreadyRecalled ? '이미 회수를 요청한 쪽지입니다.' : '쪽지 회수를 요청했습니다.', 'success')
      await refresh()
    } catch (reason) {
      notify(userErrorMessage(reason), 'error')
    } finally {
      setRecallingMessageKey(null)
    }
  }

  const sync = async (): Promise<void> => {
    setSyncing(true)
    try {
      await window.coolcalendar.syncGoogle()
    } catch (reason) { notify(userErrorMessage(reason), 'error') }
    finally { setSyncing(false) }
  }

  const moveMonth = (amount: number): void => {
    setMonth((current) => {
      const next = shiftMonth(current, amount)
      setSelectedDate((date) => dateInMonth(next, date))
      return next
    })
    setSelectedEventPath(null)
    setSelectedMessageKey(null)
    setSelectedMessageDirection(null)
    setDetailOpen(false)
  }

  const resetMessageFilters = (): void => {
    setQuery('')
    setMessageFilter('all')
    setReadFilter('unread')
  }

  const revealSelectedMessage = (): void => {
    if (!selectedMessage) return
    setQuery('')
    setMessageFilter('all')
    setReadFilter(selectedMessage.direction === 'send' ? 'sent' : selectedMessage.unread ? 'unread' : 'read')
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

  if (!snapshot) return <div className="startup-screen" role={error ? 'alert' : 'status'} aria-live="polite"><div className="startup-mark">C</div><p>{error ? userErrorMessage(error) : 'CoolCalendar를 준비하고 있습니다…'}</p>{error && <button className="button secondary" disabled={loading} onClick={() => void refresh()}>{loading ? '다시 연결 중…' : '다시 시도'}</button>}</div>

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
        <button className={`top-action compose-top-action ${composeOpen ? 'active' : ''}`} disabled={!snapshot.directory.connected} onClick={() => { setComposeRecipientKey(null); setComposeOpen(true) }}>새 쪽지</button>
        <button className="top-action sync-top-action" disabled={syncing} aria-busy={syncing} onClick={() => void sync()}>{syncing ? <><span className="spinner" /> 동기화 중</> : '동기화'}</button>
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
          <div><span className="eyebrow">{readFilter === 'sent' ? '보낸 메시지' : '받은 메시지'}</span><h1>메시지</h1></div>
          <button className="icon-button refresh-button" disabled={loading} aria-busy={loading} onClick={() => void refresh()} title="새로고침"><span className={loading ? 'spinning' : ''} aria-hidden="true">↻</span></button>
        </header>
        <label className="search-box" htmlFor="message-search"><span aria-hidden="true">⌕</span><input ref={searchInput} id="message-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사람, 제목, 내용, 첨부 검색" /><kbd aria-label="단축키 Control F">Ctrl F</kbd></label>
        <div className="read-filter" aria-label="읽음 상태 필터">
          <button aria-pressed={readFilter === 'unread'} className={readFilter === 'unread' ? 'active' : ''} onClick={() => setReadFilter('unread')}>안 읽음 <span>{unreadCount}</span></button>
          <button aria-pressed={readFilter === 'read'} className={readFilter === 'read' ? 'active' : ''} onClick={() => setReadFilter('read')}>읽음 <span>{readCount}</span></button>
          <button aria-pressed={readFilter === 'sent'} className={readFilter === 'sent' ? 'active' : ''} onClick={() => { setReadFilter('sent'); if (messageFilter === 'schedule' || messageFilter === 'analyzed') setMessageFilter('all') }}>보낸 쪽지 <span>{sentCount}</span></button>
        </div>
        <div className="segmented" aria-label="메시지 종류 필터">
          <button aria-pressed={messageFilter === 'all'} className={messageFilter === 'all' ? 'active' : ''} onClick={() => setMessageFilter('all')}>전체</button>
          <button aria-pressed={messageFilter === 'schedule'} disabled={readFilter === 'sent'} className={messageFilter === 'schedule' ? 'active' : ''} onClick={() => setMessageFilter('schedule')}>일정 후보</button>
          <button aria-pressed={messageFilter === 'analyzed'} disabled={readFilter === 'sent'} className={messageFilter === 'analyzed' ? 'active' : ''} onClick={() => setMessageFilter('analyzed')}>정리됨</button>
          <button aria-pressed={messageFilter === 'attachment'} className={messageFilter === 'attachment' ? 'active' : ''} onClick={() => setMessageFilter('attachment')}>첨부</button>
        </div>
        {snapshot.dbError && <div className="inline-alert"><b>DB를 읽지 못했습니다</b><span>{snapshot.dbError}</span><button onClick={() => setSettingsOpen(true)}>경로 설정</button></div>}
        {error && <div className="inline-alert error-alert" role="alert"><b>새로고침하지 못했습니다</b><span>{userErrorMessage(error)}</span><button onClick={() => void refresh()}>다시 시도</button></div>}
        <div className="message-list-meta"><span aria-live="polite">{messages.length}개 표시</span>{(query || messageFilter !== 'all') && <button onClick={resetMessageFilters}>필터 초기화</button>}</div>
        <div className="message-list">
          {messages.length === 0 ? <div className="message-empty"><EmptyState title="표시할 메시지가 없습니다" detail="검색어나 필터를 바꿔 보세요." />{(query || messageFilter !== 'all') && <button className="button secondary small" onClick={resetMessageFilters}>모든 메시지 보기</button>}</div> : messages.map((message) => {
            const analysis = message.direction === 'recv' ? snapshot.analyses[message.key] : undefined
            const linkedEvent = message.direction === 'recv' ? linkedEventsByMessage.get(message.key) : undefined
            return <button key={`${message.direction}-${message.key}`} draggable={message.direction === 'recv'} className={`message-row ${message.unread ? 'unread' : ''} ${message.key === selectedMessageKey && message.direction === selectedMessageDirection && !selectedEvent ? 'selected' : ''}`} onDragStart={(event) => { event.dataTransfer.setData('application/x-coolcalendar-message', String(message.key)); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => selectMessage(message)}>
              <span className="avatar">{message.direction === 'send' ? '→' : (message.peer || '?').slice(0, 1)}</span>
              <span className="message-copy"><span className="message-meta"><b>{messagePeerLabel(message)}</b><time>{formatMessageTime(message.whenText)}</time></span><strong>{message.title || '(제목 없음)'}</strong><small>{analysis?.summary || message.body || '내용 없음'}</small><span className="message-badges">{analysis?.hasActionItem && <i>할 일</i>}{linkedEvent ? <i className="accent">일정 등록됨</i> : analysis?.shouldCreateEvent && <i className="accent">일정 후보</i>}{message.attachments.length > 0 && <i>첨부 {message.attachments.length}</i>}</span></span>
              {message.direction === 'send' && <span className={`message-direction-badge ${message.recalled ? 'recalled' : ''}`}>{message.recalled ? '회수됨' : `수신 ${message.receipts.filter((receipt) => receipt.received).length}/${message.receipts.length}`}</span>}
            </button>
          })}
        </div>
      </aside>

      <section className="calendar-column">
        {snapshot.eventError && <div className="calendar-inline-alert inline-alert error-alert" role="alert"><b>일정 폴더를 읽지 못했습니다</b><span>{snapshot.eventError}</span><button onClick={() => setSettingsOpen(true)}>경로 설정</button></div>}
        <CalendarBoard
          month={month} selectedDate={selectedDate} events={snapshot.events}
          onSelectDate={selectDate}
          onEditEvent={(event) => { setSelectedEventPath(event.filePath); setEditor({ event }) }}
          onPrev={() => moveMonth(-1)}
          onNext={() => moveMonth(1)}
          onMessageDrop={(date, messageKey) => {
            const message = snapshot.messages.find((item) => item.key === messageKey && item.direction === 'recv')
            if (message) { setSelectedDate(date); setMonth(monthStart(date)); setEditor({ message, date }) }
          }}
        />
        <section className="agenda-strip panel">
          <header><div><span className="eyebrow">선택한 날짜</span><h3>{shortDate(selectedDate)}</h3></div><button className="button secondary small" onClick={() => setEditor({})}>＋ 일정 추가</button></header>
          <div className="agenda-list">{dayEvents.length === 0 ? <p className="agenda-empty">이 날에는 등록된 일정이 없습니다.</p> : dayEvents.map((event) => <button key={event.filePath} className={`agenda-item ${event.completed ? 'completed' : ''}`} onClick={() => { setSelectedEventPath(event.filePath); setSelectedMessageKey(null); setSelectedMessageDirection(null); setDetailOpen(true) }} onDoubleClick={() => setEditor({ event })}>
            <span className={`agenda-time ${event.allDay ? 'all-day' : ''}`}>{eventTime(event)}</span><span><b>{event.title}</b><small>{event.description.split('\n').find(Boolean) || '메모 없음'}</small></span><i>›</i>
          </button>)}</div>
        </section>
      </section>

      <button className={`detail-scrim ${detailOpen ? 'visible' : ''}`} aria-label="상세 패널 닫기" onClick={() => setDetailOpen(false)} />
      <aside className={`detail-panel panel ${detailOpen ? 'detail-open' : ''}`} aria-label="선택한 항목 상세">
        <button className="detail-close icon-button" aria-label="상세 패널 닫기" onClick={() => { setDetailOpen(false); setSelectedEventPath(null); setSelectedMessageKey(null); setSelectedMessageDirection(null) }}>×</button>
        {selectedMessage && !selectedMessageVisible && <button className="detail-context-note" onClick={revealSelectedMessage}>현재 필터에 없는 메시지입니다. 목록에서 보기</button>}
        {selectedEvent ? <EventDetail event={selectedEvent} sourceMessage={selectedEventSourceMessage} onOpenSource={() => selectedEventSourceMessage && openSourceMessage(selectedEventSourceMessage)} onEdit={() => setEditor({ event: selectedEvent })} onTrash={() => void trashEvent(selectedEvent)} onComplete={(done) => void setCompleted(selectedEvent, done)} />
          : selectedMessage ? <MessageDetail message={selectedMessage} analysis={selectedAnalysis} linkedEvent={selectedLinkedEvent} analyzing={analyzing} recalling={recallingMessageKey === selectedMessage.key} onRecall={() => void recallMessage(selectedMessage)} onAnalyze={() => void analyze()} onReviewSuggested={() => selectedAnalysis && setManualSuggestion({ messageKey: selectedMessage.key, analysis: selectedAnalysis })} onOpenLinkedEvent={() => selectedLinkedEvent && openEvent(selectedLinkedEvent)} onSchedule={() => setEditor({ message: selectedMessage })} />
          : <EmptyState title="항목을 선택해 주세요" detail="메시지나 일정을 선택하면 자세한 내용이 여기에 표시됩니다." />}
      </aside>
    </main>

    {editor && <EventEditor event={editor.event} message={editor.message} suggestion={editor.suggestion} date={editor.date || (editor.message ? undefined : selectedDate)} onClose={() => setEditor(null)} onSaved={(event) => { setSelectedDate(event.date); setMonth(monthStart(event.date)); setSelectedEventPath(event.filePath); setSelectedMessageKey(null); setSelectedMessageDirection(null); setDetailOpen(true); notify('일정을 저장했습니다.', 'success') }} />}
    {activeSuggestion && suggestionMessage && <AiEventSuggestionModal
      message={suggestionMessage}
      analysis={activeSuggestion.analysis}
      remaining={Math.max(0, (snapshot?.aiEventSuggestions.length ?? 0) - (manualSuggestion ? 0 : visibleQueuedSuggestion ? 1 : 0))}
      onClose={() => dismissSuggestion(activeSuggestion)}
      onReview={() => reviewSuggestion(activeSuggestion, suggestionMessage)}
    />}
    {composeOpen && <ComposeMessageModal directory={snapshot.directory} initialRecipientKey={composeRecipientKey ?? undefined} onClose={() => { setComposeOpen(false); setComposeRecipientKey(null) }} onSent={(result) => {
      setComposeOpen(false)
      setComposeRecipientKey(null)
      notify(result.recipientCount > 1 ? `${result.recipientCount}명에게 쪽지를 보냈습니다.` : '쪽지를 보냈습니다.', 'success')
      setTimeout(() => void refresh(), 500)
    }} />}
    {directoryOpen && <DirectoryModal directory={snapshot.directory} onClose={() => setDirectoryOpen(false)} onMessage={(contactKey) => { setDirectoryOpen(false); setComposeRecipientKey(contactKey); setComposeOpen(true) }} />}
    {settingsOpen && <SettingsModal config={snapshot.config} onClose={() => setSettingsOpen(false)} onSaved={(config: AppConfig) => {
      document.documentElement.dataset.theme = config.uiTheme
      document.documentElement.dataset.font = config.uiFontFamily
      window.coolcalendar.setUiZoom(config.uiFontScale / 100)
      void refresh()
    }} notify={notify} />}
    {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onChanged={() => void refresh()} notify={notify} />}
    {toast && <Toast {...toast} onClose={() => setToast(null)} />}
  </div>
}

function MessageDetail({ message, analysis, linkedEvent, analyzing, recalling, onRecall, onAnalyze, onReviewSuggested, onOpenLinkedEvent, onSchedule }: {
  message: Message; analysis?: MessageAnalysis; linkedEvent?: CalendarEvent; analyzing: boolean; recalling: boolean; onRecall: () => void; onAnalyze: () => void; onReviewSuggested: () => void; onOpenLinkedEvent: () => void; onSchedule: () => void
}): React.JSX.Element {
  const hasReceivedRecipient = message.receipts.some((receipt) => receipt.received)
  return <div className="detail-content">
    <header className="detail-head"><span className="avatar large">{messagePeerLabel(message).slice(0, 1)}</span><div><span className="eyebrow">메시지</span><h2>{messagePeerLabel(message)}</h2><small>{message.whenText}</small></div></header>
    <section className="detail-section"><label>제목</label><h3>{message.title || '(제목 없음)'}</h3><MessageRichBody message={message} /></section>
    {(message.attachments.length > 0 || message.linkUrl) && <MessageAttachments attachments={message.attachments} linkUrl={message.linkUrl} />}
    {message.direction === 'recv' && <section className={`ai-card ${analysis?.error ? 'has-error' : ''}`}>
      <header><div><span className="summary-mark">요약</span><b>메시지 정리</b></div>{analysis && <small>{analysis.model}</small>}</header>
      {analysis ? <>{analysis.error ? <p className="form-error">{analysis.error}</p> : <><p>{analysis.summary || '요약 내용이 없습니다.'}</p><div className="analysis-grid"><span><small>할 일</small><b>{analysis.hasActionItem ? '있음' : '없음'}</b></span><span><small>날짜 후보</small><b>{analysis.dueDate || '없음'} {analysis.dueTime}</b></span></div>{analysis.reason && <details><summary>정리 기준</summary><p>{analysis.reason}</p></details>}</>}</> : <p>핵심 내용과 일정 후보를 간단히 정리할 수 있습니다.</p>}
      <button className="button ai-button" disabled={analyzing} onClick={onAnalyze}>{analyzing ? <><span className="spinner" /> 정리 중…</> : analysis ? '다시 정리' : '메시지 정리'}</button>
    </section>}
    {message.direction === 'send' && <MessageReceiptCard message={message} />}
    <footer className="detail-actions">{message.direction === 'recv' ? <>{linkedEvent ? <button className="button primary" onClick={onOpenLinkedEvent}>등록된 일정 보기</button> : <><button className="button primary" onClick={onSchedule}>＋ 일정으로 만들기</button>{analysis?.shouldCreateEvent && !analysis.autoCreatedEventPath && <button className="button secondary" disabled={analyzing} onClick={onReviewSuggested}>일정 후보 확인</button>}</>}</> : <button className="button recall-button" disabled={recalling || message.recalled || hasReceivedRecipient} title={hasReceivedRecipient ? '받는 사람이 쪽지를 수신하여 회수할 수 없습니다.' : undefined} onClick={onRecall}>{message.recalled ? '회수됨' : hasReceivedRecipient ? '수신 완료 · 회수 불가' : recalling ? '회수 중…' : '쪽지 회수'}</button>}</footer>
  </div>
}

function MessageReceiptCard({ message }: { message: Message }): React.JSX.Element {
  const receivedCount = message.receipts.filter((receipt) => receipt.received).length
  return <section className={`sent-message-card receipt-card ${message.recalled ? 'recalled' : ''}`}>
    <header><div><b>{message.recalled ? '회수된 쪽지' : '수신 확인'}</b><span>{message.recalled ? '쿨메신저에 쪽지 회수 요청을 전송했습니다.' : `${receivedCount}명 수신 · ${message.receipts.length - receivedCount}명 미수신`}</span></div><strong>{receivedCount}/{message.receipts.length}</strong></header>
    {message.receipts.length > 0 ? <div className="receipt-table">
      <div className="receipt-table-head"><span>받는 사람</span><span>수신 날짜</span></div>
      {message.receipts.map((receipt) => <div className={`receipt-row ${receipt.received ? 'received' : ''}`} key={receipt.memberKey}>
        <span className="receipt-person" title={receipt.recipient}><i aria-label={receipt.received ? '수신함' : '미수신'}>{receipt.received ? '✓' : ''}</i><b>{receipt.recipient}</b></span>
        <time title={receipt.receivedAt}>{receipt.receivedAt ? receipt.receivedAt.replace(/\s*\([A-Za-z]{3}\)\s*$/, '') : '미수신'}</time>
      </div>)}
    </div> : <p className="receipt-empty">수신자 정보를 확인할 수 없습니다.</p>}
  </section>
}

function MessageRichBody({ message }: { message: Message }): React.JSX.Element {
  const [blocks, setBlocks] = useState<MessageContentBlock[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let active = true
    setBlocks([])
    setLoaded(false)
    if (message.direction === 'send') {
      setBlocks(message.body ? [{ type: 'text', content: message.body }] : [])
      setLoaded(true)
      return () => { active = false }
    }
    void window.coolcalendar.getMessageContent(message.key).then((values) => {
      if (active) { setBlocks(values); setLoaded(true) }
    }).catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [message.key, message.direction, message.body])
  if (!loaded || blocks.length === 0) return <div className="message-body">{message.body || '내용이 없습니다.'}</div>
  return <div className="message-body message-rich-body">
    {blocks.map((block, index) => block.type === 'image'
      ? <img key={`${message.key}-image-${index}`} src={block.content} alt="메시지 본문 이미지" />
      : <span key={`${message.key}-text-${index}`}>{block.content}</span>)}
  </div>
}

function MessageAttachments({ attachments, linkUrl }: { attachments: MessageAttachment[]; linkUrl: string }): React.JSX.Element {
  return <section className="attachments message-attachments">
    <label>첨부파일</label>
    <div className="attachment-gallery">
      {attachments.map((attachment, index) => <button className="attachment-file" key={`${attachment.name}-${index}`} disabled={!attachment.localPath} onClick={() => attachment.localPath && void window.coolcalendar.openExternal(attachment.localPath)}>
          <span>{attachment.kind === 'image' ? '사진' : '파일'}</span>
          <b>{attachment.name}</b>
          <i>{attachment.localPath ? `${formatFileSize(attachment.size)} · 열기` : '쿨메신저에서 받은 뒤 열 수 있음'}</i>
        </button>)}
    </div>
    {linkUrl && <button className="attachment-file" onClick={() => void window.coolcalendar.openExternal(linkUrl)}><span>링크</span><b>메시지 링크</b><i>열기</i></button>}
  </section>
}

function formatFileSize(bytes: number): string {
  if (!bytes) return '크기 정보 없음'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function EventDetail({ event, sourceMessage, onOpenSource, onEdit, onTrash, onComplete }: { event: CalendarEvent; sourceMessage?: Message; onOpenSource: () => void; onEdit: () => void; onTrash: () => void; onComplete: (done: boolean) => void }): React.JSX.Element {
  return <div className="detail-content">
    <header className="event-detail-head"><span className={`event-date-badge ${event.completed ? 'done' : ''}`}><b>{Number(event.date.slice(-2))}</b><small>{new Intl.DateTimeFormat('ko-KR', { month: 'short' }).format(new Date(`${event.date}T12:00:00`))}</small></span><div><span className="eyebrow">일정</span><h2>{event.title}</h2><small>{event.date} · {eventTime(event)}</small></div></header>
    <button className={`complete-row ${event.completed ? 'completed' : ''}`} onClick={() => onComplete(!event.completed)}><span>{event.completed ? '✓' : ''}</span><div><b>{event.completed ? '완료된 일정' : '할 일로 표시'}</b></div></button>
    {event.sourceMessageKey && <section className="event-source-card"><div><small>원본 메시지</small><b>{sourceMessage ? messagePeerLabel(sourceMessage) : '현재 목록에 없음'}</b><span>{sourceMessage ? sourceMessage.title || '(제목 없음)' : '불러올 메시지 수를 늘리면 다시 찾을 수 있습니다.'}</span></div>{sourceMessage && <button className="button secondary small" onClick={onOpenSource}>메시지 보기</button>}</section>}
    <section className="detail-section"><label>메모</label><div className="message-body event-description">{event.description || '메모가 없습니다.'}</div></section>
    <section className="event-meta"><span><small>시작</small><b>{event.date} {eventTime(event)}</b></span>{event.endDate && <span><small>종료</small><b>{event.endDate} {event.endTimeText}</b></span>}</section>
    <footer className="detail-actions"><button className="button primary" onClick={onEdit}>일정 편집</button><button className="button danger" onClick={onTrash}>휴지통으로 이동</button></footer>
  </div>
}

function formatMessageTime(value: string): string {
  const match = value.match(/(\d{2}:\d{2})/)
  return match?.[1] || value.slice(-8) || ''
}
