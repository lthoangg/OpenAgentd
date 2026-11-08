/**
 * HandledByStrip — the line above the composer of a session another
 * workspace's agent started (`sent_from`): that agent is driving it, so
 * whatever the user sends steers its work. It opens the sending session.
 */
import { Bot } from 'lucide-react'

import type { SessionSentFrom } from '@/api/types'
import { workspaceLabel } from '@/utils/workspace'

interface HandledByStripProps {
  sentFrom: SessionSentFrom | null
  onOpenSession: (sessionId: string, workspace: string) => void
}

export function HandledByStrip({ sentFrom, onOpenSession }: HandledByStripProps) {
  if (!sentFrom) return null
  const name = workspaceLabel(sentFrom.workspace)
  return (
    <div role="status" data-handled-by={sentFrom.session_id} className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-(--color-text-muted)">
      <Bot size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate">
        Handled by the agent in{' '}
        <button
          type="button"
          onClick={() => onOpenSession(sentFrom.session_id, sentFrom.workspace)}
          aria-label={`Open the session handling this, in ${name}`}
          title={sentFrom.title ? `"${sentFrom.title}" in ${sentFrom.workspace}` : sentFrom.workspace}
          className="touch-hit relative font-mono font-semibold text-(--color-text) underline-offset-2 hover:underline focus-visible:underline"
        >
          {name}
        </button>
        {sentFrom.title ? <span> · {sentFrom.title}</span> : null}
      </span>
    </div>
  )
}
