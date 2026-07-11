import { useState } from 'react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { useHealthQuery } from '@/queries/useHealthQuery'

/**
 * Small connected/disconnected indicator dot.
 * - Green when connected
 * - Red when error
 * - Pulsing gray during initial load
 */
export function HealthDot() {
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

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="flex h-11 w-11 items-center justify-center rounded-md transition-colors hover:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) md:h-8 md:w-8"
        title={label}
        aria-label={label}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${bgColor} ${pulseClass}`} aria-hidden="true" />
      </button>
      <AppBackendDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
