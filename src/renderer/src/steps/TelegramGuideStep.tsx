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

  return (
    <div className="flex-1 flex flex-col min-h-0 px-8">
      <div className="flex-1">
        <div className="text-center space-y-0.5 pt-2 pb-1">
          <h2 className="text-lg font-extrabold">{t('channelGuide.title')}</h2>
          <p className="text-text-muted text-xs">{t('channelGuide.desc')}</p>
        </div>

        <div className="grid grid-cols-3 gap-2 pb-3">
          {(['feishu', 'wechat', 'telegram'] as ChannelType[]).map((channel) => (
            <button
              key={channel}
              type="button"
              onClick={() => onSelectChannel(channel)}
              className={`glass-card px-3 py-2 text-left transition-all ${
                channelType === channel ? 'border-primary/50 bg-primary/10' : ''
              }`}
            >
              <div className="text-sm font-bold">{channels[channel].title}</div>
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
          {t('channelGuide.readyBtn')}
        </Button>
      </div>
    </div>
  )
}
