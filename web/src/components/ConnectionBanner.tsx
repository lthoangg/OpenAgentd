/**
 * ConnectionBanner — one slim row under the header while the backend does
 * not answer (phone off Wi-Fi, sidecar restarting). The health dot alone is
 * easy to miss: on phones it lives in the drawer. It shows only once the
 * health query has failed its retries (~3 s, `useHealthQuery`), so a short
 * stream drop never flashes it, and it goes the moment health succeeds; no
 * "reconnected" message, the banner leaving is the confirmation. The global
 * event stream rechecks health on every reconnect attempt.
 *
 * A phone keeps one action, Change server (Phone system → Notices). Desktop
 * also offers the way back in place (desktop mockup 12.2): Retry checks at
 * once, and the desktop app starts its built-in server when that is the one
 * down and not running, or offers it when a remote server is down.
 */
import { lazy, Suspense, useState } from 'react'

import { Button } from '@/components/ui/button'
import { apiBaseUrl } from '@/api/base-url'
import { useIsPhone } from '@/hooks/use-is-phone'
import { formatBackendConnectionLabel, type AppBackendStatus } from '@/lib/app-backend'
import { connectBundledBackend, reloadForBackendSwitch } from '@/lib/backend-switch'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'
import { openServersScreen } from '@/stores/useServersScreenStore'

// Loaded on first open: the dialog pulls in the backend-switching machinery
// (query client, auth), which the chat view does not otherwise import. It is
// already in the main chunk through HealthDot, so this adds no request.
const AppBackendDialog = lazy(() =>
  import('@/components/AppBackendDialog').then((m) => ({ default: m.AppBackendDialog })),
)

/** The built-in server action the banner offers, if any. */
function builtinAction(status: AppBackendStatus | null): string | null {
  if (!status?.supports_bundled) return null
  if (status.external) return 'Use built-in server'
  return status.sidecar_running || status.backend_starting ? null : 'Start built-in server'
}

export function ConnectionBanner({ retry = true }: {
  /** Off while the view below has its own Retry (nothing could load). */
  retry?: boolean
} = {}) {
  const health = useHealthQuery()
  const backendStatus = useBackendStatusQuery()
  const isPhone = useIsPhone()
  // The dialog outlives the banner, so reconnecting mid-edit does not close it.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const label = formatBackendConnectionLabel(backendStatus.data ?? null, apiBaseUrl())
  const builtin = isPhone ? null : builtinAction(backendStatus.data ?? null)

  const switchToBuiltin = async () => {
    setStarting(true)
    const result = await connectBundledBackend(apiBaseUrl())
    setStarting(false)
    if (result.ok && result.reload) reloadForBackendSwitch()
    else if (!result.ok) setDialogOpen(true)
  }

  return (
    <>
      {health.isError && (
        <div
          role="alert"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-(--color-warning)/30 bg-(--color-warning-subtle) py-1 pr-2 pl-3 text-xs text-(--accent-orange-text)"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-(--color-error)" aria-hidden="true" />
          <p className="min-w-0 flex-1 truncate">
            {label === 'built-in' ? 'Server unreachable' : `Can't reach ${label}`} · Retrying…
          </p>
          {!isPhone && retry && (
            <Button type="button" size="xs" variant="ghost" onClick={() => { void health.refetch() }}>
              Retry
            </Button>
          )}
          {builtin && (
            <Button type="button" size="xs" disabled={starting} onClick={() => { void switchToBuiltin() }}>
              {builtin}
            </Button>
          )}
          <Button type="button" size="xs" onClick={() => (isPhone ? openServersScreen() : setDialogOpen(true))}>
            Change server
          </Button>
        </div>
      )}
      {dialogOpen && (
        <Suspense fallback={null}>
          <AppBackendDialog open onOpenChange={setDialogOpen} />
        </Suspense>
      )}
    </>
  )
}
