/**
 * PanelSection — a titled group on a panel (Settings, Scheduled tasks,
 * Session settings, …).
 *
 * The heading (and optional description and actions) sits above the card
 * rather than in a caps strip inside it, which gives each group room to
 * breathe. This is the default section style for panels and overlays; dense
 * data surfaces keep the caps-strip `SectionCard`. See DESIGN.md → Panels and
 * management surfaces.
 *
 *   <PanelSection title="Appearance" description="…" flush>
 *     <PanelRow label="Theme">…</PanelRow>
 *     <PanelRow label="Transcript">…</PanelRow>
 *   </PanelSection>
 *
 * `flush` drops the card's inner padding and divides children with hairlines,
 * for lists of `PanelRow`s or row-like content.
 */
import { type ComponentPropsWithRef, type ReactNode } from 'react'
import { SectionCard } from '@/components/ui/section-card'
import { TEXT } from '@/components/ui/panel-tokens'
import { cn } from '@/lib/utils'

interface PanelSectionProps extends Omit<ComponentPropsWithRef<'section'>, 'ref' | 'title'> {
  /** Section heading shown above the card. */
  title: string
  /** One or two sentences under the heading. */
  description?: ReactNode
  /** Controls aligned with the heading (e.g. an Add button). */
  actions?: ReactNode
  /** No inner padding; children are separated by hairlines. */
  flush?: boolean
  /** Content rendered inside the card. */
  children: ReactNode
  /** Extra class names for the card itself (e.g. an error tint). */
  className?: string
  /** Extra class names forwarded to the inner content wrapper. */
  contentClassName?: string
}

function PanelSection({
  title,
  description,
  actions,
  flush = false,
  children,
  className,
  contentClassName,
  ...props
}: PanelSectionProps) {
  // No aria-labelledby: a named region per group would add a landmark for
  // every card and make each title a second label for the field it contains.
  return (
    <section className="space-y-2 md:space-y-3" {...props}>
      {/* A bare heading centres on its actions; a described one sits on their baseline. */}
      <div className={cn('flex flex-wrap gap-x-4 gap-y-2', description ? 'items-end' : 'items-center')}>
        <div className="min-w-0 flex-1 select-none">
          <h2 className={TEXT.title}>{title}</h2>
          {description && <p className={cn('mt-1 max-w-prose', TEXT.hint)}>{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <SectionCard className={className}>
        <div
          className={cn(
            flush ? 'divide-y divide-(--color-border-subtle)' : 'px-3 py-3 md:px-4 md:py-4',
            contentClassName,
          )}
        >
          {children}
        </div>
      </SectionCard>
    </section>
  )
}

export { PanelSection }
