import { TokenMeter } from '@/components/ui/token-meter'
import type { AgentStream } from '@/stores/useTeamStore'

interface TeamStatusBarProps {
  sessionId: string | null
  leadName?: string | null
  isWorking?: boolean
  agentStreams: Record<string, AgentStream>
  error?: string | null
}

function StatusDot({ status }: { status: string }) {
  const colorClass =
    status === 'working'
      ? 'bg-(--color-accent)'
      : status === 'error'
        ? 'bg-(--color-error)'
        : status === 'offline'
          ? 'bg-(--color-text-subtle) opacity-50'
        : 'bg-(--color-success)'
  return (
    <span
      aria-label={`Agent status: ${status}`}
      className={`inline-block h-1.5 w-1.5 rounded-full ${colorClass}`}
    />
  )
}

export function TeamStatusBar({
  sessionId,
  leadName,
  isWorking,
  agentStreams,
  error,
}: TeamStatusBarProps) {
  const leadStream = leadName ? agentStreams[leadName] : undefined

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-(--color-border) bg-(--bg-page) px-3 py-1 text-xs text-(--color-text-muted) sm:px-4">
      {/* Left */}
      <div className="flex min-w-0 items-center gap-2">
        {sessionId && (
          <span className="font-mono text-(--color-text-muted)">
            {sessionId.slice(0, 8)}
          </span>
        )}
        {leadName && (
          <span className="text-(--color-text-muted)">lead: {leadName}</span>
        )}
        {isWorking && (
          <span className="flex items-center gap-1 text-(--color-text-2)">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-accent)" />
            working
          </span>
        )}
      </div>

      {/* Center: error */}
      {error && (
        <span className="max-w-xs truncate text-(--color-error)">
          {error}
        </span>
      )}

      {/* Right: lead usage + agent pills */}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {leadStream && leadStream.usage.totalTokens > 0 && (
          <TokenMeter
            input={leadStream.usage.promptTokens}
            output={leadStream.usage.completionTokens}
            cached={leadStream.usage.cachedTokens}
            className="mr-0.5"
          />
        )}
        {Object.entries(agentStreams).map(([name, stream]) => (
          <div
            key={name}
            className="flex items-center gap-1 rounded-md bg-(--bg-key) px-1.5 py-0.5"
          >
            <StatusDot status={stream.status} />
            <span className="text-(--color-text-2)">{name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
