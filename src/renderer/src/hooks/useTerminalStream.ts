import { startTransition, useCallback, useEffect, useRef, useState } from 'react'

const MAX_TERMINAL_LINES = 220
const FLUSH_INTERVAL_MS = 60

export const useTerminalStream = (): {
  output: string
  active: boolean
  clear: () => void
} => {
  const [output, setOutput] = useState('')
  const [active, setActive] = useState(false)
  const outputRef = useRef('')
  const pendingChunksRef = useRef('')
  const flushTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const flush = (): void => {
      flushTimerRef.current = null
      if (!pendingChunksRef.current) return

      const merged = `${outputRef.current}${pendingChunksRef.current}`
      pendingChunksRef.current = ''
      outputRef.current = merged.split('\n').slice(-MAX_TERMINAL_LINES).join('\n')
      startTransition(() => {
        setOutput(outputRef.current)
      })
    }

    const offOutput = window.electronAPI.terminal.onOutput((chunk) => {
      setActive(true)
      pendingChunksRef.current += chunk
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flush, FLUSH_INTERVAL_MS)
      }
    })

    const offExit = window.electronAPI.terminal.onExit(() => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      if (pendingChunksRef.current) {
        outputRef.current = `${outputRef.current}${pendingChunksRef.current}`
          .split('\n')
          .slice(-MAX_TERMINAL_LINES)
          .join('\n')
        pendingChunksRef.current = ''
        startTransition(() => {
          setOutput(outputRef.current)
        })
      }
      setActive(false)
    })

    return () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current)
      }
      offOutput()
      offExit()
    }
  }, [])

  const clear = useCallback(() => {
    outputRef.current = ''
    pendingChunksRef.current = ''
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setOutput('')
    setActive(false)
  }, [])

  return { output, active, clear }
}
