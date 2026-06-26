/**
 * DetailEmptyState — right-pane placeholder shown when a category is
 * active but no specific item is selected.
 */
import { Plus, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DetailEmptyStateProps {
  icon: LucideIcon
  title: string
  body: string
  ctaLabel: string
  onCta: () => void
  /** Optional 1–2 short tips shown under the body (each on its own row). */
  tips?: readonly string[]
}

export function DetailEmptyState({
  icon: Icon,
  title,
  body,
  ctaLabel,
  onCta,
  tips,
}: DetailEmptyStateProps) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-(--bg-key) ring-1 ring-(--color-border)">
          <Icon size={22} className="text-(--color-text-muted)" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-(--color-text)">{title}</h2>
          <p className="text-sm leading-relaxed text-(--color-text-muted)">{body}</p>
        </div>
        <Button size="sm" onClick={onCta}>
          <Plus size={12} aria-hidden="true" />
          {ctaLabel}
        </Button>
        {tips && tips.length > 0 && (
          <ul className="mt-2 w-full space-y-1.5 rounded-lg border border-(--color-border) bg-(--bg-card) p-3 text-left text-xs text-(--color-text-muted)">
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
