import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from './Button'
import LogViewer from './LogViewer'
import ModelCombobox from './ModelCombobox'
import { useInstallLogs } from '../hooks/useIpc'
import {
  memorySearchProviderMap,
  memorySearchProviderOptions
} from '../constants/memory-search'
import {
  getActiveModels,
  normalizeModelInput,
  providerConfigs,
  stripModelNamespace,
  visibleProviderConfigs,
  visibleProviderIds,
  type Provider,
  type AuthMethod
} from '../constants/providers'
import type {
  CurrentMemorySearchConfig,
  MemorySearchProvider
} from '../../../shared/types/memory-search'

type Phase = 'form' | 'progress' | 'done' | 'error'

interface Props {
  currentProvider?: string
  currentModel?: string
  currentMemorySearch?: CurrentMemorySearchConfig
  onClose: () => void
  onSuccess: () => void
}

export default function ProviderSwitchModal({
  currentProvider,
  currentModel,
  currentMemorySearch,
  onClose,
  onSuccess
}: Props): React.JSX.Element {
  const { t } = useTranslation('management')
  const { t: tp } = useTranslation('providers')
  const [phase, setPhase] = useState<Phase>('form')
  const initProvider =
    currentProvider === 'openai-codex' || currentModel?.startsWith('openai-codex/')
      ? 'openai'
      : currentProvider && visibleProviderIds.includes(currentProvider as Provider)
        ? (currentProvider as Provider)
        : 'modelfamily'
  const initAuthMethod: AuthMethod =
    currentProvider === 'openai-codex' || currentModel?.startsWith('openai-codex/')
      ? 'oauth'
      : 'api-key'
  const [provider, setProvider] = useState<Provider>(initProvider)
  const [authMethod, setAuthMethod] = useState<AuthMethod>(initAuthMethod)
  const [modelId, setModelId] = useState(
    currentModel ?? getActiveModels(initProvider, initAuthMethod)[0]?.id ?? ''
  )
  const [apiKey, setApiKey] = useState('')
  const [oauthDone, setOauthDone] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [memorySearchEnabled, setMemorySearchEnabled] = useState(currentMemorySearch?.enabled ?? false)
  const [memorySearchProvider, setMemorySearchProvider] = useState<MemorySearchProvider>(
    currentMemorySearch?.provider ?? 'openai'
  )
  const [memorySearchApiKey, setMemorySearchApiKey] = useState('')
  const [memorySearchWarning, setMemorySearchWarning] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const { logs, clearLogs } = useInstallLogs()

  const selected = providerConfigs.find((p) => p.id === provider)!
  const apiKeyValid = selected.pattern.test(apiKey)
  const memorySearchOption = memorySearchProviderMap[memorySearchProvider]
  const memorySearchApiKeyValid = memorySearchOption.pattern.test(memorySearchApiKey)
  const activeModels = getActiveModels(provider, authMethod)
  const modelInputValue = stripModelNamespace(modelId)

  const handleProviderChange = (id: Provider): void => {
    setProvider(id)
    setApiKey('')
    setAuthMethod('api-key')
    setOauthDone(false)
    setModelId(getActiveModels(id, 'api-key')[0]?.id ?? '')
  }

  const isOAuth = provider === 'openai' && authMethod === 'oauth'
  const isOllama = provider === 'ollama'

  const handleOAuthLogin = async (): Promise<void> => {
    setOauthLoading(true)
    try {
      const result = await window.electronAPI.oauth.loginCodex()
      if (result.success) {
        setOauthDone(true)
      } else {
        setErrorMsg(result.error === 'cancelled' ? '' : result.error || t('modal.errorOccurred'))
      }
    } catch {
      setErrorMsg(t('modal.errorOccurred'))
    } finally {
      setOauthLoading(false)
    }
  }

  const handleSwitch = async (): Promise<void> => {
    setPhase('progress')
    setErrorMsg('')
    const localMemorySearchWarning =
      memorySearchEnabled && !memorySearchApiKeyValid ? t('providerSwitch.memory.autoDisabled') : ''
    setMemorySearchWarning(localMemorySearchWarning)
    clearLogs()
    try {
      const result = await window.electronAPI.config.switchProvider({
        provider,
        ...(isOAuth || isOllama ? {} : { apiKey }),
        authMethod,
        modelId,
        memorySearch:
          memorySearchEnabled && memorySearchApiKeyValid
            ? {
                enabled: true,
                provider: memorySearchProvider,
                apiKey: memorySearchApiKey
              }
            : { enabled: false }
      })
      if (result.success) {
        if (result.warning) {
          setMemorySearchWarning(result.warning)
        }
        setPhase('done')
      } else {
        setErrorMsg(result.error || t('common:error.occurred'))
        setPhase('error')
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t('common:error.unknown'))
      setPhase('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-card w-full max-w-sm mx-4 p-6 space-y-4 max-h-[85vh] flex flex-col">
        <h3 className="text-base font-black shrink-0">{t('providerSwitch.title')}</h3>

        {phase === 'form' && (
          <div className="space-y-3 overflow-y-auto min-h-0">
            {/* Provider tabs */}
            <div className="flex flex-wrap gap-1.5">
              {visibleProviderConfigs.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleProviderChange(p.id)}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 cursor-pointer ${
                    provider === p.id
                      ? 'bg-primary text-white'
                      : 'bg-white/5 text-text-muted hover:bg-white/10'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {selected.authMethods && (
              <div className="flex rounded-lg border border-glass-border overflow-hidden bg-bg-card">
                {selected.authMethods.map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setAuthMethod(m)
                      setOauthDone(false)
                      setModelId(getActiveModels(provider, m)[0]?.id ?? '')
                    }}
                    className={`flex-1 py-1.5 text-center text-xs font-bold transition-colors duration-200 cursor-pointer ${
                      authMethod === m
                        ? 'bg-primary/15 text-primary'
                        : 'hover:bg-white/5 text-text-muted'
                    }`}
                  >
                    {t(`providerSwitch.${m === 'oauth' ? 'oauthLogin' : 'oauthApiKey'}`)}
                  </button>
                ))}
              </div>
            )}

            <ModelCombobox
              label={t('providerSwitch.modelSelect')}
              value={modelInputValue}
              options={activeModels}
              placeholder={t('providerSwitch.modelPlaceholder')}
              hint={t('providerSwitch.modelHint')}
              onChange={(rawValue) => setModelId(normalizeModelInput(provider, rawValue, authMethod))}
              onSelect={setModelId}
            />

            {isOllama ? (
              <div className="space-y-1.5">
                <p className="text-xs text-text-muted">{t('providerSwitch.ollamaInfo')}</p>
              </div>
            ) : isOAuth ? (
              <div className="space-y-1.5">
                {oauthDone ? (
                  <div className="flex items-center gap-2 px-3 py-2 bg-success/10 border border-success/30 rounded-lg">
                    <span className="text-xs font-medium text-success">
                      {t('providerSwitch.oauthSuccess')}
                    </span>
                  </div>
                ) : (
                  <button
                    onClick={handleOAuthLogin}
                    disabled={oauthLoading}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/15 border border-glass-border rounded-lg text-xs font-semibold transition-all duration-200 cursor-pointer disabled:opacity-50"
                  >
                    {oauthLoading
                      ? t('providerSwitch.oauthLoggingIn')
                      : t('providerSwitch.oauthLogin')}
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-text-muted">
                  {t('providerSwitch.apiKey')}
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={tp(`apiKeyPlaceholder.${provider}`, selected.placeholder)}
                  className={`w-full bg-bg-input rounded-xl px-4 py-2 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                    apiKey && !apiKeyValid
                      ? 'border-error/50 focus:border-error'
                      : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                  }`}
                />
              </div>
            )}

            <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs font-bold text-text">
                      {t('providerSwitch.memory.title')}
                    </label>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-text-muted">
                      {t('providerSwitch.memory.optional')}
                    </span>
                    {memorySearchEnabled && (
                      <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                        {memorySearchOption.label}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-text-muted">
                    {memorySearchEnabled
                      ? t('providerSwitch.memory.enabledHint')
                      : t('providerSwitch.memory.disabledHint')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const nextEnabled = !memorySearchEnabled
                    setMemorySearchEnabled(nextEnabled)
                    setMemorySearchWarning('')
                    if (!nextEnabled) {
                      setMemorySearchApiKey('')
                    }
                  }}
                  className={`relative inline-flex h-7 w-13 shrink-0 rounded-full border px-1 transition-all duration-200 ${
                    memorySearchEnabled
                      ? 'border-primary/50 bg-primary/20'
                      : 'border-glass-border bg-white/8'
                  }`}
                  aria-pressed={memorySearchEnabled}
                >
                  <span
                    className={`mt-[3px] inline-flex h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      memorySearchEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {memorySearchEnabled && (
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    {memorySearchProviderOptions.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          setMemorySearchProvider(option.id)
                          setMemorySearchApiKey('')
                          setMemorySearchWarning('')
                        }}
                        className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-all duration-200 ${
                          memorySearchProvider === option.id
                            ? 'border-primary/45 bg-primary/12 text-primary'
                            : 'border-white/8 bg-black/10 text-text-muted hover:border-primary/25 hover:bg-white/6 hover:text-text'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-1">
                    <input
                      type="password"
                      value={memorySearchApiKey}
                      onChange={(e) => {
                        setMemorySearchApiKey(e.target.value)
                        setMemorySearchWarning('')
                      }}
                      placeholder={`${t('providerSwitch.memory.apiKey')} · ${memorySearchOption.placeholder}`}
                      className={`w-full bg-bg-input rounded-xl px-4 py-2 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                        memorySearchApiKey && !memorySearchApiKeyValid
                          ? 'border-error/50 focus:border-error'
                          : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                      }`}
                    />
                    <p className="text-[11px] leading-5 text-text-muted">
                      {t('providerSwitch.memory.hint')}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t('providerSwitch.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSwitch}
                disabled={isOAuth ? !oauthDone : isOllama ? false : !apiKeyValid}
              >
                {t('providerSwitch.change')}
              </Button>
            </div>
          </div>
        )}

        {phase === 'progress' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <svg className="animate-spin h-5 w-5 text-primary" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  opacity="0.25"
                />
                <path
                  d="M12 2a10 10 0 0 1 10 10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              <p className="text-sm text-text-muted">{t('providerSwitch.switching')}</p>
            </div>
            {logs.length > 0 && <LogViewer lines={logs} />}
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-3">
            <p className="text-sm text-success font-medium">{t('providerSwitch.success')}</p>
            {memorySearchWarning && (
              <div className="rounded-xl border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
                {memorySearchWarning}
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onSuccess()
                onClose()
              }}
            >
              {t('modal.close')}
            </Button>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-error">{errorMsg}</p>
            {logs.length > 0 && <LogViewer lines={logs} />}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t('modal.close')}
              </Button>
              <Button variant="primary" size="sm" onClick={() => setPhase('form')}>
                {t('providerSwitch.retry')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
