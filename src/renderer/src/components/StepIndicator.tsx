import { useTranslation } from 'react-i18next'

const defaultSteps = [
  'welcome',
  'envCheck',
  'install',
  'apiKeyGuide',
  'telegramGuide',
  'config',
  'setup',
  'done'
]

const windowsSteps = [
  'welcome',
  'envCheck',
  'wslSetup',
  'install',
  'apiKeyGuide',
  'telegramGuide',
  'config',
  'setup',
  'done'
]

export default function StepIndicator({
  currentStep,
  isWindows = false
}: {
  currentStep: string
  isWindows?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('steps')
  const steps = isWindows ? windowsSteps : defaultSteps
  const labels = (
    isWindows
      ? t('indicator.windows', { returnObjects: true })
      : t('indicator.default', { returnObjects: true })
  ) as string[]
  const total = labels.length
  const current = Math.max(0, steps.indexOf(currentStep))

  return (
    <div className="px-8 pt-7 pb-4">
      <div className="glass-card relative overflow-hidden px-5 py-4">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.38),transparent_40%)]" />
        <div className="relative flex items-start justify-between gap-3">
          <div className="absolute left-4 right-4 top-[14px] h-px rounded-full bg-black/[0.06]" />
          <div
            className="absolute left-4 top-[14px] h-px rounded-full bg-gradient-to-r from-primary/75 to-primary-hover/55 transition-all duration-700 ease-out"
            style={{ width: `${(current / (total - 1)) * 100}%` }}
          />

          {labels.map((label, i) => {
            const isActive = i <= current
            const isCurrent = i === current

            return (
              <div key={i} className="relative z-10 flex min-w-0 flex-1 flex-col items-center">
                <div
                  className={`flex h-7 w-7 items-center justify-center rounded-full border transition-all duration-500 ${
                    isCurrent
                      ? 'border-primary/35 bg-white text-primary shadow-[0_10px_24px_rgba(0,113,227,0.18)]'
                      : isActive
                        ? 'border-primary/18 bg-white/78 text-primary/80'
                        : 'border-black/6 bg-white/58 text-text-muted/55'
                  }`}
                  style={isCurrent ? { animation: 'glow-pulse 2.4s ease-in-out infinite' } : {}}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      isCurrent
                        ? 'bg-primary'
                        : isActive
                          ? 'bg-primary/70'
                          : 'bg-black/10'
                    }`}
                  />
                </div>
                <span
                  className={`mt-3 max-w-full truncate text-[11px] font-semibold tracking-[0.01em] transition-all duration-500 ${
                    isCurrent ? 'text-text' : isActive ? 'text-text-muted/90' : 'text-text-muted/55'
                  }`}
                >
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
