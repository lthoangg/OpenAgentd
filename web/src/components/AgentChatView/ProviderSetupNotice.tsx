import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'

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
    <div className="mx-3 mt-3">
      <Callout
        tone="info"
        role="status"
        title="Connect a model provider to start chatting"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onOpenProviders}>Open Providers</Button>
            {dismissible && (
              <Button type="button" variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss provider setup notice">
                Dismiss
              </Button>
            )}
          </div>
        }
      >
        <p className="text-(--color-text-muted)">{setupMessage ?? DEFAULT_MESSAGE}</p>
      </Callout>
    </div>
  )
}
