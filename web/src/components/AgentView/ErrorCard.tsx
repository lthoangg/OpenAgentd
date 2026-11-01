import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** How long "Copied" shows before the label returns. */
const COPIED_MS = 1500

/** A "Copy details" text action that says "Copied" for a moment. */
export function CopyDetailsButton({ text, size = 'xs' }: { text: string; size?: 'xs' | 'sm' }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      // The clipboard can be unavailable (insecure context, denied permission).
    }
  }
  return (
    <Button type="button" size={size} variant="ghost" onClick={() => void copy()}>
      {copied ? 'Copied' : 'Copy details'}
    </Button>
  )
}

/**
 * A failure in the transcript, as an error Notice (DESIGN.md → Notices):
 * a sentence-case title and one line of body. Only the failure a finished
 * turn ended with carries a way forward (Retry, Switch model, Provider
 * settings); the caller decides which one that is. Every failure can copy
 * its details, for a bug report.
 */
export function ErrorCard({ title, message, details, onRetry, onSwitchModel }: {
  /** Omitted when the message is the whole story. */
  title?: string
  message: string
  /** What Copy details copies (type, status, model…); the title and message by default. */
  details?: string
  /** Resend the latest prompt with the session's current model. */
  onRetry?: () => void
  /** Pick another model; it applies from the next message, so Retry after. */
  onSwitchModel?: () => void
}) {
  // A body that only repeats the title adds nothing.
  const body = title && message.trim() === title.trim() ? null : message
  const copyable = details ?? [title, message].filter((part, i, all) => part && all.indexOf(part) === i).join('\n')
  const hasWayForward = Boolean(onRetry || onSwitchModel)
  return (
    <div className="my-2">
      <Callout
        tone="error"
        role="alert"
        title={title}
        action={(
          <div className="flex flex-wrap items-center gap-1.5">
            {onRetry && <Button size="xs" onClick={onRetry}>Retry</Button>}
            {onSwitchModel && <Button size="xs" variant="subtle" onClick={onSwitchModel}>Switch model</Button>}
            {hasWayForward && (
              <Button type="button" size="xs" variant="ghost" onClick={() => useSettingsStore.getState().openSettings('providers')}>
                Provider settings
              </Button>
            )}
            <CopyDetailsButton text={copyable} />
          </div>
        )}
      >
        {body && <p className="break-words text-(--color-text-2)">{body}</p>}
      </Callout>
    </div>
  )
}
