import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface OpenClawVersionSelectProps {
  value: string
  options: string[]
  latestVersion: string | null
  recommendedVersion: string
  onChange: (value: string) => void
  disabled?: boolean
}

export default function OpenClawVersionSelect({
  value,
  options,
  latestVersion,
  recommendedVersion,
  onChange,
  disabled = false
}: OpenClawVersionSelectProps): React.JSX.Element {
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

  const renderBadges = (version: string): React.JSX.Element | null => {
    const badges: React.JSX.Element[] = []

    if (version === latestVersion) {
      badges.push(
        <span
          key="latest"
          className="rounded-full border border-success/35 bg-success/12 px-2 py-0.5 text-[10px] font-bold text-success"
        >
          {t('install.versionLatestBadge')}
        </span>
      )
    }

    if (version === recommendedVersion) {
      badges.push(
        <span
          key="recommended"
          className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary"
        >
          {t('install.versionRecommendedBadge')}
        </span>
      )
    }

    return badges.length > 0 ? <div className="flex flex-wrap gap-1.5">{badges}</div> : null
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((current) => !current)}
        disabled={disabled}
        className="w-full rounded-xl border border-glass-border bg-bg-input px-4 py-2.5 text-left transition-all duration-200 focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-text">v{value}</p>
              {renderBadges(value)}
            </div>
            <p className="mt-0.5 text-[11px] leading-5 text-text-muted">
              {t('install.versionHint')}
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
        <div className="absolute left-0 right-0 top-[calc(100%+8px)] z-40 overflow-hidden rounded-2xl border border-white/10 bg-[#111827]/96 shadow-[0_22px_48px_rgba(0,0,0,0.38)] backdrop-blur-xl">
          <div className="max-h-72 overflow-y-auto p-2">
            {options.map((version) => {
              const selected = version === value

              return (
                <button
                  key={version}
                  type="button"
                  onClick={() => {
                    onChange(version)
                    setOpen(false)
                  }}
                  className={`w-full rounded-xl px-3 py-3 text-left transition-all duration-150 ${
                    selected ? 'bg-primary/14 text-primary' : 'text-text hover:bg-white/6'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">v{version}</p>
                        {renderBadges(version)}
                      </div>
                    </div>
                    {selected && (
                      <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
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
