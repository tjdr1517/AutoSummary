import { useCallback, useEffect, useState } from 'react'
import type { AppSnapshot, MessengerDirectory, OverlaySnapshot } from '../../shared/types'

export function useAppSnapshot(): {
  snapshot: AppSnapshot | null
  loading: boolean
  error: string
  refresh: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await window.coolcalendar.refresh())
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void window.coolcalendar.getSnapshot().then(setSnapshot).catch((reason: unknown) => setError(String(reason))).finally(() => setLoading(false))
    const cleanups = [window.coolcalendar.on('data-changed', (payload) => {
      setSnapshot(payload as AppSnapshot)
      setError('')
      setLoading(false)
    })]
    cleanups.push(window.coolcalendar.on('directory-changed', (payload) => {
      setSnapshot((current) => current ? { ...current, directory: payload as MessengerDirectory } : current)
    }))
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [])

  return { snapshot, loading, error, refresh }
}

export function useOverlaySnapshot(): OverlaySnapshot | null {
  const [snapshot, setSnapshot] = useState<OverlaySnapshot | null>(null)

  useEffect(() => {
    void window.coolcalendar.getOverlaySnapshot().then(setSnapshot).catch(() => undefined)
    return window.coolcalendar.on('calendar-changed', (payload) => setSnapshot(payload as OverlaySnapshot))
  }, [])

  return snapshot
}
