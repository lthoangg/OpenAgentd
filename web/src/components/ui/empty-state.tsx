/**
 * EmptyState — canonical placeholder for "nothing here yet" and simple
 * error/empty panes. One primitive so blank states look identical across
 * the app (Nielsen heuristic 4 — consistency) instead of being hand-rolled
 * per feature.
 *
 * Layout: centred icon chip · title · body · optional action slot · optional
 * tips list. Pass `tone="error"` to tint the icon chip for failure states.
 *
 * Zero external deps — matches the house rule for `components/ui/`.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  body?: string
  /** Action slot (e.g. a <Button>). Rendered under the body. */
  action?: ReactNode
  /** Optional short tips, each on its own row inside a bordered card. */
  tips?: readonly string[]
  /** `error` tints the icon chip red for failure states. */
  tone?: 'muted' | 'error'
  /** Fill and centre within the parent (default). Set false to render inline. */
  fill?: boolean
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  tips,
  tone = 'muted',
  fill = true,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn(fill && 'flex h-full items-center justify-center p-10', className)}>
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-sm border',
            tone === 'error'
              ? 'border-(--color-error)/25 bg-(--color-error-subtle)'
              : 'border-(--color-border) bg-(--bg-key)',
          )}
        >
          <Icon
            size={20}
            aria-hidden="true"
            className={tone === 'error' ? 'text-(--color-error)' : 'text-(--color-text-muted)'}
          />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold text-(--color-text)">{title}</h2>
          {body && <p className="text-xs leading-relaxed text-(--color-text-muted)">{body}</p>}
        </div>
        {action}
        {tips && tips.length > 0 && (
          <ul className="mt-2 w-full space-y-1.5 rounded-sm border border-(--color-border) bg-(--bg-card) p-3 text-left text-xs text-(--color-text-muted)">
            {tips.map((tip, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
