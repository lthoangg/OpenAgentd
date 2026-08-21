import { useState } from 'react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHealthQuery } from '@/queries/useHealthQuery'
import { cn } from '@/lib/utils'

/**
 * Small connected/disconnected indicator dot.
 * - Green when connected
 * - Red when error
 * - Pulsing gray during initial load
 */
export function HealthDot({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
} = {}) {
  const health = useHealthQuery()
  const [dialogOpen, setDialogOpen] = useState(false)

  let bgColor = 'bg-(--color-text-muted)'
  let pulseClass = 'animate-pulse'

  if (health.isSuccess) {
    bgColor = 'bg-(--color-success)'
    pulseClass = ''
  } else if (health.isError) {
    bgColor = 'bg-(--color-error)'
    pulseClass = ''
  }

  const label = health.isSuccess
    ? 'Connected — change backend connection'
    : health.isError
      ? 'Backend error — change backend connection'
      : 'Connecting — change backend connection'

  const defaultClasses = children
    ? 'flex h-5 items-center gap-1.5 rounded-xs px-1.5 font-mono text-[10.5px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)'
    : 'flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:h-8 md:w-8'

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
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bgColor} ${pulseClass}`} aria-hidden="true" />
              {children}
            </button>
          }
        />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <AppBackendDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
