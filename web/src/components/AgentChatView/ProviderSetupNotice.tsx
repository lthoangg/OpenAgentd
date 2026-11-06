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
  missingProvider = null,
  onOpenProviders,
  onChooseModel,
  onDismiss,
}: {
  /** The server's reason from a rejected send, or ``null``. */
  setupMessage: string | null
  hasConfiguredProvider: boolean
  /**
   * The session's model is set but its provider is not connected: the
   * notice names that provider rather than asking for "a model provider",
   * which read as if none were set up.
   */
  missingProvider?: { label: string; model: string } | null
  onOpenProviders: () => void
  /** Opens the run picker, the other way out when one provider is missing. */
  onChooseModel?: () => void
  onDismiss: () => void
}) {
  if (setupMessage === null && hasConfiguredProvider) return null
  const dismissible = setupMessage !== null && hasConfiguredProvider
  const named = !hasConfiguredProvider ? missingProvider : null
  const title = named ? `Connect ${named.label} to keep chatting` : 'Connect a model provider to start chatting'
  // A model reads `provider:model` in mono wherever it appears.
  const message = setupMessage ?? (named ? (
    <>This session runs <span className="font-mono">{named.model}</span>, but {named.label} is not connected. Connect it, or choose another model.</>
  ) : DEFAULT_MESSAGE)

  return (
    <div className="mx-3 mt-3">
      <Callout
        tone="info"
        role="status"
        title={title}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onOpenProviders}>Open providers</Button>
            {named && onChooseModel && (
              <Button type="button" variant="ghost" size="sm" onClick={onChooseModel}>Choose model</Button>
            )}
            {dismissible && (
              <Button type="button" variant="ghost" size="sm" onClick={onDismiss} aria-label="Dismiss provider setup notice">
                Dismiss
              </Button>
            )}
          </div>
        }
      >
        <p className="text-(--color-text-muted)">{message}</p>
      </Callout>
    </div>
  )
}
