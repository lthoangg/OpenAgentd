/**
 * SettingsSection — a titled group on a settings page.
 *
 * The heading (and optional description and actions) sits above the card
 * rather than in a caps strip inside it, which gives each group room to
 * breathe. Settings is the one surface that uses this variant of the section
 * card; see DESIGN.md → Settings pages.
 *
 *   <SettingsSection title="Appearance" description="…" flush>
 *     <SettingsRow label="Theme">…</SettingsRow>
 *     <SettingsRow label="Transcript">…</SettingsRow>
 *   </SettingsSection>
 *
 * `flush` drops the card's inner padding and divides children with hairlines,
 * for lists of `SettingsRow`s or row-like content.
 */
import { type ComponentPropsWithRef, type ReactNode } from 'react'
import { SectionCard } from '@/components/ui/section-card'
import { TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'

interface SettingsSectionProps extends Omit<ComponentPropsWithRef<'section'>, 'ref' | 'title'> {
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

function SettingsSection({
  title,
  description,
  actions,
  flush = false,
  children,
  className,
  contentClassName,
  ...props
}: SettingsSectionProps) {
  // No aria-labelledby: a named region per group would add a landmark for
  // every card and make each title a second label for the field it contains.
  return (
    <section className="space-y-3" {...props}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 select-none">
          <h2 className={TEXT.title}>{title}</h2>
          {description && <p className={cn('mt-1 max-w-prose', TEXT.hint)}>{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <SectionCard className={className}>
        <div
          className={cn(
            flush ? 'divide-y divide-(--color-border-subtle)' : 'px-4 py-4',
            contentClassName,
          )}
        >
          {children}
        </div>
      </SectionCard>
    </section>
  )
}

export { SettingsSection }
