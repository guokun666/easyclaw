import { useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const MAX_LINES = 500
const COLLAPSED_HEIGHT = 'h-32'
const EXPANDED_HEIGHT = 'h-72'

export default function LogViewer({
  lines,
  defaultExpanded = false,
  expandedHeightClass
}: {
  lines: string[]
  defaultExpanded?: boolean
  expandedHeightClass?: string
}): React.JSX.Element {
  const { t } = useTranslation('management')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<number | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [copied, setCopied] = useState(false)
  const displayLines = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines
  const expandedHeight = expandedHeightClass ?? EXPANDED_HEIGHT

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [displayLines.length])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const handleCopy = async (): Promise<void> => {
    const text = displayLines.join('\n')
    if (!text) return

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', 'true')
      textarea.style.position = 'absolute'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }

    setCopied(true)

    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current)
    }

    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false)
      copyTimerRef.current = null
    }, 1500)
  }

  return (
    <div className="glass-card !rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-white/5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="w-2 h-2 rounded-full bg-error/60" />
          <div className="w-2 h-2 rounded-full bg-warning/60" />
          <div className="w-2 h-2 rounded-full bg-success/60" />
          <span className="ml-2 text-[10px] text-text-muted/50 font-mono">output</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-[10px] font-semibold text-text-muted hover:text-text transition-colors"
          >
            {expanded ? t('logViewer.collapse') : t('logViewer.expand')}
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={displayLines.length === 0}
            className="text-[10px] font-semibold text-text-muted hover:text-text transition-colors disabled:opacity-40 disabled:hover:text-text-muted"
          >
            {copied ? t('logViewer.copied') : t('logViewer.copy')}
          </button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className={`p-3 overflow-auto font-mono text-[11px] leading-5 text-text-muted whitespace-pre ${expanded ? expandedHeight : COLLAPSED_HEIGHT}`}
      >
        {displayLines.length === 0 && (
          <span className="opacity-40 italic">{t('logViewer.waiting')}</span>
        )}
        {displayLines.map((line, i) => (
          <div key={i} className="hover:text-text/80 transition-colors">
            {line || ' '}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
