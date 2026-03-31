import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from '../components/Button'
import LogViewer from '../components/LogViewer'
import LobsterLogo from '../components/LobsterLogo'
import { useInstallLogs } from '../hooks/useIpc'
import type { SetupPayload } from './ConfigStep'

export default function ChannelSetupStep({
  payload,
  onDone
}: {
  payload: SetupPayload
  onDone: (botUsername?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation(['steps', 'common'])
  const { logs, clearLogs, status } = useInstallLogs()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRun = (): void => {
    clearLogs()
    setError(null)
    setRunning(true)

    void window.electronAPI.onboard
      .run(payload)
      .then((result) => {
        if (result.success) {
          onDone(result.botUsername)
        } else {
          setError(result.error ?? t('setup.errorOccurred'))
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : t('common:error.unknown'))
      })
      .finally(() => {
        setRunning(false)
      })
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8 pt-6">
      <div className="flex-1 overflow-y-auto pb-2 space-y-4">
        <div className="flex items-center gap-3">
          <LobsterLogo state={running ? 'loading' : error ? 'error' : 'idle'} size={48} />
          <div>
            <h2 className="text-lg font-extrabold">{t('setup.title')}</h2>
            <p className="text-text-muted text-xs">
              {running ? t('setup.runningDesc') : error ? t('setup.failedDesc') : t('setup.readyDesc')}
            </p>
          </div>
        </div>

        <div className="glass-card px-4 py-3 space-y-1.5">
          <div className="text-sm font-bold">{t('setup.summaryTitle')}</div>
          <div className="text-xs text-text-muted leading-relaxed">
            {t(`setup.summaryChannel.${payload.channelType ?? 'telegram'}`)}
          </div>
        </div>

        <div className="glass-card px-4 py-3 space-y-2">
          <div className="text-sm font-bold">{t('setup.manualTitle')}</div>
          <p className="text-xs text-text-muted leading-relaxed">{t('setup.manualBody')}</p>
        </div>

        {status && (
          <div className="glass-card px-4 py-3 space-y-1">
            <div className="text-sm font-bold">{t('setup.progressTitle')}</div>
            <p className="text-xs text-text-muted leading-relaxed">
              {status.stage}
              {status.detail ? ` · ${status.detail}` : ''}
            </p>
          </div>
        )}

        {logs.length > 0 && <LogViewer lines={logs} />}
        {error && <p className="text-error text-xs font-medium">{error}</p>}
      </div>

      <div className="shrink-0 flex justify-end py-3">
        <Button variant="primary" size="lg" onClick={handleRun} disabled={running}>
          {running ? t('setup.runningBtn') : error ? t('setup.retryBtn') : t('setup.startBtn')}
        </Button>
      </div>
    </div>
  )
}
