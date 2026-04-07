import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '../components/Button'
import InstallProgressCard from '../components/InstallProgressCard'
import LogViewer from '../components/LogViewer'
import LobsterLogo from '../components/LobsterLogo'
import { useInstallLogs } from '../hooks/useIpc'
import type { SetupPayload } from './ConfigStep'

export default function ChannelSetupStep({
  payload,
  channelOnly = false,
  onDone
}: {
  payload: SetupPayload
  channelOnly?: boolean
  onDone: (botUsername?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation(['steps', 'common'])
  const { logs, clearLogs, status } = useInstallLogs()
  const [running, setRunning] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runIdRef = useRef(0)
  const skippedChannelConfig = payload.skipChannelConfig === true || !payload.channelType
  const channelType = skippedChannelConfig ? null : payload.channelType
  const channelTitle = channelType ? t(`channelGuide.channels.${channelType}.title`) : t('setup.noChannelTitle')
  const hasExecutionOutput = running || !!status || logs.length > 0 || !!error
  const modeLabel =
    skippedChannelConfig
      ? t('setup.mode.modelOnly')
      : channelType === 'telegram'
      ? t('setup.mode.direct')
      : channelOnly
        ? t('setup.mode.channelOnly')
        : t('setup.mode.external')
  const nextHint =
    skippedChannelConfig
      ? t('setup.hint.noChannel')
      : channelType === 'telegram'
      ? t('setup.hint.telegram')
      : channelType === 'wechat'
        ? t('setup.hint.wechat')
        : t('setup.hint.feishu')
  const infoCards = [
    { label: t('setup.info.channel'), value: channelTitle },
    { label: t('setup.info.mode'), value: modeLabel },
    { label: t('setup.info.afterStart'), value: t('setup.info.afterStartValue') }
  ]
  const channelExecutionStarted =
    skippedChannelConfig || !channelType
      ? false
      : channelType === 'feishu' || channelType === 'wechat'
        ? (status?.percent ?? 0) >= 68
        : (status?.percent ?? 0) >= 62
  const showSkipChannelAction =
    !channelOnly && !skippedChannelConfig && (!running || !!error || channelExecutionStarted)

  useEffect(() => {
    clearLogs()
  }, [clearLogs])

  const buildRunPayload = (skipChannel: boolean): SetupPayload =>
    skipChannel
      ? {
          ...payload,
          skipChannelConfig: true,
          channelType: undefined,
          channelSetupMode: undefined,
          telegramBotToken: undefined,
          feishuAppId: undefined,
          feishuAppSecret: undefined
        }
      : payload

  const startRun = (skipChannel = false): void => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    clearLogs()
    setError(null)
    setRunning(true)
    setSkipping(false)
    const effectivePayload = buildRunPayload(skipChannel)

    const apiCall = channelOnly
      ? window.electronAPI.onboard.channelOnly({
          channelType: effectivePayload.channelType,
          channelSetupMode: effectivePayload.channelSetupMode,
          telegramBotToken: effectivePayload.telegramBotToken,
          feishuAppId: effectivePayload.feishuAppId,
          feishuAppSecret: effectivePayload.feishuAppSecret
        })
      : window.electronAPI.onboard.run(effectivePayload)

    void apiCall
      .then((result) => {
        if (runId !== runIdRef.current) return
        if (result.success) {
          onDone(result.botUsername)
        } else {
          setError(result.error ?? t('setup.errorOccurred'))
        }
      })
      .catch((err) => {
        if (runId !== runIdRef.current) return
        const message = err instanceof Error ? err.message : t('common:error.unknown')
        if (message === 'ONBOARD_CANCELLED') return
        setError(message)
      })
      .finally(() => {
        if (runId !== runIdRef.current) return
        setRunning(false)
        setSkipping(false)
      })
  }

  const handleSkipChannel = async (): Promise<void> => {
    if (channelOnly || skippedChannelConfig) return

    if (!running) {
      startRun(true)
      return
    }

    setSkipping(true)
    runIdRef.current += 1
    await window.electronAPI.onboard.cancel()
    clearLogs()
    setError(null)
    setRunning(false)
    await new Promise((resolve) => window.setTimeout(resolve, 250))
    startRun(true)
  }

  return (
    <div className="flex-1 flex min-h-0 flex-col overflow-hidden px-8 pt-6">
      <div className="mx-auto relative flex h-full w-full max-w-[min(92vw,1380px)] flex-1 flex-col min-h-0">
        <div className="min-h-0 flex-1 overflow-y-auto pb-28 pr-1">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <LobsterLogo state={running ? 'loading' : error ? 'error' : 'idle'} size={48} />
              <div>
                <h2 className="text-lg font-extrabold">{t('setup.title')}</h2>
                <p className="text-text-muted text-xs">
                  {running
                    ? t('setup.runningDesc')
                    : error
                      ? t('setup.failedDesc')
                      : skippedChannelConfig
                        ? t('setup.summaryNoChannel')
                        : t(`setup.summaryChannel.${channelType}`)}
                </p>
              </div>
            </div>

            {!hasExecutionOutput && (
              <div className="flex min-h-[26rem] items-center justify-center py-4">
                <div className="glass-card relative w-full max-w-3xl overflow-hidden border border-primary/20 bg-white/[0.035] px-6 py-6 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />

                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[11px] font-bold text-primary">
                        <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(255,122,26,0.9)]" />
                        {t('setup.readyBadge')}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-text-muted">
                        {channelTitle}
                      </span>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-xl font-extrabold tracking-tight">
                        {skippedChannelConfig
                          ? t('setup.readyHeadlineNoChannel')
                          : t('setup.readyHeadline', { channel: channelTitle })}
                      </h3>
                      <p className="max-w-2xl text-sm leading-7 text-text-muted">
                        {skippedChannelConfig
                          ? t('setup.summaryNoChannel')
                          : t(`setup.summaryChannel.${channelType}`)}
                      </p>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      {infoCards.map((card) => (
                        <div
                          key={card.label}
                          className="rounded-2xl border border-white/8 bg-black/10 px-4 py-3"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
                            {card.label}
                          </p>
                          <p className="mt-2 text-sm font-bold leading-6 text-text">
                            {card.value}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-2xl border border-primary/12 bg-primary/[0.07] px-4 py-3">
                      <p className="text-sm font-bold text-text">{t('setup.nextTitle')}</p>
                      <p className="mt-1 text-xs leading-6 text-text-muted">{nextHint}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {status && <InstallProgressCard status={status} />}

            {logs.length > 0 && (
              <LogViewer
                lines={logs}
                defaultExpanded
                expandedHeightClass="h-[min(65vh,46rem)]"
                contentClassName="text-[13px] md:text-[14px] leading-[1.28]"
              />
            )}

            {error && (
              <div className="rounded-2xl border border-error/30 bg-error/10 px-4 py-3">
                <p className="text-error text-xs font-medium">{error}</p>
              </div>
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-bg via-bg/95 to-transparent" />

        <div className="absolute bottom-0 right-0 z-10 flex justify-end py-4">
          {running ? (
            <div className="flex gap-3">
              {showSkipChannelAction && (
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => void handleSkipChannel()}
                  loading={skipping}
                >
                  {skipping ? t('setup.skippingBtn') : t('setup.skipChannelBtn')}
                </Button>
              )}
              <div className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-primary to-primary-hover px-8 py-3 text-base font-bold tracking-wide text-white shadow-lg shadow-primary-glow opacity-80">
                {t('setup.runningBtn')}
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              {showSkipChannelAction && (
                <Button variant="secondary" size="lg" onClick={() => void handleSkipChannel()}>
                  {t('setup.skipChannelBtn')}
                </Button>
              )}
              <Button variant="primary" size="lg" onClick={() => startRun()}>
                {error ? t('setup.retryBtn') : t('setup.startBtn')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
