import { useEffect, useRef, useState } from 'react'

export default function EmbeddedTerminal({
  title,
  content,
  active
}: {
  title: string
  content: string
  active: boolean
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [content])

  const handleCopy = async (): Promise<void> => {
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="glass-card !rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-2 h-2 rounded-full ${active ? 'bg-success shadow-[0_0_8px_var(--color-success)]' : 'bg-text-muted/40'}`}
          />
          <span className="text-xs font-semibold">{title}</span>
        </div>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!content}
          className="text-[10px] font-semibold text-text-muted hover:text-text transition-colors disabled:opacity-40"
        >
          {copied ? '已复制' : '复制终端内容'}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="h-72 overflow-auto bg-black/30 px-3 py-3 font-mono text-[11px] leading-5 text-text whitespace-pre"
        style={{ contain: 'content' }}
      >
        {content || '终端输出将在这里显示...'}
      </div>
    </div>
  )
}
