import { useEffect, useRef, useState } from 'react'
import { stripModelNamespace, type ModelOption } from '../constants/providers'

interface ModelComboboxProps {
  label: string
  value: string
  options: ModelOption[]
  placeholder: string
  hint?: string
  required?: boolean
  reserveHeaderHeight?: boolean
  onChange: (rawValue: string) => void
  onSelect: (modelId: string) => void
  className?: string
}

export default function ModelCombobox({
  label,
  value,
  options,
  placeholder,
  hint,
  required,
  reserveHeaderHeight = false,
  onChange,
  onSelect,
  className = ''
}: ModelComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  return (
    <div className={`space-y-1.5 ${className}`.trim()} ref={rootRef}>
      <div className={reserveHeaderHeight ? 'min-h-[2.625rem] flex items-center' : undefined}>
        <label className="text-sm font-bold">
          {label} {required && <span className="text-error text-xs">必填</span>}
        </label>
      </div>

      <div className="relative">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
          }}
          className="w-full bg-bg-input rounded-xl px-4 py-2.5 pr-11 text-sm font-mono outline-none border border-glass-border transition-all duration-200 placeholder:text-text-muted/30 focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted/70 hover:text-text transition-colors"
          aria-label="toggle model list"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-white/10 bg-[#111827]/96 shadow-[0_22px_48px_rgba(0,0,0,0.38)] backdrop-blur-xl">
            <div className="max-h-56 overflow-y-auto p-2">
              {options.map((option) => {
                const shortId = stripModelNamespace(option.id)
                const isSelected = value === shortId

                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      onSelect(option.id)
                      setOpen(false)
                    }}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition-all duration-150 ${
                      isSelected
                        ? 'bg-primary/14 text-primary'
                        : 'text-text hover:bg-white/6'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{shortId}</span>
                      <span className="text-[10px] font-medium text-text-muted/55">
                        {option.name}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {hint && <p className="text-[11px] leading-5 text-text-muted">{hint}</p>}
    </div>
  )
}
