import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'

/**
 * A failure in the transcript, as an error Notice (DESIGN.md → Notices):
 * a sentence-case title, one line of body, at most two buttons. Only the
 * failure a finished turn ended with carries actions; the caller decides
 * which one that is.
 */
export function ErrorCard({ title, message, onRetry, onSwitchModel }: {
  /** Omitted when the message is the whole story. */
  title?: string
  message: string
  /** Resend the latest prompt with the session's current model. */
  onRetry?: () => void
  /** Pick another model; it applies from the next message, so Retry after. */
  onSwitchModel?: () => void
}) {
  // A body that only repeats the title adds nothing.
  const body = title && message.trim() === title.trim() ? null : message
  return (
    <div className="my-2">
      <Callout
        tone="error"
        role="alert"
        title={title}
        action={(onRetry || onSwitchModel) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {onRetry && <Button size="xs" onClick={onRetry}>Retry</Button>}
            {onSwitchModel && <Button size="xs" variant="subtle" onClick={onSwitchModel}>Switch model</Button>}
          </div>
        )}
      >
        {body && <p className="break-words text-(--color-text-2)">{body}</p>}
      </Callout>
    </div>
  )
}
