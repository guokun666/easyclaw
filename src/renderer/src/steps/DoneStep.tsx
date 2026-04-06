import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import LogViewer from '../components/LogViewer'
import ManagementModal from '../components/ManagementModal'
import ProviderSwitchModal from '../components/ProviderSwitchModal'
import AiRepairApprovalModal from '../components/AiRepairApprovalModal'
import { useManagement } from '../hooks/useManagement'
import type { ChannelType } from './TelegramGuideStep'
import type { CurrentMemorySearchConfig } from '../../../shared/types/memory-search'

interface PendingAiRepairPlan {
  planId: string
  summary: string
  actions: Array<{
    label: string
    reason: string
    effect: string
    commandPreview: string
    commandRuntime: string
    approval: 'auto' | 'confirm'
  }>
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000 // 30 min

export default function DoneStep({
  botUsername: _botUsername,
  channelType: _channelType,
  onTroubleshoot,
  onUninstallDone,
  onConfigureChannel
}: {
  botUsername?: string
  channelType: ChannelType
  onTroubleshoot?: () => void
  onUninstallDone?: () => void
  onConfigureChannel?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('management')
  const [status, setStatus] = useState<'starting' | 'running' | 'stopped'>('starting')
  const [hasError, setHasError] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [currentProvider, setCurrentProvider] = useState<string | undefined>()
  const [currentMemorySearch, setCurrentMemorySearch] = useState<CurrentMemorySearchConfig | undefined>()
  const [configReady, setConfigReady] = useState<boolean | null>(null)
  const [showProviderModal, setShowProviderModal] = useState(false)
  const [aiRepairing, setAiRepairing] = useState(false)
  const [aiRepairConfirming, setAiRepairConfirming] = useState(false)
  const [pendingAiRepairPlan, setPendingAiRepairPlan] = useState<PendingAiRepairPlan | null>(null)

  // OpenClaw update state
  const [openclawUpdate, setOpenclawUpdate] = useState<{
    current: string
    latest: string
  } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateLogs, setUpdateLogs] = useState<string[]>([])
  const updateCheckedRef = useRef(false)
  const expectedStopRef = useRef(false)
  const shouldRenderLogs = status === 'starting' || logs.length > 0 || hasError

  const tRef = useRef<TFunction>(t)
  tRef.current = t

  const { uninstall, backup } = useManagement(setStatus)

  const syncGatewayStatus = useCallback(async (): Promise<'running' | 'stopped'> => {
    const nextStatus = await window.electronAPI.gateway.status()
    const normalizedStatus = nextStatus === 'running' ? 'running' : 'stopped'
    setStatus(normalizedStatus)
    if (normalizedStatus === 'running') {
      setHasError(false)
      expectedStopRef.current = false
    }
    return nextStatus
  }, [])

  // Check for OpenClaw updates
  const checkOpenclawUpdate = useCallback(async () => {
    try {
      const info = await window.electronAPI.openclaw.checkUpdate()
      if (info.currentVersion && info.latestVersion && info.currentVersion !== info.latestVersion) {
        setOpenclawUpdate({ current: info.currentVersion, latest: info.latestVersion })
      } else {
        setOpenclawUpdate(null)
      }
    } catch {
      /* ignore network errors */
    }
  }, [])

  // Check once when Gateway is running + every 30 min
  useEffect(() => {
    if (status !== 'running') return

    if (!updateCheckedRef.current) {
      updateCheckedRef.current = true
      checkOpenclawUpdate()
    }

    const timer = setInterval(checkOpenclawUpdate, UPDATE_CHECK_INTERVAL)
    return () => clearInterval(timer)
  }, [status, checkOpenclawUpdate])

  // Execute OpenClaw update
  const handleOpenclawUpdate = useCallback(async () => {
    setUpdating(true)
    setUpdateLogs([])

    const unsubProgress = window.electronAPI.install.onProgress((msg) => {
      setUpdateLogs((prev) => [...prev, msg])
    })
    const unsubError = window.electronAPI.install.onError((msg) => {
      setUpdateLogs((prev) => [...prev, tRef.current('done.errorPrefix', { msg })])
    })

    try {
      const result = await window.electronAPI.install.openclaw()
      if (result.success) {
        setUpdateLogs((prev) => [...prev, tRef.current('done.restartingGw')])
        await window.electronAPI.gateway.restart()
        const nextStatus = await syncGatewayStatus()
        if (nextStatus !== 'running') {
          setHasError(true)
          setShowLogs(true)
        }
        await checkOpenclawUpdate()
      }
    } finally {
      unsubProgress()
      unsubError()
      setUpdating(false)
    }
  }, [checkOpenclawUpdate, syncGatewayStatus])

  // Load auto launch settings
  useEffect(() => {
    window.electronAPI.autoLaunch.get().then((r) => setAutoLaunch(r.enabled))
  }, [])

  const appendLogOnce = useCallback((message: string) => {
    setLogs((prev) => (prev.includes(message) ? prev : [...prev, message]))
  }, [])

  const bindAiRepairLogBridge = useCallback(() => {
    const unsubProgress = window.electronAPI.install.onProgress((msg) => {
      setLogs((prev) => [...prev, ...msg.split('\n').filter(Boolean)])
    })
    const unsubError = window.electronAPI.install.onError((msg) => {
      setLogs((prev) => [...prev, tRef.current('done.errorPrefix', { msg })])
      setHasError(true)
      setShowLogs(true)
    })

    return () => {
      unsubProgress()
      unsubError()
    }
  }, [])

  // Read current provider/model
  const loadCurrentConfig = useCallback(async () => {
    const result = await window.electronAPI.config.read()

    if (result.success && result.config) {
      setCurrentModel(result.config.model || null)
      setCurrentProvider(result.config.provider)
      setCurrentMemorySearch(result.config.memorySearch)
      setConfigReady(result.config.isConfigured === true)
      return result.config
    }

    setCurrentModel(null)
    setCurrentProvider(undefined)
    setCurrentMemorySearch(undefined)
    setConfigReady(false)
    return null
  }, [])

  useEffect(() => {
    void loadCurrentConfig()
  }, [loadCurrentConfig])

  const toggleAutoLaunch = async (): Promise<void> => {
    const next = !autoLaunch
    await window.electronAPI.autoLaunch.set(next)
    setAutoLaunch(next)
  }

  useEffect(() => {
    const unsub = window.electronAPI.gateway.onLog((msg) => {
      setLogs((prev) => [...prev, msg])
    })
    return unsub
  }, [])

  useEffect(() => {
    if (status === 'starting' || hasError) {
      setShowLogs(true)
    }
  }, [hasError, status])

  // Subscribe to Gateway status changes from tray
  useEffect(() => {
    const unsub = window.electronAPI.gateway.onStatusChanged((s) => {
      setStatus(s === 'running' ? 'running' : 'stopped')
      if (s === 'running') {
        expectedStopRef.current = false
        setHasError(false)
      }
      if (s === 'stopped' && !expectedStopRef.current) {
        setHasError(true)
        setShowLogs(true)
        appendLogOnce(tRef.current('done.stoppedUnexpectedlyLog'))
      }
      if (s === 'stopped' && expectedStopRef.current) {
        expectedStopRef.current = false
      }
    })
    return unsub
  }, [appendLogOnce])

  useEffect(() => {
    if (configReady === null) return

    if (!configReady) {
      setStatus('stopped')
      setHasError(true)
      setShowLogs(true)
      appendLogOnce(tRef.current('done.configRequiredLog'))
      return
    }

    let cancelled = false

    const poll = async (): Promise<void> => {
      for (let i = 0; i < 15; i++) {
        if (cancelled) return
        const s = await window.electronAPI.gateway.status()
        if (cancelled) return
        if (s === 'running') {
          setStatus('running')
          setHasError(false)
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (cancelled) return
      setStatus('stopped')
      setHasError(true)
      setShowLogs(true)
      appendLogOnce(tRef.current('done.startNotDetectedLog'))
    }
    poll()

    return () => {
      cancelled = true
    }
  }, [appendLogOnce, configReady, syncGatewayStatus])

  const handleStop = async (): Promise<void> => {
    expectedStopRef.current = true
    await window.electronAPI.gateway.stop()
    setStatus('stopped')
  }

  const handleRestart = useCallback(async (): Promise<void> => {
    expectedStopRef.current = true
    setStatus('starting')
    setLogs([])
    setHasError(false)
    const r = await window.electronAPI.gateway.restart()
    if (r.success) {
      const nextStatus = await syncGatewayStatus()
      if (nextStatus !== 'running') {
        setHasError(true)
        setShowLogs(true)
      } else {
        setHasError(false)
      }
    } else {
      setStatus('stopped')
      setHasError(true)
      if (r.error) {
        setLogs((prev) => [...prev, tRef.current('done.errorPrefix', { msg: r.error })])
        setShowLogs(true)
      }
    }
  }, [syncGatewayStatus])

  const handleAiRepair = useCallback(async (): Promise<void> => {
    setAiRepairing(true)
    setShowLogs(true)
    setHasError(false)
    setPendingAiRepairPlan(null)
    const teardown = bindAiRepairLogBridge()

    try {
      setLogs((prev) => [...prev, tRef.current('done.aiRepairStarted')])
      const plan = await window.electronAPI.troubleshoot.aiRepairPlan({ logs })
      if (!plan.success || !plan.planId) {
        setHasError(true)
        setShowLogs(true)
        return
      }

      if (plan.requiresApproval) {
        setLogs((prev) => [...prev, tRef.current('done.aiRepairAwaitingApproval')])
        setPendingAiRepairPlan({
          planId: plan.planId,
          summary: plan.summary,
          actions: plan.actions
        })
        return
      }

      const result = await window.electronAPI.troubleshoot.aiRepairExecute({ planId: plan.planId })
      if (result.awaitingApproval) {
        const nextStatus = await syncGatewayStatus()
        if (nextStatus !== 'running') {
          setHasError(true)
          setShowLogs(true)
        }
        setPendingAiRepairPlan({
          planId: result.awaitingApproval.planId,
          summary: result.awaitingApproval.summary,
          actions: result.awaitingApproval.actions
        })
        return
      }

      const nextStatus = await syncGatewayStatus()
      if (result.success && nextStatus === 'running') {
        setHasError(false)
      } else {
        setHasError(true)
        setShowLogs(true)
      }
    } finally {
      teardown()
      setAiRepairing(false)
    }
  }, [bindAiRepairLogBridge, logs, syncGatewayStatus])

  const handleAiRepairConfirm = useCallback(async (): Promise<void> => {
    if (!pendingAiRepairPlan) return

    setAiRepairConfirming(true)
    setShowLogs(true)
    const teardown = bindAiRepairLogBridge()

    try {
      const result = await window.electronAPI.troubleshoot.aiRepairExecute({
        planId: pendingAiRepairPlan.planId
      })
      if (result.awaitingApproval) {
        const nextStatus = await syncGatewayStatus()
        if (nextStatus !== 'running') {
          setHasError(true)
          setShowLogs(true)
        }
        setPendingAiRepairPlan({
          planId: result.awaitingApproval.planId,
          summary: result.awaitingApproval.summary,
          actions: result.awaitingApproval.actions
        })
        return
      }

      const nextStatus = await syncGatewayStatus()
      if (result.success && nextStatus === 'running') {
        setHasError(false)
      } else {
        setHasError(true)
        setShowLogs(true)
      }
      setPendingAiRepairPlan(null)
    } finally {
      teardown()
      setAiRepairConfirming(false)
    }
  }, [bindAiRepairLogBridge, pendingAiRepairPlan, syncGatewayStatus])

  const handleAiRepairCancel = useCallback((): void => {
    setPendingAiRepairPlan(null)
    setLogs((prev) => [...prev, tRef.current('done.aiRepairCancelled')])
    void syncGatewayStatus().then((nextStatus) => {
      if (nextStatus !== 'running') {
        setHasError(true)
        setShowLogs(true)
      }
    })
  }, [syncGatewayStatus])

  return (
    <div className="w-full px-10 pt-8 pb-28">
      <div className="mx-auto flex max-w-4xl flex-col items-center justify-center gap-5 min-h-full">
      {/* Logo + status */}
      <div className="flex items-center gap-5">
        <div className="relative">
          <div
            className={`absolute inset-0 rounded-full blur-2xl scale-125 transition-colors duration-700 ${
              status === 'running' ? 'bg-success/10' : 'bg-primary/10'
            }`}
          />
          <LobsterLogo
            state={status === 'running' ? 'success' : status === 'starting' ? 'loading' : 'idle'}
            size={54}
          />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <div
              className={`w-2.5 h-2.5 rounded-full transition-colors duration-500 ${
                status === 'running'
                  ? 'bg-success'
                  : status === 'starting'
                    ? 'bg-warning'
                    : 'bg-text-muted/40'
              }`}
              style={
                status !== 'stopped'
                  ? {
                      animation: 'glow-pulse 2s infinite',
                      color: status === 'running' ? 'var(--color-success)' : 'var(--color-warning)'
                    }
                  : {}
              }
            />
            <span className="text-xl font-bold tracking-wide">
              {status === 'running'
                ? t('done.gatewayRunning')
                : status === 'starting'
                  ? t('done.gatewayStarting')
                  : t('done.gatewayStopped')}
            </span>
          </div>
          {currentModel && (
            <button
              onClick={() => setShowProviderModal(true)}
              className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-opacity"
            >
              <span className="text-sm text-text-muted">{t('done.aiModel')}</span>
              <span className="text-sm font-bold text-primary">{currentModel}</span>
              <span className="text-xs text-text-muted/60">{t('done.changeModel')}</span>
            </button>
          )}
        </div>
      </div>

      {/* OpenClaw update banner */}
      {(openclawUpdate || updating) && (
        <div className="w-full max-w-2xl flex items-center gap-4 px-5 py-3 rounded-2xl bg-gradient-to-r from-blue-500/15 via-blue-500/10 to-blue-500/15 border border-blue-500/30">
          <span className="text-lg">{updating ? '⏳' : '🔄'}</span>
          <div className="flex-1 min-w-0">
            {updating ? (
              <div>
                <span className="text-sm font-bold">{t('common:status.updating')}</span>
                {updateLogs.length > 0 && (
                  <p className="text-sm text-text-muted/70 truncate">
                    {updateLogs[updateLogs.length - 1]}
                  </p>
                )}
              </div>
            ) : (
              <span className="text-sm font-bold">
                {t('done.ocUpdateAvailable', { latest: openclawUpdate!.latest })}
                <span className="text-text-muted/50 font-normal ml-1">
                  ({t('done.ocCurrentVersion', { current: openclawUpdate!.current })})
                </span>
              </span>
            )}
          </div>
          {!updating && (
            <button
              onClick={handleOpenclawUpdate}
              className="px-4 py-2 text-sm font-bold rounded-xl bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 transition-all duration-200 cursor-pointer whitespace-nowrap"
            >
              {t('common:button.update')}
            </button>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        {status === 'running' ? (
          <>
            <Button
              variant="primary"
              size="lg"
              onClick={() => window.electronAPI.openclaw.dashboard()}
            >
              {t('done.openDashboard')}
            </Button>
            <Button variant="secondary" size="lg" onClick={handleRestart}>
              {t('done.restartBtn')}
            </Button>
            <Button variant="secondary" size="lg" onClick={handleStop}>
              {t('done.stopBtn')}
            </Button>
            {hasError && (
              <Button variant="secondary" size="lg" onClick={handleAiRepair} loading={aiRepairing}>
                {aiRepairing ? t('done.aiRepairing') : t('done.aiRepair')}
              </Button>
            )}
          </>
        ) : configReady ? (
          <>
            <Button variant="primary" size="lg" onClick={handleRestart}>
              {t('done.startBtn')}
            </Button>
            <Button variant="secondary" size="lg" onClick={handleAiRepair} loading={aiRepairing}>
              {aiRepairing ? t('done.aiRepairing') : t('done.aiRepair')}
            </Button>
          </>
        ) : null}
      </div>

      {/* Gateway logs */}
      {shouldRenderLogs && (
        <div className="w-full max-w-2xl">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className="text-sm text-text-muted/60 hover:text-text-muted transition-colors mb-2"
          >
            {showLogs ? t('done.hideLog') : t('done.showLog')}
            {hasError && <span className="ml-1.5 text-sm text-error">{t('done.errorDetected')}</span>}
          </button>
          {showLogs && <LogViewer lines={logs} />}
        </div>
      )}

      {/* ─── Action grid (3 columns) ─── */}
      <div className="w-full max-w-2xl grid grid-cols-3 gap-3">
        <button
          onClick={toggleAutoLaunch}
          className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
        >
          <span className="text-base">⚙️</span>
          <span className="text-sm font-bold flex-1 text-left">{t('done.autoLaunch')}</span>
          <div
            className={`w-10 h-5.5 rounded-full p-0.5 transition-colors duration-200 ${
              autoLaunch ? 'bg-primary' : 'bg-white/15'
            }`}
          >
            <div
              className={`w-4.5 h-4.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                autoLaunch ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </div>
        </button>
        {onTroubleshoot && (
          <button
            onClick={onTroubleshoot}
            className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
          >
            <span className="text-base">🔧</span>
            <span className="text-sm font-bold flex-1 text-left">{t('done.troubleshoot')}</span>
          </button>
        )}
        <button
          onClick={() => setShowProviderModal(true)}
          className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
        >
          <span className="text-base">🔑</span>
          <span className="text-sm font-bold flex-1 text-left">{t('done.configKey')}</span>
        </button>
        {onConfigureChannel && (
          <button
            onClick={onConfigureChannel}
            className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
          >
            <span className="text-base">📱</span>
            <span className="text-sm font-bold flex-1 text-left">{t('done.configChannel')}</span>
          </button>
        )}
        <button
          onClick={backup.execute}
          className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
        >
          <span className="text-base">📦</span>
          <span className="text-sm font-bold flex-1 text-left">{t('done.backup')}</span>
        </button>
        <button
          onClick={backup.openRestore}
          className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-primary/40 transition-all duration-200"
        >
          <span className="text-base">📥</span>
          <span className="text-sm font-bold flex-1 text-left">{t('done.restore')}</span>
        </button>
        <button
          onClick={uninstall.open}
          className="glass-card flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:border-error/40 transition-all duration-200"
        >
          <span className="text-base">🗑️</span>
          <span className="text-sm font-bold flex-1 text-left text-error/80">
            {t('done.delete')}
          </span>
        </button>
      </div>

      {/* ─── Uninstall modal ─── */}
      {uninstall.modal && (
        <ManagementModal
          title={t('uninstall.title')}
          phase={uninstall.modal}
          message={uninstall.progress}
          errorMsg={uninstall.error}
          onClose={() => {
            const wasDone = uninstall.modal === 'done'
            uninstall.close()
            if (wasDone) onUninstallDone?.()
          }}
        >
          <div className="space-y-3">
            <p className="text-sm text-text-muted">{t('uninstall.desc')}</p>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={uninstall.removeConfig}
                onChange={(e) => uninstall.setRemoveConfig(e.target.checked)}
                className="w-4 h-4 rounded border-glass-border accent-primary"
              />
              <span className="text-sm">{t('uninstall.removeConfig')}</span>
            </label>
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={uninstall.close}>
                {t('common:button.cancel')}
              </Button>
              <button
                onClick={uninstall.execute}
                className="px-5 py-2 text-sm font-bold rounded-xl bg-error/20 text-error border border-error/30 hover:bg-error/30 transition-all duration-200 cursor-pointer"
              >
                {t('common:button.delete')}
              </button>
            </div>
          </div>
        </ManagementModal>
      )}

      {/* ─── Restore modal ─── */}
      {backup.restoreModal && (
        <ManagementModal
          title={t('backupRestore.restoreTitle')}
          phase={backup.restoreModal}
          message={backup.restoreMsg}
          errorMsg={backup.restoreMsg}
          onClose={backup.closeRestore}
        >
          <div className="space-y-3">
            <p className="text-sm text-text-muted">{t('backupRestore.restoreDesc')}</p>
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={backup.closeRestore}>
                {t('common:button.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={backup.executeRestore}>
                {t('backupRestore.selectFile')}
              </Button>
            </div>
          </div>
        </ManagementModal>
      )}

      {/* ─── Backup modal ─── */}
      {backup.backupModal && backup.backupModal !== 'confirm' && (
        <ManagementModal
          title={t('done.settingsBackup')}
          phase={backup.backupModal}
          message={backup.backupMsg}
          errorMsg={backup.backupMsg}
          onClose={backup.closeBackup}
        />
      )}

        {/* ─── Provider switch modal ─── */}
        {showProviderModal && (
          <ProviderSwitchModal
            currentProvider={currentProvider}
            currentModel={currentModel || undefined}
            currentMemorySearch={currentMemorySearch}
            onClose={() => setShowProviderModal(false)}
            onSuccess={() => {
              void loadCurrentConfig()
              // Gateway restart is handled by IPC handler (config:switch-provider)
              setStatus('starting')
              setLogs([])
              setShowLogs(false)
              setHasError(false)
              setTimeout(async () => {
                const s = await window.electronAPI.gateway.status()
                setStatus(s === 'running' ? 'running' : 'stopped')
                if (s === 'running') {
                  setHasError(false)
                }
              }, 3000)
            }}
          />
        )}

        {pendingAiRepairPlan && (
          <AiRepairApprovalModal
            title={t('done.aiRepairReviewTitle')}
            description={t('done.aiRepairReviewDesc')}
            summaryLabel={t('done.aiRepairProblemLabel')}
            actionLabel={t('done.aiRepairActionLabel')}
            commandLabel={t('done.aiRepairCommandLabel')}
            runtimeLabel={t('done.aiRepairRuntimeLabel')}
            effectLabel={t('done.aiRepairEffectLabel')}
            cancelLabel={t('common:button.cancel')}
            confirmLabel={t('done.aiRepairApprove')}
            summary={pendingAiRepairPlan.summary}
            actions={pendingAiRepairPlan.actions}
            onClose={handleAiRepairCancel}
            onConfirm={handleAiRepairConfirm}
            confirming={aiRepairConfirming}
          />
        )}

      </div>
    </div>
  )
}
