/**
 * McpStatusDot — the one visual mapping from MCP server state to a colour.
 *
 * Shared by the Settings → MCP list and the session settings MCP section so
 * the same server never reads as two different colours depending on which
 * surface you opened. `error` swaps the dot for an alert glyph because colour
 * alone shouldn't carry a failure signal (WCAG 1.4.1).
 */
import { AlertCircle } from 'lucide-react'

import { type ServerStatus } from '@/api/client'
import { cn } from '@/lib/utils'

const STATE_COLOR: Record<ServerStatus['state'], string> = {
  ready: 'bg-(--accent-green)',
  starting: 'bg-(--accent-orange)',
  auth_required: 'bg-(--accent-orange)',
  error: 'bg-(--color-error)',
  stopped: 'bg-(--color-text-muted)/40',
}

export function McpStatusDot({ server }: { server: ServerStatus }) {
  if (server.state === 'error') {
    return (
      <span
        className="flex shrink-0 items-center text-(--color-error)"
        title={server.error ?? 'Server failed to start'}
        aria-label={`Error: ${server.error ?? 'unknown'}`}
      >
        <AlertCircle size={13} />
      </span>
    )
  }
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', STATE_COLOR[server.state])}
      title={server.state}
      aria-label={`State: ${server.state}`}
    />
  )
}
