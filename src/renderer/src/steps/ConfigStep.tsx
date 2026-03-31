import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import LobsterLogo from '../components/LobsterLogo'
import Button from '../components/Button'
import type { Provider } from '../constants/providers'
import type { ChannelType } from './TelegramGuideStep'

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
type ChannelSetupMode = 'one-click' | 'manual'

export interface SetupPayload {
  provider: Provider
  apiKey?: string
  authMethod?: 'api-key' | 'oauth'
  channelType?: 'feishu' | 'wechat' | 'telegram'
  channelSetupMode?: 'one-click' | 'manual'
  telegramBotToken?: string
  feishuAppId?: string
  feishuAppSecret?: string
  modelId?: string
}

interface Props {
  provider: Provider
  authMethod?: 'api-key' | 'oauth'
  modelId?: string
  channelType: ChannelType
  onNext: (payload: SetupPayload) => void
}

export default function ConfigStep({
  provider,
  authMethod,
  modelId,
  channelType,
  onNext
}: Props): React.JSX.Element {
  const { t } = useTranslation(['steps', 'common'])
  const { t: tp } = useTranslation('providers')
  const [apiKey, setApiKey] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [feishuSetupMode, setFeishuSetupMode] = useState<ChannelSetupMode>('one-click')
  const [feishuAppId, setFeishuAppId] = useState('')
  const [feishuAppSecret, setFeishuAppSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oauthDone, setOauthDone] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [keyValidating, setKeyValidating] = useState(false)
  const [validatedApiKey, setValidatedApiKey] = useState<string | null>(null)
  const isOAuth = authMethod === 'oauth'
  const isOllama = provider === 'ollama'
  const needsPreValidation =
    (provider === 'modelfamily' || provider === 'openai' || provider === 'anthropic') &&
    !isOAuth &&
    !isOllama

  const pattern = providerPatterns[provider]
  const label =
    provider === 'modelfamily' ? 'Model Family API Key' : t(`config.apiKeyLabel.${provider}`)
  const placeholder = tp(`apiKeyPlaceholder.${provider}`, providerPlaceholders[provider])
  const apiKeyValid = pattern.test(apiKey)
  const telegramBotTokenValid = TELEGRAM_BOT_TOKEN_PATTERN.test(telegramBotToken)
  const feishuAppIdValid = FEISHU_APP_ID_PATTERN.test(feishuAppId)
  const feishuAppSecretValid = GENERIC_APP_SECRET_PATTERN.test(feishuAppSecret)
  const channelValid =
    channelType === 'telegram'
      ? telegramBotTokenValid
      : channelType === 'feishu'
        ? feishuSetupMode === 'one-click' || (feishuAppIdValid && feishuAppSecretValid)
        : true
  const canSave = isOAuth
    ? oauthDone && channelValid
    : isOllama
      ? channelValid
      : apiKeyValid && channelValid

  const handleOAuthLogin = async (): Promise<void> => {
    setOauthLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.oauth.loginCodex()
      if (result.success) {
        setOauthDone(true)
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
      setKeyValidating(true)
      try {
        const result = await window.electronAPI.config.validateApiKey({
          provider,
          apiKey,
          authMethod: authMethod ?? 'api-key',
          modelId
        })

        if (!result.success) {
          setValidatedApiKey(null)
          setError(result.error ?? t('config.keyValidationFailed'))
          return
        }

        setValidatedApiKey(apiKey)
      } catch (err) {
        setValidatedApiKey(null)
        setError(err instanceof Error ? err.message : t('common:error.unknown'))
        return
      } finally {
        setKeyValidating(false)
      }
    }

    onNext({
      provider,
      ...(isOAuth || isOllama ? {} : { apiKey }),
      authMethod: authMethod ?? 'api-key',
      channelType,
      channelSetupMode:
        channelType === 'feishu'
          ? feishuSetupMode
          : channelType === 'wechat'
            ? 'one-click'
            : 'manual',
      telegramBotToken: telegramBotToken || undefined,
      feishuAppId: feishuAppId || undefined,
      feishuAppSecret: feishuAppSecret || undefined,
      modelId
    })
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8 pt-6">
      <div className="flex-1 overflow-y-auto pb-2 space-y-4">
        <div className="flex items-center gap-3">
          <LobsterLogo state={oauthLoading ? 'loading' : 'idle'} size={48} />
          <div>
            <h2 className="text-lg font-extrabold">{t('config.title')}</h2>
            <p className="text-text-muted text-xs">{t('config.desc')}</p>
          </div>
        </div>

        {error && <p className="text-error text-xs font-medium">{error}</p>}

        {isOllama ? (
          <div className="space-y-1.5">
            <label className="text-sm font-bold">Ollama</label>
            <p className="text-xs text-text-muted">{t('config.ollamaInfo')}</p>
          </div>
        ) : isOAuth ? (
          <div className="space-y-1.5">
            <label className="text-sm font-bold">OpenAI {t('apiKeyGuide.authMethod.oauth')}</label>
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
                <span className="text-sm font-medium text-success">{t('config.oauthSuccess')}</span>
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
            <label className="text-sm font-bold">
              {label} <span className="text-error text-xs">{t('config.required')}</span>
            </label>
            <input
              type="password"
              placeholder={placeholder}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setValidatedApiKey(null)
              }}
              className={`w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm font-mono outline-none border transition-all duration-200 placeholder:text-text-muted/30 ${
                apiKey && !apiKeyValid
                  ? 'border-error/50 focus:border-error'
                  : 'border-glass-border focus:border-primary focus:shadow-[0_0_0_3px_var(--color-primary-glow)]'
              }`}
            />
            {needsPreValidation && validatedApiKey === apiKey && apiKeyValid && (
              <p className="text-success text-[11px] font-medium">{t('config.keyValidated')}</p>
            )}
          </div>
        )}

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
                onChange={(e) => setTelegramBotToken(e.target.value)}
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
                <label className="text-sm font-bold">{t('config.channelSetupModeLabel')}</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['one-click', 'manual'] as ChannelSetupMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setFeishuSetupMode(mode)}
                      className={`glass-card px-3 py-2 text-left transition-all ${
                        feishuSetupMode === mode ? 'border-primary/50 bg-primary/10' : ''
                      }`}
                    >
                      <div className="text-sm font-bold">
                        {t(`config.channelSetupMode.${mode}.title`)}
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
                      onChange={(e) => setFeishuAppId(e.target.value)}
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
                      onChange={(e) => setFeishuAppSecret(e.target.value)}
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
