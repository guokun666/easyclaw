import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import InstallProgressCard from '../components/InstallProgressCard'
import LogViewer from '../components/LogViewer'
import { useInstallLogs } from '../hooks/useIpc'

type WslState =
  | 'not_available'
  | 'not_installed'
  | 'needs_reboot'
  | 'no_distro'
  | 'not_initialized'
  | 'ready'

interface EnvResult {
  os: 'macos' | 'windows' | 'linux'
  nodeInstalled: boolean
  nodeVersion: string | null
  nodeVersionOk: boolean
  openclawInstalled: boolean
  openclawVersion: string | null
  openclawLatestVersion: string | null
  wslState?: WslState
  wslProxyInfo?: {
    enabled: boolean
    displayValue?: string
    needsAutoBridge: boolean
  }
}

type InstallSourceMode = 'auto' | 'official' | 'mirror'

const CheckRow = ({
  label,
  ok,
  detail
}: {
  label: string
  ok: boolean
  detail: string
}): React.JSX.Element => (
  <div className="glass-card flex items-center justify-between px-4 py-3">
    <span className="text-sm font-semibold">{label}</span>
    <div className="flex items-center gap-2">
      <span className="text-xs font-mono text-text-muted">{detail}</span>
      <div
        className={`w-2 h-2 rounded-full ${ok ? 'bg-success' : 'bg-error'}`}
        style={ok ? { animation: 'glow-pulse 2s infinite', color: 'var(--color-success)' } : {}}
      />
    </div>
  </div>
)

export default function EnvCheckStep({
  onNext,
  onNeedInstall
}: {
  onNext: () => void
  onNeedInstall: (env: EnvResult) => void
}): React.JSX.Element {
  const { t } = useTranslation(['steps', 'common'])
  const [checking, setChecking] = useState(true)
  const [env, setEnv] = useState<EnvResult | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [showSourceSettings, setShowSourceSettings] = useState(false)
  const [sourceMode, setSourceMode] = useState<InstallSourceMode>('auto')
  const [savingSources, setSavingSources] = useState(false)
  const [sourcesMessage, setSourcesMessage] = useState<string | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const { logs, error, status, clearLogs } = useInstallLogs()

  const wslStateLabel = (state?: WslState): string => {
    switch (state) {
      case 'ready':
        return t('envCheck.wslState.ready')
      case 'no_distro':
        return t('envCheck.wslState.noDistro')
      case 'needs_reboot':
        return t('envCheck.wslState.needsReboot')
      case 'not_installed':
        return t('envCheck.wslState.notInstalled')
      case 'not_initialized':
        return t('envCheck.wslState.notInitialized')
      case 'not_available':
        return t('envCheck.wslState.notAvailable')
      default:
        return t('envCheck.wslState.checking')
    }
  }

  const runCheck = (): void => {
    setChecking(true)
    window.electronAPI.env
      .check()
      .then((result) => setEnv(result as EnvResult))
      .catch(() => setEnv(null))
      .finally(() => setChecking(false))
  }

  useEffect(() => {
    runCheck()
    window.electronAPI.settings.getInstallSources().then((settings) => {
      setSourceMode(settings.sourceMode || 'auto')
    })
  }, [])

  const hasUpdate =
    env?.openclawInstalled &&
    env.openclawVersion &&
    env.openclawLatestVersion &&
    env.openclawVersion !== env.openclawLatestVersion

  const handleUpdate = async (): Promise<void> => {
    setUpdating(true)
    setUpdateError(null)
    clearLogs()
    try {
      const result = await window.electronAPI.install.openclaw()
      if (!result.success) {
        throw new Error(result.error || t('common:error.occurred'))
      }
      runCheck()
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : t('common:error.unknown'))
    } finally {
      setUpdating(false)
    }
  }

  const allReady = env ? env.nodeInstalled && env.nodeVersionOk && env.openclawInstalled : false

  const handleContinue = (): void => {
    if (!env) return
    allReady ? onNext() : onNeedInstall(env)
  }

  const saveInstallSources = async (): Promise<void> => {
    setSavingSources(true)
    setSourcesMessage(null)
    setSourcesError(null)
    try {
      const result = await window.electronAPI.settings.setInstallSources({ sourceMode })
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
  }

  return (
    <div className="flex-1 w-full overflow-y-auto">
      <div className="flex flex-col items-center pt-16 px-8 pb-28 gap-5 min-h-full">
        <LobsterLogo state={checking ? 'loading' : allReady ? 'success' : 'idle'} size={72} />

        <h2 className="text-lg font-extrabold">{t('envCheck.title')}</h2>

        {checking ? (
          <p className="text-text-muted text-sm animate-pulse">{t('envCheck.scanning')}</p>
        ) : env ? (
          <div className="w-full max-w-xs space-y-2.5">
            <CheckRow
              label={t('envCheck.os')}
              ok={true}
              detail={env.os === 'macos' ? 'macOS' : env.os === 'windows' ? 'Windows' : 'Linux'}
            />
            {env.os === 'windows' && (
              <CheckRow
                label={t('envCheck.wsl')}
                ok={env.wslState === 'ready'}
                detail={wslStateLabel(env.wslState)}
              />
            )}
            {env.os === 'windows' && env.wslProxyInfo?.enabled && (
              <div className="glass-card px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">{t('envCheck.proxy')}</span>
                  <span className="text-xs font-mono text-text-muted">
                    {env.wslProxyInfo.displayValue || t('envCheck.proxyDetected')}
                  </span>
                </div>
                <p className="text-xs leading-5 text-text-muted">
                  {env.wslProxyInfo.needsAutoBridge
                    ? t('envCheck.proxyAutoBridge')
                    : t('envCheck.proxyDirect')}
                </p>
              </div>
            )}
            <CheckRow
              label={t('envCheck.nodejs')}
              ok={env.nodeVersionOk}
              detail={env.nodeInstalled ? `v${env.nodeVersion}` : t('common:status.notInstalled')}
            />
            <CheckRow
              label={t('envCheck.openclaw')}
              ok={env.openclawInstalled}
              detail={
                env.openclawInstalled ? `v${env.openclawVersion}` : t('common:status.notInstalled')
              }
            />
            {hasUpdate && (
              <button
                onClick={handleUpdate}
                disabled={updating}
                className="w-full text-xs text-center py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-accent transition-colors disabled:opacity-50"
              >
                {updating
                  ? t('common:status.updating')
                  : `v${env.openclawLatestVersion} ${t('envCheck.updateAvailable')}`}
              </button>
            )}
          </div>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          onClick={handleContinue}
          disabled={checking || updating}
          loading={checking || updating}
        >
          {checking
            ? t('envCheck.checkBtn')
            : updating
              ? t('common:status.updating')
              : allReady
                ? t('envCheck.nextBtn')
                : t('envCheck.installBtn')}
        </Button>

        {!checking && (
          <div className="w-full max-w-xs glass-card p-4 space-y-3">
            <button
              type="button"
              onClick={() => setShowSourceSettings((prev) => !prev)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <div className="text-sm font-bold">{t('install.advancedTitle')}</div>
                <div className="text-xs text-text-muted">{t('install.advancedDesc')}</div>
              </div>
              <span className="text-text-muted text-xs">{showSourceSettings ? '▲' : '▼'}</span>
            </button>

            {showSourceSettings && (
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
                    disabled={savingSources || updating}
                  >
                    {savingSources ? t('install.savingSources') : t('install.saveSources')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {(updating || status || logs.length > 0) && (
          <div className="w-full max-w-xs">
            <InstallProgressCard status={status} />
          </div>
        )}
        {(updating || logs.length > 0) && (
          <div className="w-full max-w-xs">
            <LogViewer lines={logs} />
          </div>
        )}
        {(updateError || error) && (
          <p className="w-full max-w-xs text-error text-xs font-medium">{updateError || error}</p>
        )}
      </div>
    </div>
  )
}
