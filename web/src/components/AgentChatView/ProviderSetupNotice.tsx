import { AlertCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const DEFAULT_MESSAGE = 'Connect a provider once, then OpenAgentd can seed and run your default agent.'

/**
 * One notice for "chat cannot run until a provider is set up". It covers both
 * the static state (no provider configured) and a send the server rejected for
 * setup, which carries its own reason. Dismiss only clears the latter, so it is
 * offered only when something would remain dismissed.
 */
export function ProviderSetupNotice({
  setupMessage,
  hasConfiguredProvider,
  onOpenProviders,
  onDismiss,
}: {
  /** The server's reason from a rejected send, or ``null``. */
  setupMessage: string | null
  hasConfiguredProvider: boolean
  onOpenProviders: () => void
  onDismiss: () => void
}) {
  if (setupMessage === null && hasConfiguredProvider) return null
  const dismissible = setupMessage !== null && hasConfiguredProvider

  return (
    <div
      role="status"
      className="mx-3 mt-3 flex flex-col gap-3 rounded-sm border border-(--accent-blue)/35 bg-(--accent-blue-soft) p-3 text-sm text-(--color-text) sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-(--accent-blue)" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">Connect a model provider to start chatting</p>
          <p className="mt-0.5 text-xs text-(--color-text-muted)">{setupMessage ?? DEFAULT_MESSAGE}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
        <Button size="sm" onClick={onOpenProviders}>
          Open Providers
        </Button>
        {dismissible && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDismiss}
            aria-label="Dismiss provider setup notice"
          >
            <X size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  )
}
