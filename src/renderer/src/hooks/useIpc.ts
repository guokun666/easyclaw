import { useState, useEffect, useCallback, useRef } from 'react'

const MAX_LOG_LINES = 800
const MAX_LOG_LINE_LENGTH = 1200
const LOG_FLUSH_INTERVAL_MS = 50

export const useInstallLogs = (): {
  logs: string[]
  error: string | null
  status: { percent: number; stage: string; detail?: string } | null
  clearLogs: () => void
} => {
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ percent: number; stage: string; detail?: string } | null>(
    null
  )
  const pendingLogsRef = useRef<string[]>([])
  const flushTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const flushLogs = (): void => {
      flushTimerRef.current = null
      if (pendingLogsRef.current.length === 0) return

      const nextBatch = pendingLogsRef.current
      pendingLogsRef.current = []
      setLogs((prev) => [...prev, ...nextBatch].slice(-MAX_LOG_LINES))
    }

    const offStatus = window.electronAPI.install.onStatus((nextStatus) => {
      setStatus(nextStatus)
    })
    const offProgress = window.electronAPI.install.onProgress((msg) => {
      const nextLines = msg
        .split('\n')
        .map((line) => line.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''))
        .map((line) =>
          line.length > MAX_LOG_LINE_LENGTH
            ? `${line.slice(0, MAX_LOG_LINE_LENGTH)} ...[truncated]`
            : line
        )
      pendingLogsRef.current.push(...nextLines)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushLogs, LOG_FLUSH_INTERVAL_MS)
      }
    })
    const offError = window.electronAPI.install.onError((msg) => {
      setError(msg)
    })
    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
      }
      offStatus()
      offProgress()
      offError()
    }
  }, [])

  const clearLogs = useCallback(() => {
    pendingLogsRef.current = []
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setLogs([])
    setError(null)
    setStatus(null)
  }, [])

  return { logs, error, status, clearLogs }
}
