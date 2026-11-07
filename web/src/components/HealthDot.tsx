import { useState } from 'react'

import { AppBackendDialog } from '@/components/LazyAppBackendDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'
import { formatBackendConnectionLabel } from '@/lib/app-backend'
import { apiBaseUrl } from '@/api/base-url'
import { cn } from '@/lib/utils'

/**
 * The connected server, as a dot plus its name (`built-in`, a saved server's
 * name, or its host). The dot is green when connected, red on error and grey
 * while connecting; the tooltip says the same in words, with the address and
 * the server's version.
 */
export function HealthDot({
  className,
  labeled = false,
  chip = false,
}: {
  className?: string
  /** When true, render the connected backend name next to the dot. */
  labeled?: boolean
  /**
   * With ``labeled``: a 32px pill on the keycap wash in the phone's text
   * size, as the Sessions screen's top bar draws the server (the bar is 44px,
   * and ``touch-hit`` grows the target to match). ``className`` cannot do
   * this: ``cn`` does not merge, so it would fight the footer's classes.
   */
  chip?: boolean
} = {}) {
  const health = useHealthQuery()
  const backendStatus = useBackendStatusQuery()
  const [dialogOpen, setDialogOpen] = useState(false)
  const connectionLabel = formatBackendConnectionLabel(backendStatus.data ?? null, apiBaseUrl())

  let bgColor = 'bg-(--color-text-muted)'

  if (health.isSuccess) {
    bgColor = 'bg-(--accent-green-text)'
  } else if (health.isError) {
    bgColor = 'bg-(--color-error)'
  }

  const state = health.isSuccess ? 'connected' : health.isError ? 'not reachable' : 'connecting…'
  const serverName = connectionLabel === 'built-in' ? 'Built-in server' : connectionLabel
  const address = backendStatus.data?.base_url || apiBaseUrl()
  const version = health.data?.version
  const status = health.isSuccess
    ? 'Connected. Change server'
    : health.isError
      ? 'Server not reachable. Change server'
      : 'Connecting. Change server'
  // A bare dot (the phone drawer) has no visible name, so the label carries it.
  const label = labeled ? status : `${serverName}. ${status}`

  const defaultClasses = labeled && chip
    ? 'touch-hit relative flex h-8 max-w-full items-center gap-2 rounded-full bg-(--bg-key) px-3 text-subhead text-(--color-text-2) transition-colors hover:bg-(--color-fill-key-hover) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)'
    : labeled
      ? 'flex h-5 items-center gap-1.5 rounded-sm px-1.5 font-mono text-xs md:text-meta text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)'
      : 'flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:h-8 md:w-8'

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className={cn(defaultClasses, className)}
              aria-label={label}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bgColor}`} aria-hidden="true" />
              {labeled ? <span className="min-w-0 truncate">{connectionLabel}</span> : null}
              {/* The status bar says it in words too: a red dot alone was easy
                  to miss (desktop mockup 12.1). The companions' word. */}
              {labeled && !chip && health.isError ? (
                <span className="shrink-0 font-sans text-(--color-error)">Can't reach</span>
              ) : null}
            </button>
          }
        />
        <TooltipContent>
          <span className="block">{`${serverName} · ${state}`}</span>
          <span className="block font-mono text-(--color-text-muted)">{version ? `${address} · v${version}` : address}</span>
        </TooltipContent>
      </Tooltip>
      <AppBackendDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
