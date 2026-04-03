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
  onNext
}: {
  channelType: ChannelType
  onSelectChannel: (channel: ChannelType) => void
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
      <div className="flex-1">
        <div className="text-center space-y-0.5 pt-2 pb-1">
          <h2 className="text-lg font-extrabold">{t('channelGuide.title')}</h2>
          <p className="text-text-muted text-xs">{t('channelGuide.desc')}</p>
        </div>

        <div className="mx-auto mb-3 flex w-full max-w-xl items-center justify-center gap-2 rounded-2xl border border-primary/20 bg-primary/8 px-4 py-2 text-xs">
          <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_rgba(255,122,26,0.9)]" />
          <span className="font-semibold text-text-muted">{t('channelGuide.currentSelection')}</span>
          <span className="font-bold text-primary">{selectedChannel.title}</span>
          <span className="text-text-muted/70">{t('channelGuide.clickHint')}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 pb-3">
          {channelCards.map((channel) => (
            <button
              key={channel}
              type="button"
              onClick={() => onSelectChannel(channel)}
              aria-pressed={channelType === channel}
              className={`glass-card group relative cursor-pointer px-3 py-2 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-white/6 ${
                channelType === channel
                  ? 'border-primary/60 bg-primary/12 shadow-[0_10px_30px_rgba(255,122,26,0.14)]'
                  : ''
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="text-sm font-bold">{channels[channel].title}</div>
                {channelType === channel && (
                  <span className="rounded-full border border-primary/35 bg-primary/14 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {t('channelGuide.selectedBadge')}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-text-muted leading-snug mt-1">
                {channels[channel].desc}
              </div>
            </button>
          ))}
        </div>

        {selectedChannel.url && selectedChannel.cta && (
          <a
            href={selectedChannel.url}
            target="_blank"
            rel="noreferrer"
            className="block text-center text-primary text-xs font-semibold hover:text-primary-light transition-colors py-1.5"
          >
            {selectedChannel.cta}
          </a>
        )}

        {selectedChannel.note && (
          <p className="text-center text-[11px] text-warning/80 pb-2">{selectedChannel.note}</p>
        )}

        <div className="space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="glass-card p-2 flex gap-2 items-start">
              <div className="shrink-0 w-6 h-6 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs">
                {emojis[i]}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold">{s.title}</p>
                <p className="text-text-muted text-[11px] leading-snug">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="shrink-0 flex justify-end py-3">
        <Button variant="primary" size="lg" onClick={onNext}>
          {`${t('channelGuide.continueBtnPrefix')} ${selectedChannel.title}`}
        </Button>
      </div>
    </div>
  )
}
