import { formatTokens } from '@/utils/format'
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

      {/* Right: agent pills */}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {Object.entries(agentStreams).map(([name, stream]) => (
          <div
            key={name}
            className="flex items-center gap-1 rounded-md bg-(--bg-key) px-1.5 py-0.5"
          >
            <StatusDot status={stream.status} />
            <span className="text-(--color-text-2)">{name}</span>
            {stream.usage.totalTokens > 0 && (
              <span
                className="flex h-5 min-w-5 items-center justify-center rounded-full bg-(--bg-page) px-1 font-mono text-[10px] text-(--color-text)"
                title={`Input: ${stream.usage.promptTokens.toLocaleString()} · Output: ${stream.usage.completionTokens.toLocaleString()} · Cache: ${stream.usage.cachedTokens.toLocaleString()}`}
              >
                {formatTokens(stream.usage.promptTokens)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
