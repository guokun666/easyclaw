import Button from './Button'

interface AiRepairApprovalAction {
  label: string
  reason: string
  effect: string
  commandPreview: string
  commandRuntime: string
  approval: 'auto' | 'confirm'
}

interface AiRepairApprovalModalProps {
  title: string
  description: string
  summaryLabel: string
  actionLabel: string
  commandLabel: string
  runtimeLabel: string
  effectLabel: string
  cancelLabel: string
  confirmLabel: string
  summary: string
  actions: AiRepairApprovalAction[]
  onClose: () => void
  onConfirm: () => void
  confirming?: boolean
}

export default function AiRepairApprovalModal({
  title,
  description,
  summaryLabel,
  actionLabel,
  commandLabel,
  runtimeLabel,
  effectLabel,
  cancelLabel,
  confirmLabel,
  summary,
  actions,
  onClose,
  onConfirm,
  confirming = false
}: AiRepairApprovalModalProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-card mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="border-b border-white/10 px-6 py-5">
          <h3 className="text-lg font-black">{title}</h3>
          <p className="mt-1 text-sm text-text-muted">{description}</p>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-text-muted/70">
              {summaryLabel}
            </div>
            <p className="mt-2 text-sm leading-6 text-text">{summary}</p>
          </section>

          <div className="space-y-3">
            {actions.map((action) => (
              <section
                key={`${action.label}:${action.commandPreview}`}
                className="rounded-2xl border border-white/10 bg-black/10 px-4 py-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-bold text-text">{action.label}</div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${
                      action.approval === 'confirm'
                        ? 'border border-warning/35 bg-warning/12 text-warning'
                        : 'border border-primary/30 bg-primary/12 text-primary'
                    }`}
                  >
                    {action.approval === 'confirm' ? '需确认' : '白名单'}
                  </span>
                </div>

                <div className="mt-3 space-y-3">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted/65">
                      {actionLabel}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-text-muted">{action.reason}</p>
                  </div>

                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted/65">
                      {commandLabel}
                    </div>
                    <code className="mt-1 block rounded-xl border border-white/10 bg-[#0b1220] px-3 py-2 text-xs text-primary">
                      {action.commandPreview}
                    </code>
                    <p className="mt-1.5 text-[11px] leading-5 text-text-muted/75">
                      {runtimeLabel} {action.commandRuntime}
                    </p>
                  </div>

                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-text-muted/65">
                      {effectLabel}
                    </div>
                    <p className="mt-1 text-sm leading-6 text-text-muted">{action.effect}</p>
                  </div>
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-white/10 px-6 py-4">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={confirming}>
            {cancelLabel}
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm} loading={confirming}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
