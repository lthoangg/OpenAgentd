/**
 * ConnectionBanner — one slim row under the header while the backend does
 * not answer (phone off Wi-Fi, sidecar restarting). The health dot alone is
 * easy to miss: on phones it lives in the drawer. It shows only once the
 * health query has failed its retries (~3 s, `useHealthQuery`), so a short
 * stream drop never flashes it, and it goes the moment health succeeds; no
 * "reconnected" message, the banner leaving is the confirmation. The global
 * event stream rechecks health on every reconnect attempt.
 */
import { lazy, Suspense, useState } from 'react'

import { Button } from '@/components/ui/button'
import { apiBaseUrl } from '@/api/base-url'
import { formatBackendConnectionLabel } from '@/lib/app-backend'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'

// Loaded on first open: the dialog pulls in the backend-switching machinery
// (query client, auth), which the chat view does not otherwise import. It is
// already in the main chunk through HealthDot, so this adds no request.
const AppBackendDialog = lazy(() =>
  import('@/components/AppBackendDialog').then((m) => ({ default: m.AppBackendDialog })),
)

export function ConnectionBanner() {
  const health = useHealthQuery()
  const backendStatus = useBackendStatusQuery()
  // The dialog outlives the banner, so reconnecting mid-edit does not close it.
  const [dialogOpen, setDialogOpen] = useState(false)
  const label = formatBackendConnectionLabel(backendStatus.data ?? null, apiBaseUrl())

  return (
    <>
      {health.isError && (
        <div
          role="status"
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-(--color-warning)/30 bg-(--color-warning-subtle) py-1 pr-2 pl-3 text-xs text-(--accent-orange-text)"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-(--color-error)" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            Can't reach {label === 'builtin' ? 'the builtin backend' : <span className="font-mono">{label}</span>}. Retrying…
          </p>
          <Button type="button" size="xs" onClick={() => setDialogOpen(true)}>
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
