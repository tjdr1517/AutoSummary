import { useCallback, useEffect, useState } from 'react'
import type { AppSnapshot } from '../../shared/types'

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
    return window.coolcalendar.on('data-changed', (payload) => setSnapshot(payload as AppSnapshot))
  }, [])

  return { snapshot, loading, error, refresh }
}
