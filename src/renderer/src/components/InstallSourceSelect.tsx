import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  INSTALL_SOURCE_OPTION_IDS,
  type InstallSourceMode
} from '../constants/install-sources'

interface InstallSourceSelectProps {
  value: InstallSourceMode
  onChange: (value: InstallSourceMode) => void
  disabled?: boolean
}

export default function InstallSourceSelect({
  value,
  onChange,
  disabled = false
}: InstallSourceSelectProps): React.JSX.Element {
  const { t } = useTranslation('steps')
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
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        className={`w-full rounded-2xl border px-4 py-3 text-left transition-all duration-200 focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)] disabled:cursor-not-allowed disabled:opacity-60 ${
          open
            ? 'border-primary/45 bg-white shadow-[0_10px_28px_rgba(0,113,227,0.12),inset_0_1px_0_rgba(255,255,255,0.96)]'
            : 'border-glass-border bg-bg-input shadow-[0_8px_22px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.84)]'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-text">
              {t(`install.sourceMode.${value}.label`)}
            </p>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t(`install.sourceMode.${value}.desc`)}
            </p>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </button>

      {open && (
        <div className="mt-2 overflow-hidden rounded-[1.35rem] border border-black/[0.08] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,253,0.93))] shadow-[0_28px_60px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.98)] backdrop-blur-2xl">
          <div className="max-h-80 overflow-y-auto p-2.5">
            {INSTALL_SOURCE_OPTION_IDS.map((optionId) => {
              const selected = optionId === value

              return (
                <button
                  key={optionId}
                  type="button"
                  onClick={() => {
                    onChange(optionId)
                    setOpen(false)
                  }}
                  className={`w-full rounded-[1rem] border px-3.5 py-3 text-left transition-all duration-150 ${
                    selected
                      ? 'border-primary/25 bg-primary/[0.09] text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]'
                      : 'border-transparent text-text hover:border-black/[0.06] hover:bg-black/[0.025]'
                   }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text">
                        {t(`install.sourceMode.${optionId}.label`)}
                      </p>
                      <p
                        className={`mt-1 text-[11px] leading-5 ${
                          selected ? 'text-primary/85' : 'text-text-muted'
                        }`}
                      >
                        {t(`install.sourceMode.${optionId}.desc`)}
                      </p>
                    </div>
                    {selected && (
                      <span className="rounded-full border border-primary/25 bg-primary/[0.1] px-2 py-0.5 text-[10px] font-bold text-primary">
                        {t('channelGuide.selectedBadge')}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
