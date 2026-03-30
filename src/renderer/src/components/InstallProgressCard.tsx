export default function InstallProgressCard({
  status
}: {
  status: { percent: number; stage: string; detail?: string } | null
}): React.JSX.Element | null {
  if (!status) return null

  return (
    <div className="glass-card w-full p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold truncate">{status.stage}</div>
          {status.detail && <div className="text-xs text-text-muted truncate">{status.detail}</div>}
        </div>
        <span className="text-xs font-mono text-primary shrink-0">{status.percent}%</span>
      </div>

      <div className="h-2 rounded-full bg-white/8 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary to-primary-hover transition-all duration-300"
          style={{ width: `${status.percent}%` }}
        />
      </div>
    </div>
  )
}
