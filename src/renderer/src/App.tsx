import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import StepIndicator from './components/StepIndicator'
import UpdateBanner from './components/UpdateBanner'
import { useWizard } from './hooks/useWizard'
import WelcomeStep from './steps/WelcomeStep'
import EnvCheckStep from './steps/EnvCheckStep'
import WslSetupStep from './steps/WslSetupStep'
import InstallStep from './steps/InstallStep'
import ApiKeyGuideStep from './steps/ApiKeyGuideStep'
import type { Provider } from './constants/providers'
import TelegramGuideStep from './steps/TelegramGuideStep'
import ConfigStep, { type SetupPayload } from './steps/ConfigStep'
import ChannelSetupStep from './steps/ChannelSetupStep'
import DoneStep from './steps/DoneStep'
import TroubleshootStep from './steps/TroubleshootStep'
import type { ChannelType } from './steps/TelegramGuideStep'

type WslState =
  | 'not_available'
  | 'not_installed'
  | 'needs_reboot'
  | 'no_distro'
  | 'not_initialized'
  | 'ready'

interface InstallNeeds {
  needNode: boolean
  needOpenclaw: boolean
}

function App({ debugMode }: { debugMode?: string }): React.JSX.Element {
  const { t } = useTranslation('common')
  const { currentStep, next, prev, canGoBack, goTo } = useWizard()
  const [installNeeds, setInstallNeeds] = useState<InstallNeeds>({
    needNode: false,
    needOpenclaw: false
  })
  const [provider, setProvider] = useState<Provider>('modelfamily')
  const [modelId, setModelId] = useState<string | undefined>()
  const [authMethod, setAuthMethod] = useState<'api-key' | 'oauth'>('api-key')
  const [channelType, setChannelType] = useState<ChannelType>('feishu')
  const [botUsername, setBotUsername] = useState<string | undefined>()
  const [setupPayload, setSetupPayload] = useState<SetupPayload | null>(null)
  const [isWindows, setIsWindows] = useState(false)
  const [wslState, setWslState] = useState<WslState>('ready')
  const [version, setVersion] = useState('')
  const [channelOnly, setChannelOnly] = useState(false)
  const isDebugWelcomeOnly = debugMode === 'welcome-only'
  const isDebugNoEffects = debugMode === 'no-effects'
  const isDebugNoBanner = debugMode === 'no-banner'
  const isDebugBareShell = debugMode === 'bare-shell'

  // Load version + OS check + reboot restoration on app start
  useEffect(() => {
    if (isDebugNoEffects || isDebugWelcomeOnly || isDebugBareShell) return

    window.electronAPI.version().then(setVersion)

    // Run loadState() after env.check() completes (prevent race condition)
    window.electronAPI.env.check().then(async (env) => {
      setIsWindows(env.os === 'windows')
      if (env.wslState) setWslState(env.wslState)

      // Restore state after reboot — run after wslState is correctly set
      const state = await window.electronAPI.wizard.loadState()
      if (state) {
        goTo(state.step as 'wslSetup' | 'envCheck')
      } else if (env.nodeVersionOk && env.openclawInstalled) {
        // Already installed → skip wizard, go directly to dashboard
        goTo('done')
      }
    })
  }, [goTo, isDebugBareShell, isDebugNoEffects, isDebugWelcomeOnly])

  const handleEnvCheckDone = (env: {
    os: string
    nodeVersionOk: boolean
    openclawInstalled: boolean
    wslState?: WslState
  }): void => {
    setInstallNeeds({
      needNode: !env.nodeVersionOk,
      needOpenclaw: !env.openclawInstalled
    })

    // Windows + WSL not ready → navigate to wslSetup
    if (env.os === 'windows' && env.wslState && env.wslState !== 'ready') {
      setWslState(env.wslState)
      goTo('wslSetup')
      return
    }

    goTo('install')
  }

  const handleWslReady = useCallback((): void => {
    // WSL ready → clear state file and re-run envCheck
    window.electronAPI.wizard.clearState()
    goTo('envCheck')
  }, [goTo])

  const handleDone = useCallback(
    (username?: string): void => {
      setBotUsername(username)
      window.electronAPI.wizard.clearState()
      goTo('done')
    },
    [goTo]
  )

  if (isDebugBareShell) {
    return <div className="h-screen bg-bg" />
  }

  if (isDebugWelcomeOnly) {
    return (
      <>
        <div className="aurora-bg" />
        <div className="flex flex-col h-full relative z-10">
          <div className="flex-1 flex flex-col min-h-0 pb-10 step-enter">
            <WelcomeStep onNext={() => undefined} />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="aurora-bg" />

      <div className="flex flex-col h-full relative z-10">
        {currentStep !== 'welcome' && currentStep !== 'troubleshoot' && (
          <StepIndicator currentStep={currentStep} isWindows={isWindows} />
        )}

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-col min-h-full pb-10 step-enter" key={currentStep}>
            {currentStep === 'welcome' && <WelcomeStep onNext={next} />}
            {currentStep === 'envCheck' && (
              <EnvCheckStep onNext={() => goTo('apiKeyGuide')} onNeedInstall={handleEnvCheckDone} />
            )}
            {currentStep === 'wslSetup' && (
              <WslSetupStep wslState={wslState} onReady={handleWslReady} />
            )}
            {currentStep === 'install' && (
              <InstallStep needs={installNeeds} onDone={() => goTo('apiKeyGuide')} />
            )}
            {currentStep === 'apiKeyGuide' && (
              <ApiKeyGuideStep
                provider={provider}
                onSelectProvider={(p) => {
                  setProvider(p)
                  setModelId(undefined)
                  setAuthMethod('api-key')
                }}
                authMethod={authMethod}
                onSelectAuthMethod={setAuthMethod}
                modelId={modelId}
                onSelectModel={setModelId}
                onNext={next}
              />
            )}
            {currentStep === 'telegramGuide' && (
              <TelegramGuideStep
                channelType={channelType}
                onSelectChannel={setChannelType}
                onNext={next}
              />
            )}
            {currentStep === 'config' && (
              <ConfigStep
                provider={provider}
                authMethod={authMethod}
                modelId={modelId}
                channelType={channelType}
                onNext={(payload) => {
                  setSetupPayload(payload)
                  goTo('setup')
                }}
              />
            )}
            {currentStep === 'setup' && setupPayload && (
              <ChannelSetupStep
                payload={setupPayload}
                channelOnly={channelOnly}
                onDone={(username) => {
                  setChannelOnly(false)
                  handleDone(username)
                }}
              />
            )}
            {currentStep === 'done' && (
              <DoneStep
                botUsername={botUsername}
                channelType={channelType}
                onTroubleshoot={() => goTo('troubleshoot')}
                onUninstallDone={() => {
                  window.electronAPI.wizard.clearState()
                  goTo('welcome')
                }}
                onConfigureChannel={() => {
                  setChannelOnly(true)
                  goTo('telegramGuide')
                }}
              />
            )}
            {currentStep === 'troubleshoot' && (
              <TroubleshootStep isWindows={isWindows} onBack={prev} />
            )}
          </div>
        </div>

        <div className="absolute bottom-3 right-4 flex items-center gap-2">
          {import.meta.env.DEV && currentStep !== 'done' && (
            <button
              onClick={() => goTo('done')}
              className="text-[10px] text-text-muted/40 hover:text-primary/60 font-mono transition-colors"
            >
              [skip→done]
            </button>
          )}
          {version && (
            <span className="text-[10px] text-text-muted/30 font-medium select-none">
              v{version}
            </span>
          )}
        </div>

        {!isDebugNoBanner && <UpdateBanner />}

        {canGoBack && currentStep !== 'troubleshoot' && (
          <button
            onClick={prev}
            className="absolute bottom-14 left-6 z-20 flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-text-muted hover:text-text bg-white/5 hover:bg-white/10 rounded-xl border border-glass-border transition-all duration-200"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {t('button.back')}
          </button>
        )}
      </div>
    </>
  )
}

export default App
