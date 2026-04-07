import { useTranslation } from 'react-i18next'
import Button from '../components/Button'

export type ChannelType = 'feishu' | 'wechat' | 'telegram'

const channelEmojis: Record<ChannelType, string[]> = {
  feishu: ['🧩', '🔑', '⚙️', '🤖', '📩'],
  wechat: ['🧭', '📝', '🔐', '🧪', '🕒'],
  telegram: ['🔍', '⌨️', '✏️', '🚀', '📋']
}

export default function TelegramGuideStep({
  channelType,
  onSelectChannel,
  onSkip,
  onNext
}: {
  channelType: ChannelType
  onSelectChannel: (channel: ChannelType) => void
  onSkip?: () => void
  onNext: () => void
}): React.JSX.Element {
  const { t } = useTranslation('steps')
  const channels = t('channelGuide.channels', { returnObjects: true }) as Record<
    ChannelType,
    { title: string; desc: string; cta?: string; url?: string; note?: string }
  >
  const steps = t(`channelGuide.guides.${channelType}.steps`, { returnObjects: true }) as {
    title: string
    desc: string
  }[]
  const selectedChannel = channels[channelType]
  const emojis = channelEmojis[channelType]
  const channelCards: ChannelType[] = ['feishu', 'wechat', 'telegram']

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8">
      <div className="shrink-0">
        <div className="text-center space-y-0.5 pt-2 pb-2">
          <h2 className="text-xl font-extrabold tracking-tight">{t('channelGuide.title')}</h2>
          <p className="text-sm text-text-muted">{t('channelGuide.desc')}</p>
        </div>

        <div className="mx-auto mb-4 flex w-full max-w-2xl items-center justify-center gap-2 rounded-2xl border border-primary/20 bg-primary/8 px-4 py-2.5 text-xs">
          <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(255,122,26,0.9)]" />
          <span className="font-semibold text-text-muted">
            {t('channelGuide.currentSelection')}
          </span>
          <span className="font-bold text-primary">{selectedChannel.title}</span>
          <span className="text-text-muted/70">{t('channelGuide.clickHint')}</span>
        </div>

        <div className="grid grid-cols-3 gap-2.5 pb-3">
          {channelCards.map((channel) => (
            <button
              key={channel}
              type="button"
              onClick={() => onSelectChannel(channel)}
              aria-pressed={channelType === channel}
              className={`glass-card group relative cursor-pointer px-4 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/6 ${
                channelType === channel
                  ? 'border-primary/60 bg-primary/12 shadow-[0_10px_30px_rgba(255,122,26,0.14)]'
                  : ''
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="text-base font-bold">{channels[channel].title}</div>
                {channelType === channel && (
                  <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[11px] font-bold text-primary">
                    {t('channelGuide.selectedBadge')}
                  </span>
                )}
              </div>
              <div className="text-xs text-text-muted leading-5 mt-1">{channels[channel].desc}</div>
            </button>
          ))}
        </div>

        {selectedChannel.url && selectedChannel.cta && (
          <a
            href={selectedChannel.url}
            target="_blank"
            rel="noreferrer"
            className="block text-center text-primary text-xs font-semibold hover:text-primary-light transition-colors py-2"
          >
            {selectedChannel.cta}
          </a>
        )}

        {selectedChannel.note && (
          <p className="text-center text-xs text-warning/80 pb-2">{selectedChannel.note}</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        <div className="grid gap-2 md:grid-cols-2">
          {steps.map((s, i) => (
            <div key={i} className="glass-card p-3.5 flex gap-3 items-start min-h-[5.5rem]">
              <div className="shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-sm">
                {emojis[i]}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold">{s.title}</p>
                <p className="text-text-muted text-xs leading-5">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 flex justify-between py-3 gap-3">
        {onSkip ? (
          <Button variant="secondary" size="lg" onClick={onSkip}>
            {t('channelGuide.skipBtn')}
          </Button>
        ) : (
          <div />
        )}
        <Button variant="primary" size="lg" onClick={onNext}>
          {`${t('channelGuide.continueBtnPrefix')} ${selectedChannel.title}`}
        </Button>
      </div>
    </div>
  )
}
