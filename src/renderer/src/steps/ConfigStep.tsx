import { useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import ModelCombobox from '../components/ModelCombobox'
import {
  getActiveModels,
  normalizeModelInput,
  stripModelNamespace,
  type Provider
} from '../constants/providers'
import { memorySearchProviderMap, memorySearchProviderOptions } from '../constants/memory-search'
import type { ChannelType } from './TelegramGuideStep'
import type { MemorySearchConfigPayload } from '../../../shared/types/memory-search'
import type { ChannelSetupMode, ConfigDraft, SetupPayload } from '../constants/setup'

const providerPatterns: Record<Provider, RegExp> = {
  modelfamily: /^.{8,}$/,
  anthropic: /^sk-ant-/,
  google: /^AIza/,
  openai: /^sk-(?!ant-)/,
  minimax: /^sk-/,
  glm: /^.{8,}$/,
  deepseek: /^sk-/,
  ollama: /^$/
}

const providerPlaceholders: Record<Provider, string> = {
  modelfamily: 'Model Family API Key',
  anthropic: 'sk-ant-...',
  google: 'AIza...',
  openai: 'sk-...',
  minimax: 'sk-...',
  glm: 'API Key',
  deepseek: 'sk-...',
  ollama: ''
}

const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/
const FEISHU_APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/
const GENERIC_APP_SECRET_PATTERN = /^.{8,}$/

interface Props {
  provider: Provider
  authMethod?: 'api-key' | 'oauth'
  modelId?: string
  onModelChange: (modelId: string) => void
  channelType: ChannelType
  skipChannelConfig?: boolean
  draft: ConfigDraft
  onDraftChange: Dispatch<SetStateAction<ConfigDraft>>
  onNext: (payload: SetupPayload) => void
}

export default function ConfigStep({
  provider,
  authMethod,
  modelId,
  onModelChange,
  channelType,
  skipChannelConfig = false,
  draft,
  onDraftChange,
  onNext
}: Props): React.JSX.Element {
  const { t } = useTranslation(['steps', 'common'])
  const { t: tp } = useTranslation('providers')
  const [error, setError] = useState<string | null>(null)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [keyValidating, setKeyValidating] = useState(false)
  const {
    apiKey,
    telegramBotToken,
    feishuSetupMode,
    feishuAppId,
    feishuAppSecret,
    memorySearchEnabled,
    memorySearchProvider,
    memorySearchApiKey,
    memorySearchNoticeTone,
    memorySearchNotice,
    oauthDone,
    validatedApiKey,
    apiKeyTestState,
    apiKeyTestMessage
  } = draft
  const isOAuth = authMethod === 'oauth'
  const isOllama = provider === 'ollama'
  const needsPreValidation =
    (provider === 'modelfamily' || provider === 'openai' || provider === 'anthropic') &&
    !isOAuth &&
    !isOllama
  const showConnectionTest = !isOAuth && !isOllama && needsPreValidation

  const pattern = providerPatterns[provider]
  const label =
    provider === 'modelfamily' ? 'Model Family API Key' : t(`config.apiKeyLabel.${provider}`)
  const placeholder = tp(`apiKeyPlaceholder.${provider}`, providerPlaceholders[provider])
  const activeModels = getActiveModels(provider, authMethod ?? 'api-key')
  const resolvedModelId = normalizeModelInput(
    provider,
    modelId ?? activeModels[0]?.id ?? '',
    authMethod ?? 'api-key'
  )
  const modelInputValue = stripModelNamespace(resolvedModelId)
  const apiKeyValid = pattern.test(apiKey)
  const telegramBotTokenValid = TELEGRAM_BOT_TOKEN_PATTERN.test(telegramBotToken)
  const feishuAppIdValid = FEISHU_APP_ID_PATTERN.test(feishuAppId)
  const feishuAppSecretValid = GENERIC_APP_SECRET_PATTERN.test(feishuAppSecret)
  const selectedChannelTitle = t(`channelGuide.channels.${channelType}.title`)
  const selectedSetupModeTitle =
    channelType === 'feishu' ? t(`config.channelSetupMode.${feishuSetupMode}.title`) : null
  const memorySearchOption = memorySearchProviderMap[memorySearchProvider]
  const memorySearchApiKeyValid = memorySearchOption.pattern.test(memorySearchApiKey)
  const channelValid = skipChannelConfig
    ? true
    : channelType === 'telegram'
      ? telegramBotTokenValid
      : channelType === 'feishu'
        ? feishuSetupMode === 'one-click' || (feishuAppIdValid && feishuAppSecretValid)
        : true
  const canSave =
    !!resolvedModelId &&
    (isOAuth ? oauthDone && channelValid : isOllama ? channelValid : apiKeyValid && channelValid)

  const updateDraft = (patch: Partial<ConfigDraft>): void => {
    onDraftChange((current) => ({
      ...current,
      ...patch
    }))
  }

  const clearApiKeyTestState = (): void => {
    updateDraft({
      validatedApiKey: null,
      apiKeyTestState: 'idle',
      apiKeyTestMessage: null
    })
  }

  const clearMemorySearchNotice = (): void => {
    updateDraft({
      memorySearchNoticeTone: 'idle',
      memorySearchNotice: null
    })
  }

  const runApiKeyValidation = async (): Promise<boolean> => {
    if (!apiKeyValid) {
      updateDraft({
        validatedApiKey: null,
        apiKeyTestState: 'error',
        apiKeyTestMessage: t('config.apiKeyTestInvalidFormat')
      })
      return false
    }

    setKeyValidating(true)
    setError(null)

    try {
      const result = await window.electronAPI.config.validateApiKey({
        provider,
        apiKey,
        authMethod: authMethod ?? 'api-key',
        modelId: resolvedModelId
      })

      if (!result.success) {
        updateDraft({
          validatedApiKey: null,
          apiKeyTestState: 'error',
          apiKeyTestMessage: result.error ?? t('config.keyValidationFailed')
        })
        return false
      }

      updateDraft({
        validatedApiKey: apiKey,
        apiKeyTestState: result.warning ? 'warning' : 'success',
        apiKeyTestMessage: result.warning ?? t('config.apiKeyTestSuccess')
      })
      return true
    } catch (err) {
      updateDraft({
        validatedApiKey: null,
        apiKeyTestState: 'error',
        apiKeyTestMessage: err instanceof Error ? err.message : t('common:error.unknown')
      })
      return false
    } finally {
      setKeyValidating(false)
    }
  }

  const handleOAuthLogin = async (): Promise<void> => {
    setOauthLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.oauth.loginCodex()
      if (result.success) {
        updateDraft({ oauthDone: true })
      } else {
        setError(
          result.error === 'cancelled'
            ? t('config.oauthCancelled')
            : result.error || t('config.oauthError')
        )
      }
    } catch {
      setError(t('config.oauthError'))
    } finally {
      setOauthLoading(false)
    }
  }

  const handleNext = async (): Promise<void> => {
    setError(null)

    if (needsPreValidation && apiKeyValid && validatedApiKey !== apiKey) {
      const validated = await runApiKeyValidation()
      if (!validated) {
        return
      }
    }

    const normalizedMemorySearch: MemorySearchConfigPayload =
      memorySearchEnabled && memorySearchApiKeyValid
        ? {
            enabled: true,
            provider: memorySearchProvider,
            apiKey: memorySearchApiKey
          }
        : { enabled: false }

    if (memorySearchEnabled && !memorySearchApiKeyValid) {
      updateDraft({
        memorySearchEnabled: false,
        memorySearchApiKey: '',
        memorySearchNoticeTone: 'warning',
        memorySearchNotice: t('config.memorySearch.autoDisabledInvalid')
      })
    }

    onNext({
      provider,
      ...(isOAuth || isOllama ? {} : { apiKey }),
      authMethod: authMethod ?? 'api-key',
      skipChannelConfig,
      ...(skipChannelConfig
        ? {}
        : {
            channelType,
            channelSetupMode:
              channelType === 'feishu'
                ? feishuSetupMode
                : channelType === 'wechat'
                  ? 'one-click'
                  : 'manual',
            telegramBotToken: telegramBotToken || undefined,
            feishuAppId: feishuAppId || undefined,
            feishuAppSecret: feishuAppSecret || undefined
          }),
      modelId: resolvedModelId,
      memorySearch: normalizedMemorySearch
    })
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8 pt-6">
      <div className="flex-1 min-h-0 overflow-y-auto pb-2 space-y-4">
        <div className="flex items-center gap-3">
          <LobsterLogo state={oauthLoading ? 'loading' : 'idle'} size={48} />
          <div>
            <h2 className="text-lg font-extrabold">{t('config.title')}</h2>
            <p className="text-text-muted text-xs">{t('config.desc')}</p>
          </div>
        </div>

        {error && <p className="text-error text-xs font-medium">{error}</p>}

        <div className="space-y-2">
          <div className="grid items-start gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
            <ModelCombobox
              label={t('config.modelLabel')}
              required
              reserveHeaderHeight
              value={modelInputValue}
              options={activeModels}
              placeholder={t('config.modelPlaceholder')}
              onChange={(rawValue) =>
                onModelChange(normalizeModelInput(provider, rawValue, authMethod ?? 'api-key'))
              }
              onSelect={onModelChange}
            />

            {isOllama ? (
              <div className="space-y-1.5">
                <label className="text-sm font-bold">Ollama</label>
                <p className="text-xs text-text-muted">{t('config.ollamaInfo')}</p>
              </div>
            ) : isOAuth ? (
              <div className="space-y-1.5">
                <label className="text-sm font-bold">
                  OpenAI {t('apiKeyGuide.authMethod.oauth')}
                </label>
                {oauthDone ? (
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-success/10 border border-success/30 rounded-xl">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-success"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span className="text-sm font-medium text-success">
                      {t('config.oauthSuccess')}
                    </span>
                  </div>
                ) : (
                  <button
                    onClick={handleOAuthLogin}
                    disabled={oauthLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/10 hover:bg-white/15 border border-glass-border rounded-xl text-sm font-semibold transition-all duration-200 cursor-pointer disabled:opacity-50"
                  >
                    {oauthLoading ? (
                      <>
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
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
                        {t('config.oauthLoggingIn')}
                      </>
                    ) : (
                      t('config.oauthLogin')
                    )}
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-bold">
                    {label} <span className="text-error text-xs">{t('config.required')}</span>
                  </label>
                  {showConnectionTest && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void runApiKeyValidation()}
                      disabled={!apiKey || keyValidating}
                    >
                      {keyValidating ? t('config.testingBtn') : t('config.testBtn')}
                    </Button>
                  )}
                </div>
                <input
                  type="password"
                  placeholder={placeholder}
                  value={apiKey}
                  onChange={(e) => {
                    updateDraft({
                      apiKey: e.target.value
                    })
                    clearApiKeyTestState()
                  }}
                  className={`w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                    apiKey && !apiKeyValid
                      ? 'border-error/50 focus:border-error'
                      : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                  }`}
                />
              </div>
            )}
          </div>

          {showConnectionTest && apiKeyTestState !== 'idle' && (
            <div
              className={`rounded-2xl border px-4 py-3 text-xs ${
                apiKeyTestState === 'success'
                  ? 'border-success/35 bg-success/10 text-success'
                  : apiKeyTestState === 'warning'
                    ? 'border-warning/35 bg-warning/10 text-warning'
                    : 'border-error/35 bg-error/10 text-error'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current/30 text-[10px] font-bold">
                  {apiKeyTestState === 'success' ? 'OK' : apiKeyTestState === 'warning' ? '!' : 'X'}
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="font-semibold">
                    {apiKeyTestState === 'success'
                      ? t('config.testResult.successTitle')
                      : apiKeyTestState === 'warning'
                        ? t('config.testResult.warningTitle')
                        : t('config.testResult.errorTitle')}
                  </p>
                  <p className="leading-relaxed text-current/85">{apiKeyTestMessage}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm font-bold">{t('config.memorySearch.title')}</label>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-text-muted">
                  {t('config.memorySearch.optional')}
                </span>
                {memorySearchEnabled && (
                  <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {memorySearchOption.label}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-5 text-text-muted">
                {memorySearchEnabled
                  ? t('config.memorySearch.enabledHint')
                  : t('config.memorySearch.disabledHint')}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                const nextEnabled = !memorySearchEnabled
                updateDraft({
                  memorySearchEnabled: nextEnabled,
                  memorySearchNoticeTone: 'idle',
                  memorySearchNotice: null,
                  ...(nextEnabled
                    ? {}
                    : {
                        memorySearchApiKey: ''
                      })
                })
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
            <div className="grid gap-2 md:grid-cols-[auto_1fr] md:items-center">
              <div className="flex flex-wrap gap-2">
                {memorySearchProviderOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      updateDraft({
                        memorySearchProvider: option.id,
                        memorySearchApiKey: '',
                        memorySearchNoticeTone: 'idle',
                        memorySearchNotice: null
                      })
                    }}
                    aria-pressed={memorySearchProvider === option.id}
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
                  placeholder={`${t('config.memorySearch.apiKeyLabel')} · ${memorySearchOption.placeholder}`}
                  value={memorySearchApiKey}
                  onChange={(e) => {
                    updateDraft({
                      memorySearchApiKey: e.target.value
                    })
                    clearMemorySearchNotice()
                  }}
                  className={`w-full bg-bg-input rounded-xl px-4 py-2 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                    memorySearchApiKey && !memorySearchApiKeyValid
                      ? 'border-error/50 focus:border-error'
                      : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                  }`}
                />
                <p className="text-[11px] leading-5 text-text-muted">
                  {t('config.memorySearch.hint')}
                </p>
              </div>
            </div>
          )}

          {memorySearchNoticeTone !== 'idle' && memorySearchNotice && (
            <div
              className={`rounded-2xl border px-4 py-3 text-xs ${
                memorySearchNoticeTone === 'success'
                  ? 'border-success/35 bg-success/10 text-success'
                  : 'border-warning/35 bg-warning/10 text-warning'
              }`}
            >
              <p className="font-semibold">
                {memorySearchNoticeTone === 'success'
                  ? t('config.memorySearch.noticeTitleSuccess')
                  : t('config.memorySearch.noticeTitleWarning')}
              </p>
              <p className="mt-1 leading-relaxed text-current/85">{memorySearchNotice}</p>
            </div>
          )}
        </div>

        {!skipChannelConfig && (
          <div className="space-y-3">
            <div>
              <label className="text-sm font-bold">
                {t('config.channelLabel')}{' '}
                <span className="text-error text-xs">{t('config.required')}</span>
              </label>
              <p className="text-xs text-text-muted mt-1">
                {t(`config.channelTypeDesc.${channelType}`)}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/20 bg-primary/8 px-4 py-2 text-xs">
              <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(255,122,26,0.9)]" />
              <span className="font-semibold text-text-muted">
                {t('channelGuide.currentSelection')}
              </span>
              <span className="font-bold text-primary">{selectedChannelTitle}</span>
              {selectedSetupModeTitle && (
                <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                  {selectedSetupModeTitle}
                </span>
              )}
            </div>

            {channelType === 'telegram' && (
              <div className="space-y-1.5">
                <label className="text-sm font-bold">
                  {t('config.telegramToken')}{' '}
                  <span className="text-error text-xs">{t('config.required')}</span>
                </label>
                <input
                  type="text"
                  placeholder="123456:ABCDEF..."
                  value={telegramBotToken}
                  onChange={(e) => updateDraft({ telegramBotToken: e.target.value })}
                  className={`w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                    telegramBotToken && !telegramBotTokenValid
                      ? 'border-error/50 focus:border-error'
                      : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                  }`}
                />
                {telegramBotToken && !telegramBotTokenValid && (
                  <p className="text-error text-[11px] font-medium">{t('config.telegramHint')}</p>
                )}
              </div>
            )}

            {channelType === 'feishu' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-sm font-bold">{t('config.channelSetupModeLabel')}</label>
                    <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                      {selectedSetupModeTitle}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(['one-click', 'manual'] as ChannelSetupMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => updateDraft({ feishuSetupMode: mode })}
                        aria-pressed={feishuSetupMode === mode}
                        className={`glass-card group relative cursor-pointer px-3 py-2 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/6 ${
                          feishuSetupMode === mode
                            ? 'border-primary/60 bg-primary/12 shadow-[0_10px_30px_rgba(255,122,26,0.14)]'
                            : ''
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="text-sm font-bold">
                            {t(`config.channelSetupMode.${mode}.title`)}
                          </div>
                          {feishuSetupMode === mode && (
                            <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                              {t('channelGuide.selectedBadge')}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-text-muted leading-snug mt-1">
                          {t(`config.channelSetupMode.${mode}.desc`)}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {feishuSetupMode === 'one-click' ? (
                  <div className="glass-card px-4 py-3 space-y-1.5">
                    <p className="text-sm font-bold">{t('config.feishuOneClickTitle')}</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      {t('config.feishuOneClickDesc')}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-sm font-bold">
                        {t('config.feishuAppId')}{' '}
                        <span className="text-error text-xs">{t('config.required')}</span>
                      </label>
                      <input
                        type="text"
                        placeholder="cli_xxxxxxxxxxxxx"
                        value={feishuAppId}
                        onChange={(e) => updateDraft({ feishuAppId: e.target.value })}
                        className={`w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                          feishuAppId && !feishuAppIdValid
                            ? 'border-error/50 focus:border-error'
                            : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                        }`}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-bold">
                        {t('config.feishuAppSecret')}{' '}
                        <span className="text-error text-xs">{t('config.required')}</span>
                      </label>
                      <input
                        type="password"
                        placeholder={t('config.feishuSecretHint')}
                        value={feishuAppSecret}
                        onChange={(e) => updateDraft({ feishuAppSecret: e.target.value })}
                        className={`w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                          feishuAppSecret && !feishuAppSecretValid
                            ? 'border-error/50 focus:border-error'
                            : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
                        }`}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {channelType === 'wechat' && (
              <div className="glass-card px-4 py-3 space-y-1.5">
                <p className="text-sm font-bold">{t('config.wechatOneClickTitle')}</p>
                <p className="text-xs text-text-muted leading-relaxed">
                  {t('config.wechatOneClickDesc')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 flex justify-end py-3">
        <Button
          variant="primary"
          size="lg"
          onClick={() => void handleNext()}
          disabled={!canSave || keyValidating}
        >
          {keyValidating ? t('config.keyValidating') : t('config.nextBtn')}
        </Button>
      </div>
    </div>
  )
}
