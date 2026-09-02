import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppController } from './controller'
import { eventUid } from './services/events'

export interface SmokeResult {
  ok: boolean
  messageCount: number
  checks: string[]
  error?: string
}

export function runSmokeTest(controller: AppController): SmokeResult {
  const eventDir = mkdtempSync(join(tmpdir(), 'coolcalendar-events-'))
  const originalConfig = controller.getConfig()
  const checks: string[] = []
  try {
    controller.updateConfig({ eventDir, googleCalendarEnabled: false, aiAutoEnabled: false })
    const messageCount = controller.getSnapshot().messages.length
    checks.push('snapshot')

    const invalidEventDir = join(eventDir, 'not-a-directory')
    writeFileSync(invalidEventDir, 'blocked', 'utf8')
    controller.updateConfig({ eventDir: invalidEventDir })
    if (!controller.getSnapshot().eventError) throw new Error('일정 폴더 오류 복구 검증 실패')
    controller.updateConfig({ eventDir })
    if (controller.getSnapshot().eventError) throw new Error('일정 폴더 복구 후 새로고침 검증 실패')
    checks.push('event-folder-error-recovery')

    const created = controller.saveCalendarEvent({
      date: '2030-01-02', title: 'Electron smoke event', description: '한글 메모',
      allDay: false, timeText: '09:30', endTimeText: '10:00'
    })
    if (!existsSync(created.filePath) || created.title !== 'Electron smoke event' || created.timeText !== '09:30') throw new Error('일정 생성 검증 실패')
    const createdUid = eventUid(created.filePath)
    if (!createdUid) throw new Error('일정 UID 생성 검증 실패')
    checks.push('create-and-parse-ics')

    const linked = controller.saveCalendarEvent({
      date: '2030-02-01', title: 'Linked message event', description: '원본 메시지 연결',
      allDay: true, timeText: '', messageKey: 424242
    })
    const duplicate = controller.saveCalendarEvent({
      date: '2030-02-02', title: 'Duplicate message event', description: '중복 생성 시도',
      allDay: true, timeText: '', messageKey: 424242
    })
    if (!linked.sourceMessageKey || !linked.sourceMessageDbId || duplicate.filePath !== linked.filePath) throw new Error('메시지 일정 연결 검증 실패')
    const linkedCount = controller.getSnapshot().events.filter((event) => event.sourceMessageKey === 424242 && event.sourceMessageDbId === linked.sourceMessageDbId).length
    if (linkedCount !== 1) throw new Error('메시지 일정 중복 방지 검증 실패')
    checks.push('message-event-link-and-deduplication')

    const foldAt = Math.max(1, Math.floor(createdUid.length / 2))
    const parameterizedUid = `uid;VALUE=TEXT:${createdUid.slice(0, foldAt)}\r\n ${createdUid.slice(foldAt)}`
    writeFileSync(created.filePath, readFileSync(created.filePath, 'utf8').replace(`UID:${createdUid}`, parameterizedUid), 'utf8')
    if (eventUid(created.filePath) !== createdUid) throw new Error('접힌/매개변수 UID 해석 검증 실패')
    checks.push('case-insensitive-parameterized-folded-uid')

    const updated = controller.saveCalendarEvent({
      filePath: created.filePath, date: '2030-01-03', title: 'Updated smoke event',
      description: '수정된 메모', allDay: true, timeText: ''
    })
    if (!existsSync(updated.filePath) || existsSync(created.filePath) || updated.date !== '2030-01-03' || !updated.allDay || eventUid(updated.filePath) !== createdUid) throw new Error('일정 수정 검증 실패')
    checks.push('update-and-rename-ics-with-stable-uid')

    let rejectedUnsafeDate = false
    try {
      controller.saveCalendarEvent({ date: '..\\outside', title: 'Unsafe', description: '', allDay: true, timeText: '' })
    } catch {
      rejectedUnsafeDate = true
    }
    if (!rejectedUnsafeDate) throw new Error('일정 경로 검증 실패')
    checks.push('reject-unsafe-event-date')

    controller.setCompleted(updated.filePath, true)
    if (!controller.getSnapshot().events.find((event) => event.filePath === updated.filePath)?.completed) throw new Error('완료 상태 검증 실패')
    checks.push('completion-state')

    if (!controller.trashCalendarEvent(updated.filePath)) throw new Error('휴지통 이동 검증 실패')
    const trash = controller.listTrash()
    if (trash.length !== 1) throw new Error('휴지통 목록 검증 실패')
    checks.push('trash')

    const restored = controller.restoreCalendarEvent(trash[0].event.filePath)
    if (!restored || !existsSync(restored.filePath)) throw new Error('일정 복원 검증 실패')
    checks.push('restore')

    if (!controller.trashCalendarEvent(restored.filePath)) throw new Error('영구 삭제 준비 실패')
    const finalTrash = controller.listTrash()
    if (!finalTrash[0] || !controller.deleteForever(finalTrash[0].event.filePath)) throw new Error('영구 삭제 검증 실패')
    checks.push('delete-forever')

    return { ok: true, messageCount, checks }
  } catch (error) {
    return { ok: false, messageCount: controller.getSnapshot().messages.length, checks, error: error instanceof Error ? error.message : String(error) }
  } finally {
    controller.updateConfig(originalConfig)
    rmSync(eventDir, { recursive: true, force: true })
  }
}

export function writeSmokeResult(path: string, result: SmokeResult): void {
  if (path) writeFileSync(path, JSON.stringify(result, null, 2), 'utf8')
}
