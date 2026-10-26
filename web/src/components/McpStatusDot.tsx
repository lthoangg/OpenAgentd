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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const STATE_COLOR: Record<ServerStatus['state'], string> = {
  ready: 'bg-(--accent-green)',
  starting: 'bg-(--accent-orange)',
  auth_required: 'bg-(--accent-orange)',
  error: 'bg-(--color-error)',
  stopped: 'bg-(--color-text-muted)/40',
}

/** Plain words for the state; the tooltip and the screen-reader name share it. */
const STATE_LABEL: Record<ServerStatus['state'], string> = {
  ready: 'Ready',
  starting: 'Starting',
  auth_required: 'Sign-in required',
  error: 'Failed',
  stopped: 'Stopped',
}

export function McpStatusDot({ server }: { server: ServerStatus }) {
  if (server.state === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            // role="img": an aria-label on a bare span is not announced.
            <span
              role="img"
              className="flex shrink-0 items-center text-(--color-error)"
              aria-label={`${STATE_LABEL.error}: ${server.error ?? 'unknown error'}`}
            >
              <AlertCircle size={13} aria-hidden="true" />
            </span>
          }
        />
        <TooltipContent>{server.error ?? 'Server failed to start'}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            className={cn('h-2 w-2 shrink-0 rounded-full', STATE_COLOR[server.state])}
            aria-label={STATE_LABEL[server.state]}
          />
        }
      />
      <TooltipContent>{STATE_LABEL[server.state]}</TooltipContent>
    </Tooltip>
  )
}
