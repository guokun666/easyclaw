import { useTranslation } from 'react-i18next'
import Button from '../components/Button'
import LobsterLogo from '../components/LobsterLogo'
import type { SetupPayload } from './ConfigStep'

export default function ChannelSetupStep({
  payload,
  onDone
}: {
  payload: SetupPayload
  onDone: (botUsername?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('steps')

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8 pt-6">
      <div className="flex-1 overflow-y-auto pb-2 space-y-4">
        <div className="flex items-center gap-3">
          <LobsterLogo state="idle" size={48} />
          <div>
            <h2 className="text-lg font-extrabold">{t('setup.title')}</h2>
            <p className="text-text-muted text-xs">{t('setup.pausedDesc')}</p>
          </div>
        </div>

        <div className="glass-card px-4 py-3 space-y-1.5">
          <div className="text-sm font-bold">{t('setup.summaryTitle')}</div>
          <div className="text-xs text-text-muted leading-relaxed">
            {t(`setup.summaryChannel.${payload.channelType ?? 'telegram'}`)}
          </div>
        </div>

        <div className="glass-card px-4 py-3 space-y-2">
          <div className="text-sm font-bold">{t('setup.pausedTitle')}</div>
          <p className="text-xs text-text-muted leading-relaxed">{t('setup.pausedBody')}</p>
        </div>
      </div>

      <div className="shrink-0 flex justify-end py-3">
        <Button variant="primary" size="lg" onClick={() => onDone()}>
          {t('setup.continueBtn')}
        </Button>
      </div>
    </div>
  )
}
