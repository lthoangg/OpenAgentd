/**
 * SettingsMobileIndex — the phone landing view of Settings: every section,
 * grouped as in the desktop sidebar, each with a one-line description.
 * Tapping a row opens that section full-screen; the overlay's Back button
 * returns here.
 */
import { ChevronRight } from 'lucide-react'

import { PanelSection } from '@/components/ui/panel-section'
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
            <PanelSection key={group.id} title={group.label} flush>
              {items.map((item) => {
                const count = counts[item.id]
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={cn(
                      'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left',
                      'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40 active:bg-(--bg-key)/60',
                      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', TEXT.label)}>{item.label}</span>
                      <span className={cn('line-clamp-2', TEXT.hint)}>{item.description}</span>
                    </span>
                    {count !== undefined && count !== null && (
                      <span className="shrink-0 text-[11px] tabular-nums text-(--color-text-subtle)">
                        {count}
                      </span>
                    )}
                    <ChevronRight size={ICON_SIZE} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
                  </button>
                )
              })}
            </PanelSection>
          )
        })}
      </div>
    </nav>
  )
}
