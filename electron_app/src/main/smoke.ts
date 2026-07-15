import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppController } from './controller'

export interface SmokeResult {
  ok: boolean
  messageCount: number
  checks: string[]
  error?: string
}

export function runSmokeTest(controller: AppController): SmokeResult {
  const eventDir = mkdtempSync(join(tmpdir(), 'coolcalendar-events-'))
  const checks: string[] = []
  try {
    controller.updateConfig({ eventDir, googleCalendarEnabled: false, aiAutoEnabled: false })
    const messageCount = controller.getSnapshot().messages.length
    checks.push('snapshot')

    const created = controller.saveCalendarEvent({
      date: '2030-01-02', title: 'Electron smoke event', description: '한글 메모',
      allDay: false, timeText: '09:30', endTimeText: '10:00'
    })
    if (!existsSync(created.filePath) || created.title !== 'Electron smoke event' || created.timeText !== '09:30') throw new Error('일정 생성 검증 실패')
    checks.push('create-and-parse-ics')

    const updated = controller.saveCalendarEvent({
      filePath: created.filePath, date: '2030-01-03', title: 'Updated smoke event',
      description: '수정된 메모', allDay: true, timeText: ''
    })
    if (!existsSync(updated.filePath) || existsSync(created.filePath) || updated.date !== '2030-01-03' || !updated.allDay) throw new Error('일정 수정 검증 실패')
    checks.push('update-and-rename-ics')

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
    rmSync(eventDir, { recursive: true, force: true })
  }
}

export function writeSmokeResult(path: string, result: SmokeResult): void {
  if (path) writeFileSync(path, JSON.stringify(result, null, 2), 'utf8')
}
