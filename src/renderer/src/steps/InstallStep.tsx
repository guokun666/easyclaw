import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import InstallProgressCard from '../components/InstallProgressCard'
import LogViewer from '../components/LogViewer'
import InstallSourceSelect from '../components/InstallSourceSelect'
import OpenClawVersionSelect from '../components/OpenClawVersionSelect'
import { useInstallLogs } from '../hooks/useIpc'
import type { InstallSourceMode } from '../constants/install-sources'

interface InstallNeeds {
  needNode: boolean
  needOpenclaw: boolean
}

interface PluginCompatibilityEntry {
  id: string
  installedVersion: string | null
  targetVersion: string
  status: 'compatible' | 'auto-sync' | 'warning' | 'ignored'
  message: string
}

interface PluginCompatibilityReport {
  success: boolean
  targetVersion: string
  entries: PluginCompatibilityEntry[]
  autoSyncCount: number
  warningCount: number
  error?: string
}

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
  const [openclawVersion, setOpenclawVersion] = useState('2026.4.1')
  const [availableVersions, setAvailableVersions] = useState<string[]>(['2026.4.1'])
  const [latestVersion, setLatestVersion] = useState<string | null>(null)
  const [recommendedVersion, setRecommendedVersion] = useState('2026.4.1')
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [versionError, setVersionError] = useState<string | null>(null)
  const [pluginCompatibility, setPluginCompatibility] = useState<PluginCompatibilityReport | null>(null)
  const [loadingPluginCompatibility, setLoadingPluginCompatibility] = useState(false)
  const [disablingPlugins, setDisablingPlugins] = useState(false)
  const [pluginCompatibilityMessage, setPluginCompatibilityMessage] = useState<string | null>(null)
  const [pluginCompatibilityError, setPluginCompatibilityError] = useState<string | null>(null)
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
      setOpenclawVersion(settings.openclawVersion || '2026.4.1')
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadVersions = async (): Promise<void> => {
      setLoadingVersions(true)
      setVersionError(null)
      try {
        const result = await window.electronAPI.openclaw.listVersions({ sourceMode })
        if (!result.success || cancelled) return
        const versions = Array.from(new Set([...(result.versions || []), openclawVersion])).sort(
          (a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
        )
        setAvailableVersions(versions)
        setLatestVersion(result.latestVersion)
        setRecommendedVersion(result.recommendedVersion)
        if (!versions.includes(openclawVersion)) {
          setOpenclawVersion(result.recommendedVersion)
        }
      } catch {
        if (!cancelled) {
          setVersionError(t('install.versionLoadError'))
          setAvailableVersions((prev) => Array.from(new Set([...prev, openclawVersion])))
        }
      } finally {
        if (!cancelled) {
          setLoadingVersions(false)
        }
      }
    }

    void loadVersions()
    return () => {
      cancelled = true
    }
  }, [openclawVersion, sourceMode, t])

  const loadPluginCompatibility = useCallback(async (): Promise<void> => {
    setLoadingPluginCompatibility(true)
    try {
      const result = await window.electronAPI.openclaw.inspectPluginCompatibility({
        version: openclawVersion
      })
      setPluginCompatibility(result)
    } catch {
      setPluginCompatibility(null)
    } finally {
      setLoadingPluginCompatibility(false)
    }
  }, [openclawVersion])

  useEffect(() => {
    let disposed = false

    const load = async (): Promise<void> => {
      setLoadingPluginCompatibility(true)
      try {
        const result = await window.electronAPI.openclaw.inspectPluginCompatibility({
          version: openclawVersion
        })
        if (!disposed) {
          setPluginCompatibility(result)
        }
      } catch {
        if (!disposed) {
          setPluginCompatibility(null)
        }
      } finally {
        if (!disposed) {
          setLoadingPluginCompatibility(false)
        }
      }
    }

    void load()

    return () => {
      disposed = true
    }
  }, [openclawVersion])

  const disableIncompatiblePlugins = useCallback(async () => {
    setDisablingPlugins(true)
    setPluginCompatibilityMessage(null)
    setPluginCompatibilityError(null)
    try {
      const result = await window.electronAPI.openclaw.disableIncompatiblePlugins({
        version: openclawVersion
      })
      if (!result.success) {
        setPluginCompatibilityError(result.error || t('install.pluginCompatDisableError'))
        return
      }
      setPluginCompatibility(result)
      setPluginCompatibilityMessage(
        result.disabledIds.length > 0
          ? t('install.pluginCompatDisableDone', { count: result.disabledIds.length })
          : t('install.pluginCompatAlreadyDisabled')
      )
      await loadPluginCompatibility()
    } catch {
      setPluginCompatibilityError(t('install.pluginCompatDisableError'))
    } finally {
      setDisablingPlugins(false)
    }
  }, [loadPluginCompatibility, openclawVersion, t])

  const runInstall = useCallback(async () => {
    setInstalling(true)
    setStopping(false)
    setFailed(false)
    setCancelled(false)
    clearLogs()
    try {
      await window.electronAPI.settings.setInstallSources({
        sourceMode,
        openclawVersion
      })
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
        const r = await window.electronAPI.install.openclaw({ version: openclawVersion })
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
  }, [needs, clearLogs, cleanInstall, openclawVersion, sourceMode, t])

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
        sourceMode,
        openclawVersion
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
  }, [openclawVersion, sourceMode, t])

  const logoState = installing ? 'loading' : failed ? 'error' : done ? 'success' : 'idle'

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col py-12 pb-6 gap-4">
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
                  <InstallSourceSelect
                    value={sourceMode}
                    onChange={setSourceMode}
                    disabled={savingSources || installing}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold">{t('install.versionLabel')}</label>
                  <OpenClawVersionSelect
                    value={openclawVersion}
                    options={availableVersions}
                    latestVersion={latestVersion}
                    recommendedVersion={recommendedVersion}
                    onChange={setOpenclawVersion}
                    disabled={savingSources || installing || loadingVersions}
                  />
                  {loadingVersions && (
                    <p className="text-[11px] text-text-muted">{t('install.versionLoading')}</p>
                  )}
                  {versionError && (
                    <p className="text-[11px] text-warning font-medium">{versionError}</p>
                  )}
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

        {(loadingPluginCompatibility ||
          (pluginCompatibility &&
            (pluginCompatibility.autoSyncCount > 0 || pluginCompatibility.warningCount > 0))) && (
          <div className="glass-card p-4 space-y-3">
            <div className="space-y-1">
              <div className="text-sm font-bold">{t('install.pluginCompatTitle')}</div>
              <div className="text-xs text-text-muted">{t('install.pluginCompatDesc')}</div>
            </div>

            {loadingPluginCompatibility ? (
              <p className="text-[11px] text-text-muted">{t('install.pluginCompatLoading')}</p>
            ) : (
              <>
                {pluginCompatibility?.autoSyncCount ? (
                  <p className="rounded-2xl border border-primary/20 bg-primary/8 px-3 py-2 text-[11px] font-medium leading-5 text-primary">
                    {t('install.pluginCompatAutoSync', {
                      count: pluginCompatibility.autoSyncCount,
                      version: pluginCompatibility.targetVersion
                    })}
                  </p>
                ) : null}

                {pluginCompatibility?.warningCount ? (
                  <p className="rounded-2xl border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] font-medium leading-5 text-warning">
                    {t('install.pluginCompatWarning', {
                      count: pluginCompatibility.warningCount,
                      version: pluginCompatibility.targetVersion
                    })}
                  </p>
                ) : null}

                <div className="space-y-2">
                  {pluginCompatibility?.entries
                    .filter(
                      (entry) =>
                        entry.status === 'auto-sync' ||
                        entry.status === 'warning' ||
                        entry.status === 'ignored'
                    )
                    .map((entry) => (
                      <div
                        key={`${entry.id}:${entry.installedVersion ?? 'unknown'}`}
                        className={`rounded-2xl border px-3 py-2 ${
                          entry.status === 'auto-sync'
                            ? 'border-primary/15 bg-primary/[0.06]'
                            : entry.status === 'ignored'
                              ? 'border-white/10 bg-white/[0.04]'
                            : 'border-warning/20 bg-warning/8'
                        }`}
                      >
                        <div className="flex items-center gap-2 text-[11px] font-semibold">
                          <span>{entry.id}</span>
                          <span className="text-text-muted">
                            {entry.installedVersion ?? t('install.pluginCompatUnknownVersion')}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-5 text-text-muted">
                          {entry.message}
                        </p>
                      </div>
                    ))}
                </div>

                {pluginCompatibilityMessage && (
                  <p className="rounded-2xl border border-success/20 bg-success/10 px-3 py-2 text-[11px] font-medium leading-5 text-success">
                    {pluginCompatibilityMessage}
                  </p>
                )}
                {pluginCompatibilityError && (
                  <p className="rounded-2xl border border-error/20 bg-error/10 px-3 py-2 text-[11px] font-medium leading-5 text-error">
                    {pluginCompatibilityError}
                  </p>
                )}

                {pluginCompatibility?.warningCount ? (
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={disableIncompatiblePlugins}
                      disabled={disablingPlugins || installing}
                    >
                      {disablingPlugins
                        ? t('install.pluginCompatDisableLoading')
                        : t('install.pluginCompatDisableBtn')}
                    </Button>
                  </div>
                ) : null}

                <p className="text-[11px] leading-5 text-text-muted">
                  {t('install.pluginCompatHint')}
                </p>
              </>
            )}
          </div>
        )}

          {(installing || status || logs.length > 0) && <InstallProgressCard status={status} />}
          {(installing || logs.length > 0) && <LogViewer lines={logs} />}
          {error && error !== 'INSTALL_CANCELLED' && (
            <p className="whitespace-pre-wrap text-error text-xs font-medium">{error}</p>
          )}
        </div>
      </div>
      <div className="shrink-0 flex gap-3 justify-end py-3">
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
  )
}
