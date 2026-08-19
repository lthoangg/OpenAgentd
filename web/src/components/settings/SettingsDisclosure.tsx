/**
 * SettingsDisclosure — a collapsible SettingsSection.
 *
 * Used by the Automation page, which groups three previously-separate settings
 * sections (chat titles, summarization, multimodal defaults). Showing all three
 * expanded at once would be a wall of controls, so each collapses to a one-line
 * summary of its current state and opens on demand.
 *
 * Kept separate from SettingsSection so the ten existing call sites keep their
 * always-open behaviour unchanged.
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { SectionCard, SectionCardHeader } from '@/components/ui/section-card'
import { cn } from '@/lib/utils'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'

interface SettingsDisclosureProps {
  /** Group heading. */
  title: string
  /** One-line state summary shown on the header row, e.g. "On - gpt-5-mini". */
  summary?: ReactNode
  /** Expanded on first render. Open by default so nothing is hidden on arrival. */
  defaultOpen?: boolean
  /** Marks the group as having unsaved edits. */
  dirty?: boolean
  children: ReactNode
}

export function SettingsDisclosure({
  title,
  summary,
  defaultOpen = true,
  dirty = false,
  children,
}: SettingsDisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <SectionCard>
      {/*
        The clickable row is nested inside SectionCardHeader rather than
        replacing it, so these groups inherit the exact header treatment
        (surface, border, uppercase tracking) used by every other settings
        card. Without this they read as a different component family.
      */}
      <SectionCardHeader
        className={cn('p-0', !open && 'border-b-0')}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className={cn(
            'flex w-full min-h-11 items-center gap-2 px-3 py-2 text-left md:min-h-8',
            'transition-colors hover:bg-(--bg-key)/40 hover:text-(--color-text)',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40',
          )}
        >
          <ChevronRight
            size={ICON_SIZE_INLINE}
            aria-hidden="true"
            className={cn(
              'shrink-0 transition-transform duration-150',
              open && 'rotate-90',
            )}
          />
          <span className="shrink-0">{title}</span>
          {summary && !open && (
            <span className={cn('min-w-0 flex-1 truncate text-right normal-case', TEXT.subtle)}>
              {summary}
            </span>
          )}
          {dirty && (
            <span
              className="ml-auto shrink-0 rounded-xs border border-(--color-border) bg-(--bg-page) px-1.5 py-0.5 text-[10px] font-semibold text-(--color-text)"
              aria-label="This group has unsaved changes"
            >
              edited
            </span>
          )}
        </button>
      </SectionCardHeader>

      {open && (
        <div id={panelId} className="px-3 py-3">
          {children}
        </div>
      )}
    </SectionCard>
  )
}
