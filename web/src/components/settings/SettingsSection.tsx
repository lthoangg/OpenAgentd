/**
 * SettingsSection — the recurring card+header pattern across all settings pages.
 *
 * Replaces the hand-rolled:
 *   <section className="rounded-md border border-(--color-border) bg-(--bg-card) p-4">
 *     <h2 className="text-xs font-semibold uppercase tracking-wider ...">Title</h2>
 *     …content…
 *   </section>
 *
 * Renders as a SectionCard so the visual language is consistent with
 * AppBackendDialog, AgentForm, McpServerForm etc.
 *
 * Usage:
 *   <SettingsSection title="Status">
 *     …rows / form fields…
 *   </SettingsSection>
 */
import { type ComponentPropsWithRef, type ReactNode } from 'react'
import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { cn } from '@/lib/utils'

interface SettingsSectionProps extends Omit<ComponentPropsWithRef<'section'>, 'ref'> {
  /** Section heading — displayed in the `SectionCardHeader` strip. */
  title: string
  /** Optional description appended inline to the header label. */
  description?: string
  /** Content rendered below the header. */
  children: ReactNode
  /** Extra class names forwarded to the inner content wrapper. */
  contentClassName?: string
}

function SettingsSection({
  title,
  description,
  children,
  className,
  contentClassName,
  ...props
}: SettingsSectionProps) {
  const headerLabel = description ? `${title} — ${description}` : title
  return (
    <SectionCard className={className} {...props}>
      <SectionCardHeader>{headerLabel}</SectionCardHeader>
      <div className={cn('px-3 py-3', contentClassName)}>
        {children}
      </div>
    </SectionCard>
  )
}

export { SettingsSection }
