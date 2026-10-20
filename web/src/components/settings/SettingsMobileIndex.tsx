/**
 * SettingsMobileIndex — the phone landing view of Settings: every section,
 * grouped as in the desktop sidebar, each with a one-line description.
 * Tapping a row opens that section full-screen; the overlay's Back button
 * returns here.
 */
import { ChevronRight } from 'lucide-react'

import { SettingsSection } from '@/components/settings/SettingsSection'
import { SETTINGS_GROUPS, type TopLevelSection } from '@/components/settings/sections'
import { ICON_SIZE, PAGE_BODY, TEXT } from '@/components/settings/tokens'
import { useSettingsSectionCounts, useVisibleSettingsSections } from '@/components/settings/useVisibleSections'
import { cn } from '@/lib/utils'

export function SettingsMobileIndex({ onSelect }: { onSelect: (section: TopLevelSection) => void }) {
  const sections = useVisibleSettingsSections()
  const counts = useSettingsSectionCounts()

  return (
    <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
      <div className={cn(PAGE_BODY, 'space-y-8 pt-5 pb-12')}>
        {SETTINGS_GROUPS.map((group) => {
          const items = sections.filter((s) => s.group === group.id)
          if (items.length === 0) return null
          return (
            <SettingsSection key={group.id} title={group.label} flush>
              {items.map((item) => {
                const Icon = item.icon
                const count = counts[item.id]
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left',
                      'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40 active:bg-(--bg-key)/60',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--focus-ring)/40',
                    )}
                  >
                    <span
                      className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-key) text-(--color-text-muted)"
                      aria-hidden="true"
                    >
                      <Icon size={ICON_SIZE} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', TEXT.label)}>{item.label}</span>
                      <span className={cn('block truncate', TEXT.hint)}>{item.description}</span>
                    </span>
                    {count !== undefined && count !== null && (
                      <span className="shrink-0 rounded-full bg-(--bg-key) px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-(--color-text-subtle)">
                        {count}
                      </span>
                    )}
                    <ChevronRight size={ICON_SIZE} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                  </button>
                )
              })}
            </SettingsSection>
          )
        })}
      </div>
    </nav>
  )
}
