import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Button from './Button'

type Phase = 'form' | 'progress' | 'done' | 'error'

interface Props {
  onClose: () => void
  onSuccess: () => void
}

export default function ChannelConfigModal({ onClose, onSuccess }: Props): React.JSX.Element {
  const { t } = useTranslation('management')
  const [phase, setPhase] = useState<Phase>('form')
  const [botToken, setBotToken] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [botUsername, setBotUsername] = useState('')

  const tokenValid = botToken.trim().length >= 10

  const handleSave = async (): Promise<void> => {
    setPhase('progress')
    setErrorMsg('')
    try {
      const result = await window.electronAPI.openclaw.updateChannel('telegram', {
        botToken: botToken.trim()
      })
      if (result.success) {
        setBotUsername(result.botUsername ?? '')
        setPhase('done')
        onSuccess()
      } else {
        setErrorMsg(result.error || t('modal.errorOccurred'))
        setPhase('error')
      }
    } catch {
      setErrorMsg(t('modal.errorOccurred'))
      setPhase('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4 glass-card p-6 space-y-4 border border-glass-border shadow-2xl">
        <h3 className="text-base font-extrabold">{t('channelConfig.title')}</h3>

        {phase === 'form' && (
          <>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-text-muted">
                {t('channelConfig.botToken')}
              </label>
              <input
                type="text"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="123456:ABC-DEF..."
                className="w-full bg-bg-input rounded-xl px-4 py-2.5 text-sm outline-none border border-glass-border focus:border-primary transition-colors"
              />
              <p className="text-[11px] text-text-muted/60">{t('channelConfig.hint')}</p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={onClose}>
                {t('providerSwitch.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={!tokenValid}
              >
                {t('channelConfig.save')}
              </Button>
            </div>
          </>
        )}

        {phase === 'progress' && (
          <div className="flex items-center gap-3 py-4">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-muted">{t('channelConfig.saving')}</span>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-3">
            <p className="text-sm text-success font-semibold">{t('channelConfig.success')}</p>
            {botUsername && (
              <p className="text-xs text-text-muted">
                Bot: @{botUsername}
              </p>
            )}
            <Button variant="primary" size="sm" onClick={onClose}>
              {t('modal.close')}
            </Button>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-error font-semibold">{errorMsg}</p>
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
