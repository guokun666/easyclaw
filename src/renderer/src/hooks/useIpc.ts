import { useState, useEffect, useCallback } from 'react'

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

  useEffect(() => {
    const offStatus = window.electronAPI.install.onStatus((nextStatus) => {
      setStatus(nextStatus)
    })
    const offProgress = window.electronAPI.install.onProgress((msg) => {
      setLogs((prev) => [...prev, msg])
    })
    const offError = window.electronAPI.install.onError((msg) => {
      setError(msg)
    })
    return () => {
      offStatus()
      offProgress()
      offError()
    }
  }, [])

  const clearLogs = useCallback(() => {
    setLogs([])
    setError(null)
    setStatus(null)
  }, [])

  return { logs, error, status, clearLogs }
}
