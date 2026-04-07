import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import InstallProgressCard from '../components/InstallProgressCard'
import LogViewer from '../components/LogViewer'
import { useInstallLogs } from '../hooks/useIpc'

interface InstallNeeds {
  needNode: boolean
  needOpenclaw: boolean
}

type InstallSourceMode = 'auto' | 'official' | 'mirror'

export default function InstallStep({
  needs,
  forceCleanInstall = false,
  onDone
}: {
  needs: InstallNeeds
  forceCleanInstall?: boolean
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation('steps')
  const { logs, error, status, clearLogs } = useInstallLogs()
  const [installing, setInstalling] = useState(false)
  const [done, setDone] = useState(false)
  const [failed, setFailed] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [sourceMode, setSourceMode] = useState<InstallSourceMode>('auto')
  const [savingSources, setSavingSources] = useState(false)
  const [sourcesMessage, setSourcesMessage] = useState<string | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [cleanInstall, setCleanInstall] = useState(false)

  useEffect(() => {
    setCleanInstall(forceCleanInstall)
  }, [forceCleanInstall])

  useEffect(() => {
    clearLogs()
  }, [clearLogs])

  useEffect(() => {
    window.electronAPI.settings.getInstallSources().then((settings) => {
      setSourceMode(settings.sourceMode || 'auto')
    })
  }, [])

  const runInstall = useCallback(async () => {
    setInstalling(true)
    setStopping(false)
    setFailed(false)
    setCancelled(false)
    clearLogs()
    try {
      // Clean uninstall old OpenClaw if checked
      if (cleanInstall) {
        const cleanup = await window.electronAPI.openclaw.cleanUninstall()
        if (!cleanup.success) {
          throw new Error(cleanup.error || t('install.cleanInstallFailed'))
        }
      }
      if (needs.needNode) {
        const r = await window.electronAPI.install.node()
        if (!r.success) throw new Error(r.error)
      }
      if (needs.needOpenclaw) {
        const r = await window.electronAPI.install.openclaw()
        if (!r.success) throw new Error(r.error)
      }
      setDone(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'INSTALL_CANCELLED') {
        setCancelled(true)
        setFailed(false)
      } else {
        setFailed(true)
      }
    } finally {
      setInstalling(false)
      setStopping(false)
    }
  }, [needs, clearLogs, cleanInstall])

  const stopInstall = useCallback(async () => {
    setStopping(true)
    await window.electronAPI.install.cancel()
  }, [])

  const saveInstallSources = useCallback(async () => {
    setSavingSources(true)
    setSourcesMessage(null)
    setSourcesError(null)
    try {
      const result = await window.electronAPI.settings.setInstallSources({
        sourceMode
      })
      if (result.success) {
        setSourcesMessage(t('install.saveSourcesSuccess'))
      } else {
        setSourcesError(t('install.saveSourcesError'))
      }
    } catch {
      setSourcesError(t('install.saveSourcesError'))
    } finally {
      setSavingSources(false)
    }
  }, [sourceMode, t])

  const logoState = installing ? 'loading' : failed ? 'error' : done ? 'success' : 'idle'

  return (
    <div className="flex-1 w-full overflow-y-auto">
      <div className="flex flex-col px-8 py-12 pb-28 gap-4 min-h-full justify-center">
        <div className="flex items-center gap-4">
          <LobsterLogo state={logoState} size={56} />
          <div>
            <h2 className="text-lg font-extrabold">
              {done
                ? t('install.done')
                : failed
                  ? t('install.failed')
                  : cancelled
                    ? t('install.cancelled')
                    : installing
                      ? t('install.progress')
                      : t('install.ready')}
            </h2>
            <p className="text-text-muted text-xs font-medium">
              {installing
                ? t('install.wait')
                : done
                  ? t('install.allReady')
                  : failed
                    ? t('install.checkLog')
                    : cancelled
                      ? t('install.cancelledDesc')
                    : t('install.desc')}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {needs.needNode && (
            <div className="glass-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2">
              <span className="text-primary">01</span> {t('install.nodejs')}
            </div>
          )}
          {needs.needOpenclaw && (
            <div className="glass-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2">
              <span className="text-primary">{needs.needNode ? '02' : '01'}</span>{' '}
              {t('install.openclaw')}
            </div>
          )}
        </div>

        <div className="glass-card p-4 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={cleanInstall}
              onChange={(e) => setCleanInstall(e.target.checked)}
              disabled={installing || forceCleanInstall}
              className="w-4 h-4 rounded border-glass-border accent-primary"
            />
            <div>
              <span className="text-xs font-semibold">
                {forceCleanInstall
                  ? t('install.cleanInstallForcedLabel')
                  : t('install.cleanInstallLabel')}
              </span>
              <p className="text-[11px] text-text-muted/60">{t('install.cleanInstallDesc')}</p>
            </div>
          </label>
          {forceCleanInstall && (
            <p className="text-[11px] leading-5 text-warning font-medium">
              {t('install.cleanInstallForcedDesc')}
            </p>
          )}

          <button
            type="button"
            onClick={() => setShowAdvanced((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <div>
              <div className="text-sm font-bold">{t('install.advancedTitle')}</div>
              <div className="text-xs text-text-muted">{t('install.advancedDesc')}</div>
            </div>
            <span className="text-text-muted text-xs">{showAdvanced ? '▲' : '▼'}</span>
          </button>

          {showAdvanced && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold">{t('install.sourceModeLabel')}</label>
                <select
                  value={sourceMode}
                  onChange={(e) => setSourceMode(e.target.value as InstallSourceMode)}
                  className="w-full bg-bg-input rounded-xl px-4 py-2.5 text-xs outline-none border border-glass-border focus:border-primary"
                >
                  <option value="auto">{t('install.sourceMode.auto')}</option>
                  <option value="official">{t('install.sourceMode.official')}</option>
                  <option value="mirror">{t('install.sourceMode.mirror')}</option>
                </select>
              </div>
              {sourcesMessage && (
                <p className="text-xs text-success font-medium">{sourcesMessage}</p>
              )}
              {sourcesError && <p className="text-xs text-error font-medium">{sourcesError}</p>}
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={saveInstallSources}
                  disabled={savingSources || installing}
                >
                  {savingSources ? t('install.savingSources') : t('install.saveSources')}
                </Button>
              </div>
            </div>
          )}
        </div>

        {(installing || status || logs.length > 0) && <InstallProgressCard status={status} />}
        {(installing || logs.length > 0) && <LogViewer lines={logs} />}
        {error && error !== 'INSTALL_CANCELLED' && (
          <p className="text-error text-xs font-medium">{error}</p>
        )}

        <div className="flex gap-3 justify-end mt-1">
          {installing && (
            <Button variant="secondary" size="sm" onClick={stopInstall} disabled={stopping}>
              {stopping ? t('install.stoppingBtn') : t('install.stopBtn')}
            </Button>
          )}
          {failed && (
            <Button variant="secondary" size="sm" onClick={runInstall}>
              {t('install.retryBtn')}
            </Button>
          )}
          {cancelled && !installing && (
            <Button variant="secondary" size="sm" onClick={runInstall}>
              {t('install.retryBtn')}
            </Button>
          )}
          {!done && !installing && !failed && !cancelled && (
            <Button variant="primary" size="lg" onClick={runInstall}>
              {t('install.startBtn')}
            </Button>
          )}
          {done && (
            <Button variant="primary" size="lg" onClick={onDone}>
              {t('install.nextBtn')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
