/**
 * SettingsMobileIndex — the phone landing view of Settings: a search field
 * and every section, grouped as in the desktop sidebar, each with a one-line
 * description. Tapping a row opens that section full-screen; the overlay's
 * Back button returns here. A query lists matching sections and single
 * settings instead.
 *
 * On a phone (``phone``) it reads like iOS Settings (mockup J10 10.1): a
 * large title, a quiet icon tile per row for fast scanning, and no
 * descriptions; those live on each section's own page.
 */
import { ChevronRight } from 'lucide-react'

import { PanelSection } from '@/components/ui/panel-section'
import { SETTINGS_GROUPS, type TopLevelSection } from '@/components/settings/sections'
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch } from '@/components/settings/SettingsSearch'
import type { SettingsHit } from '@/components/settings/settings-index'
import { ICON_SIZE, PAGE_BODY, ROW_PAD, TEXT } from '@/components/settings/tokens'
import { useSettingsSectionCounts, useVisibleSettingsSections } from '@/components/settings/useVisibleSections'
import { cn } from '@/lib/utils'

export function SettingsMobileIndex({
  onSelect,
  onOpenHit,
  phone = false,
}: {
  onSelect: (section: TopLevelSection) => void
  /** A search result: a section, or one setting inside it. Defaults to opening its section. */
  onOpenHit?: (hit: SettingsHit) => void
  /** iOS Settings style: large title, icon tiles, no descriptions. */
  phone?: boolean
}) {
  const sections = useVisibleSettingsSections()
  const counts = useSettingsSectionCounts()
  const search = useSettingsSearch(sections)
  const openHit = onOpenHit ?? ((hit: SettingsHit) => onSelect(hit.section))

  return (
    <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
      <div className={cn(PAGE_BODY, 'space-y-6 pt-4 pb-12')}>
        {phone && <h1 className="text-large-title font-bold text-(--color-text)">Settings</h1>}
        <SettingsSearchField search={search} onOpen={openHit} />
        {search.searching && <SettingsSearchResults search={search} onOpen={openHit} className="pt-0" />}
        {!search.searching && SETTINGS_GROUPS.map((group) => {
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
                      'flex min-h-(--phone-control) w-full items-center gap-3 text-left',
                      ROW_PAD,
                      // No hover fill: on touch it sticks after the tap.
                      'transition-colors duration-(--motion-instant) pointer-fine:hover:bg-(--bg-key)/40 active:bg-(--bg-key)/60',
                      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring)',
                    )}
                  >
                    {phone && (
                      <span
                        data-settings-tile=""
                        aria-hidden="true"
                        className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-(--bg-key) text-(--color-text-2)"
                      >
                        <item.icon size={16} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', TEXT.label)}>{item.label}</span>
                      {!phone && <span className={cn('line-clamp-2', TEXT.hint)}>{item.description}</span>}
                    </span>
                    {count !== undefined && count !== null && (
                      <span className="shrink-0 text-meta tabular-nums text-(--color-text-muted)">
                        {count}
                      </span>
                    )}
                    <ChevronRight size={ICON_SIZE} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
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
