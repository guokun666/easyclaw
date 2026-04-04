import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DiagnosticCard from '../components/DiagnosticCard'
import Button from '../components/Button'
import LogViewer from '../components/LogViewer'
import AiRepairApprovalModal from '../components/AiRepairApprovalModal'
import { useInstallLogs } from '../hooks/useIpc'

type DiagStatus = 'ok' | 'warn' | 'error' | 'checking'

type I18nText = { key: string; params?: Record<string, unknown> }

interface DiagItem {
  label: string
  detail: string
  status: DiagStatus
  fixLabel?: string
  onFix?: () => void
  fixing?: boolean
}

interface TroubleshootStepProps {
  isWindows?: boolean
  onBack: () => void
}

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

export default function TroubleshootStep({ onBack }: TroubleshootStepProps): React.JSX.Element {
  const { t } = useTranslation('steps')
  const { logs, error, clearLogs } = useInstallLogs()
  const [showLogs, setShowLogs] = useState(false)
  const [aiFixing, setAiFixing] = useState(false)
  const [aiRepairConfirming, setAiRepairConfirming] = useState(false)
  const [pendingAiRepairPlan, setPendingAiRepairPlan] = useState<PendingAiRepairPlan | null>(null)

  const CHECKING: I18nText = { key: 'common:status.checking' }

  // Diagnostic status — store i18n keys and resolve with t() at render time
  const [envStatus, setEnvStatus] = useState<DiagStatus>('checking')
  const [envDetail, setEnvDetail] = useState<I18nText>(CHECKING)
  const [envFixing, setEnvFixing] = useState(false)

  const [gwStatus, setGwStatus] = useState<DiagStatus>('checking')
  const [gwDetail, setGwDetail] = useState<I18nText>(CHECKING)
  const [gwFixing, setGwFixing] = useState(false)

  const [portStatus, setPortStatus] = useState<DiagStatus>('checking')
  const [portDetail, setPortDetail] = useState<I18nText>(CHECKING)
  const [portFixing, setPortFixing] = useState(false)

  const diagnose = useCallback(async () => {
    const chk: I18nText = { key: 'common:status.checking' }
    setEnvStatus('checking')
    setEnvDetail(chk)
    setGwStatus('checking')
    setGwDetail(chk)
    setPortStatus('checking')
    setPortDetail(chk)

    try {
      const env = await window.electronAPI.env.check()
      if (!env.openclawInstalled) {
        setEnvStatus('error')
        setEnvDetail({ key: 'troubleshoot.envStatus.notInstalled' })
      } else if (!env.nodeVersionOk) {
        setEnvStatus('warn')
        setEnvDetail({
          key: 'troubleshoot.envStatus.nodeUpdateNeeded',
          params: { version: env.nodeVersion ?? '?' }
        })
      } else {
        setEnvStatus('ok')
        setEnvDetail({
          key: 'troubleshoot.envStatus.ok',
          params: { nodeVersion: env.nodeVersion, ocVersion: env.openclawVersion }
        })
      }
    } catch {
      setEnvStatus('error')
      setEnvDetail({ key: 'troubleshoot.envStatus.failed' })
    }

    let gwRunning = false
    try {
      const gw = await window.electronAPI.gateway.status()
      gwRunning = gw === 'running'
      setGwStatus(gwRunning ? 'ok' : 'warn')
      setGwDetail({
        key: gwRunning ? 'troubleshoot.gwStatus.running' : 'troubleshoot.gwStatus.stopped'
      })
    } catch {
      setGwStatus('error')
      setGwDetail({ key: 'troubleshoot.gwStatus.failed' })
    }

    try {
      const port = await window.electronAPI.troubleshoot.checkPort()
      if (port.inUse) {
        if (gwRunning) {
          setPortStatus('ok')
          setPortDetail({
            key: 'troubleshoot.portStatus.gwUsing',
            params: { pid: port.pid ?? '?' }
          })
        } else {
          setPortStatus('warn')
          setPortDetail({
            key: 'troubleshoot.portStatus.otherUsing',
            params: { pid: port.pid ?? '?' }
          })
        }
      } else {
        setPortStatus(gwRunning ? 'warn' : 'ok')
        setPortDetail({
          key: gwRunning
            ? 'troubleshoot.portStatus.gwRunningNoPort'
            : 'troubleshoot.portStatus.available'
        })
      }
    } catch {
      setPortStatus('error')
      setPortDetail({ key: 'troubleshoot.portStatus.failed' })
    }
  }, [])

  const didRun = useRef<true | null>(null)
  if (didRun.current == null) {
    didRun.current = true
    diagnose()
  }

  const fixEnv = async (): Promise<void> => {
    setEnvFixing(true)
    clearLogs()
    setShowLogs(true)
    await window.electronAPI.install.openclaw()
    setEnvFixing(false)
    diagnose()
  }

  const fixGateway = async (): Promise<void> => {
    setGwFixing(true)
    await window.electronAPI.gateway.stop()
    const r = await window.electronAPI.gateway.start()
    setGwFixing(false)
    setGwStatus(r.success ? 'ok' : 'error')
    setGwDetail({
      key: r.success ? 'troubleshoot.gwStatus.running' : 'troubleshoot.gwStatus.failed'
    })
  }

  const fixPort = async (): Promise<void> => {
    setPortFixing(true)
    clearLogs()
    setShowLogs(true)
    await window.electronAPI.troubleshoot.doctorFix()
    setPortFixing(false)
    diagnose()
  }

  const fixWithAi = async (): Promise<void> => {
    setAiFixing(true)
    clearLogs()
    setShowLogs(true)
    try {
      const plan = await window.electronAPI.troubleshoot.aiRepairPlan({ logs })
      if (!plan.success || !plan.planId) {
        return
      }

      if (plan.requiresApproval) {
        setPendingAiRepairPlan({
          planId: plan.planId,
          summary: plan.summary,
          actions: plan.actions
        })
        return
      }

      await window.electronAPI.troubleshoot.aiRepairExecute({ planId: plan.planId })
      diagnose()
    } finally {
      setAiFixing(false)
    }
  }

  const confirmAiRepair = async (): Promise<void> => {
    if (!pendingAiRepairPlan) return

    setAiRepairConfirming(true)
    setShowLogs(true)
    try {
      await window.electronAPI.troubleshoot.aiRepairExecute({
        planId: pendingAiRepairPlan.planId
      })
      setPendingAiRepairPlan(null)
      diagnose()
    } finally {
      setAiRepairConfirming(false)
    }
  }

  const cancelAiRepair = (): void => {
    setPendingAiRepairPlan(null)
  }

  const items: DiagItem[] = [
    {
      label: t('troubleshoot.env'),
      detail: t(envDetail.key, envDetail.params),
      status: envStatus,
      fixLabel: t('troubleshoot.reinstall'),
      onFix: fixEnv,
      fixing: envFixing
    },
    {
      label: t('troubleshoot.gateway'),
      detail: t(gwDetail.key, gwDetail.params),
      status: gwStatus,
      fixLabel: t('troubleshoot.restartGw'),
      onFix: fixGateway,
      fixing: gwFixing
    },
    {
      label: 'Port 18789',
      detail: t(portDetail.key, portDetail.params),
      status: portStatus,
      fixLabel: t('troubleshoot.doctorFix'),
      onFix: fixPort,
      fixing: portFixing
    }
  ]

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-10 gap-5">
      <div className="text-center space-y-1.5">
        <h2 className="text-xl font-black">{t('troubleshoot.title')}</h2>
        <p className="text-text-muted text-sm font-medium">{t('troubleshoot.desc')}</p>
      </div>

      <div className="w-full max-w-md space-y-2">
        {items.map((item) => (
          <DiagnosticCard key={item.label} {...item} />
        ))}
      </div>

      {logs.length > 0 && (
        <div className="w-full max-w-md">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className="text-[11px] text-text-muted/60 hover:text-text-muted transition-colors mb-1"
          >
            {showLogs ? t('troubleshoot.hideLog') : t('troubleshoot.showLog')}
          </button>
          {showLogs && <LogViewer lines={logs} />}
        </div>
      )}

      {error && <p className="w-full max-w-md text-xs text-error">{error}</p>}

      <div className="flex gap-3 mt-2">
        <Button variant="secondary" size="sm" onClick={fixWithAi} loading={aiFixing}>
          {aiFixing ? t('troubleshoot.aiRepairing') : t('troubleshoot.aiRepair')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            clearLogs()
            diagnose()
          }}
        >
          {t('troubleshoot.rediagnose')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onBack}>
          {t('common:button.back')}
        </Button>
      </div>

      {pendingAiRepairPlan && (
        <AiRepairApprovalModal
          title={t('troubleshoot.aiRepairReviewTitle')}
          description={t('troubleshoot.aiRepairReviewDesc')}
          summaryLabel={t('troubleshoot.aiRepairProblemLabel')}
          actionLabel={t('troubleshoot.aiRepairActionLabel')}
          commandLabel={t('troubleshoot.aiRepairCommandLabel')}
          runtimeLabel={t('troubleshoot.aiRepairRuntimeLabel')}
          effectLabel={t('troubleshoot.aiRepairEffectLabel')}
          cancelLabel={t('common:button.cancel')}
          confirmLabel={t('troubleshoot.aiRepairApprove')}
          summary={pendingAiRepairPlan.summary}
          actions={pendingAiRepairPlan.actions}
          onClose={cancelAiRepair}
          onConfirm={confirmAiRepair}
          confirming={aiRepairConfirming}
        />
      )}
    </div>
  )
}
