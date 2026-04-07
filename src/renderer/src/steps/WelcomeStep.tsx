import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'

export default function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const { t } = useTranslation('steps')

  return (
    <div className="flex flex-1 items-center justify-center px-7 py-8 md:px-10 md:py-10">
      <div className="grid w-full max-w-[1200px] gap-5 lg:grid-cols-[1.08fr_0.92fr]">
        <section className="glass-card hero-panel flex min-h-[34rem] flex-col justify-between overflow-hidden px-7 py-7 md:px-9 md:py-9">
          <div className="flex flex-wrap items-center gap-3">
            <div className="soft-pill px-3.5 py-2 text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
              <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_16px_var(--color-primary-glow)]" />
              OpenClaw Local Installer
            </div>
            <div className="soft-pill px-3.5 py-2 text-[11px] font-medium text-text-muted">
              Model Family Edition
            </div>
          </div>

          <div className="relative z-10 mt-8 space-y-5">
            <div className="space-y-3">
              <p className="text-[13px] font-semibold tracking-[0.12em] text-text-muted uppercase">
                Desktop Setup Experience
              </p>
              <h1 className="max-w-[10ch] text-5xl font-semibold tracking-[-0.05em] text-text md:text-6xl">
                OpenClaw Installer
              </h1>
            </div>

            <p className="max-w-2xl whitespace-pre-line text-[15px] leading-8 text-text-muted">
              {t('welcome.desc')}
            </p>
          </div>

          <div className="relative z-10 mt-8 grid gap-3 md:grid-cols-3">
            <div className="glass-card px-4 py-4">
              <p className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                Local First
              </p>
              <p className="mt-2 text-sm font-semibold text-text">本地网关与配置，全程可控。</p>
            </div>
            <div className="glass-card px-4 py-4">
              <p className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                Channel Ready
              </p>
              <p className="mt-2 text-sm font-semibold text-text">飞书、微信、Telegram 渠道一体化接入。</p>
            </div>
            <div className="glass-card px-4 py-4">
              <p className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                Version Control
              </p>
              <p className="mt-2 text-sm font-semibold text-text">镜像源、版本与插件兼容性可直接管理。</p>
            </div>
          </div>

          <div className="relative z-10 mt-8 flex flex-wrap items-center gap-4">
            <Button variant="primary" size="lg" onClick={onNext}>
              {t('welcome.start')}
            </Button>
            <p className="text-[12px] font-medium text-text-muted">
              {t('welcome.title')}
            </p>
          </div>
        </section>

        <aside className="glass-card relative min-h-[34rem] overflow-hidden px-6 py-6 md:px-7 md:py-7">
          <div className="hero-grid absolute inset-0 opacity-70" />

          <div className="relative z-10 flex h-full flex-col">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.1em] text-text-muted uppercase">
                  Guided Setup
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-text">
                  更像一台产品，而不是一串脚本
                </h2>
              </div>
              <div className="soft-pill px-3 py-1.5 text-[11px] font-semibold text-primary">
                Premium Flow
              </div>
            </div>

            <div className="hero-orb mt-8 min-h-[17rem] flex-1">
              <div className="absolute inset-0 rounded-[40px] bg-[radial-gradient(circle_at_center,rgba(0,113,227,0.08),transparent_56%)]" />
              <div className="relative scale-[1.06]">
                <LobsterLogo state="idle" size={214} />
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="glass-card px-4 py-4">
                <p className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                  Installation
                </p>
                <p className="mt-2 text-sm leading-6 text-text">
                  环境检查、版本选择、镜像切换与失败恢复都在同一条流程里完成。
                </p>
              </div>
              <div className="glass-card px-4 py-4">
                <p className="text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase">
                  Recovery
                </p>
                <p className="mt-2 text-sm leading-6 text-text">
                  插件兼容、AI 修复与渠道重配置被整理成更清晰的产品化入口。
                </p>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
