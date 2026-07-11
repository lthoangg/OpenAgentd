/**
 * DetailEmptyState — right-pane placeholder shown when a category is
 * active but no specific item is selected.
 */
import { Plus, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

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
  icon,
  title,
  body,
  ctaLabel,
  onCta,
  tips,
}: DetailEmptyStateProps) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      body={body}
      tips={tips}
      action={
        <Button size="sm" className="min-h-11 md:min-h-0" onClick={onCta}>
          <Plus size={12} aria-hidden="true" />
          {ctaLabel}
        </Button>
      }
    />
  )
}
