/**
 * NoticeLine — one line in the notices column (the update, the TypeScript
 * tools prompt): what it is, then at most two buttons. It does not move,
 * minimize or expand; a failure it runs into goes to a toast.
 *
 * On a narrow phone the buttons drop under the text rather than squeezing it.
 */
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

export function NoticeLine({ text, detail, busy = false, children, ...rest }: {
  text: string
  /** Hover detail for the text (a path, versions): never the only place something is said. */
  detail?: string
  /** A spinner before the text while the app works and there is nothing to press. */
  busy?: boolean
  /** The buttons, quiet one first. */
  children?: ReactNode
  'aria-label'?: string
}) {
  return (
    <div
      role="status"
      data-swipe-ignore
      className="pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1 rounded-sm border border-(--color-border) bg-(--bg-card) py-1.5 pr-1.5 pl-3 text-sm text-(--color-text) shadow-(--shadow-depth)"
      {...rest}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 py-0.5 font-medium" title={detail}>
        {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-(--color-text-muted)" aria-hidden="true" />}
        <span className="min-w-0">{text}</span>
      </span>
      {children && <span className="flex shrink-0 items-center gap-1">{children}</span>}
    </div>
  )
}
