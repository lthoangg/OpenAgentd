/**
 * Keyboard Shortcuts — every shortcut, grouped by where it works.
 *
 * Opened with ⌘/ (Ctrl+/) or from the command palette. It is one of the
 * app's overlays (``useUIStore``), so ⌘K / ⌘P / ⌘, swap it for another one.
 * Off a phone a search field, focused as it opens, filters by name, key or
 * area, and the areas flow into two columns on a wide window.
 */
import { useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'

import { AppOverlay, OVERLAY_MAX_WIDTH, OverlayHeader } from '@/components/ui/app-overlay'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW, OVERLAY_BODY, TEXT } from '@/components/ui/panel-tokens'
import { SearchBar } from '@/components/ui/search-bar'
import { useIsPhone } from '@/hooks/use-is-phone'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { shortcutHelp, type ShortcutHelpGroup } from '@/lib/keyboard/help'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/useUIStore'

/** The groups with what matches ``query``: an area's name keeps the whole area. */
function filterGroups(groups: ShortcutHelpGroup[], query: string): ShortcutHelpGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return groups
  return groups
    .map((group) => group.title.toLowerCase().includes(needle)
      ? group
      : {
          ...group,
          entries: group.entries.filter((entry) => (
            entry.label.toLowerCase().includes(needle)
            || entry.keys.some((key) => key.toLowerCase().includes(needle))
          )),
        })
    .filter((group) => group.entries.length > 0)
}

export function KeyboardShortcutsSheet() {
  const open = useUIStore((s) => s.shortcutsHelpOpen)
  const close = useUIStore((s) => s.closeShortcutsHelp)
  const { os, isTauri } = usePlatform()
  const isPhone = useIsPhone()
  const [query, setQuery] = useState('')
  const fieldRef = useRef<HTMLInputElement>(null)
  const groups = filterGroups(shortcutHelp(os, { desktopApp: isTauri }), isPhone ? '' : query)
  // The overlay switchers, spelled for this platform (Ctrl+K off a Mac).
  const switchers = [APP_SHORTCUTS.commandPalette, APP_SHORTCUTS.quickOpen, APP_SHORTCUTS.settings].map((s) => shortcutLabel(s, os))
  const onClose = () => {
    setQuery('')
    close()
  }

  return (
    <AppOverlay
      open={open}
      onClose={onClose}
      label="Keyboard shortcuts"
      maxWidth={isPhone ? OVERLAY_MAX_WIDTH.narrow : OVERLAY_MAX_WIDTH.default}
      initialFocus={isPhone ? undefined : fieldRef}
    >
      <OverlayHeader
        title="Keyboard shortcuts"
        icon={<Keyboard size={14} />}
        onClose={onClose}
        closeLabel="Close keyboard shortcuts"
      />
      <div className={cn(OVERLAY_BODY, 'space-y-6 md:space-y-8')}>
        <p className={cn('max-w-prose', TEXT.body)}>
          Escape closes whatever is on top. While a dialog is open, app shortcuts wait; {switchers[0]}, {switchers[1]} and {switchers[2]} can still switch to another overlay.
        </p>
        {!isPhone && (
          <SearchBar
            ref={fieldRef}
            aria-label="Search shortcuts"
            placeholder="Search shortcuts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {groups.length === 0 && (
          <p className={TEXT.body}>No shortcuts match "{query.trim()}"</p>
        )}
        {/* Areas flow into two columns from lg, each kept whole. */}
        <div data-shortcut-groups="" className="space-y-6 md:space-y-8 lg:columns-2 lg:gap-8 lg:space-y-0">
          {groups.map((group) => (
            <div key={group.title} className="break-inside-avoid lg:pb-8">
              <PanelSection title={group.title} flush>
                {group.entries.map((entry) => (
                  <div key={entry.label} className={COMPACT_ROW}>
                    <span className={cn('min-w-0 flex-1', TEXT.label)}>{entry.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {entry.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded-xs border border-(--color-border) bg-(--bg-key)/50 px-1.5 py-0.5 font-mono text-xs text-(--color-text-muted)"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </PanelSection>
            </div>
          ))}
        </div>
      </div>
    </AppOverlay>
  )
}
