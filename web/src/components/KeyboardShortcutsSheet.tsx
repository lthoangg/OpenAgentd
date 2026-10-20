/**
 * Keyboard Shortcuts — every shortcut, grouped by where it works.
 *
 * Opened with ⌘/ (Ctrl+/) or from the command palette. It is one of the
 * app's overlays (``useUIStore``), so ⌘K / ⌘P / ⌘, swap it for another one.
 */
import { Keyboard } from 'lucide-react'

import { AppOverlay, OverlayHeader } from '@/components/ui/app-overlay'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW, OVERLAY_BODY, TEXT } from '@/components/ui/panel-tokens'
import { usePlatform } from '@/hooks/use-platform'
import { shortcutHelp } from '@/lib/keyboard/help'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/useUIStore'

export function KeyboardShortcutsSheet() {
  const open = useUIStore((s) => s.shortcutsHelpOpen)
  const close = useUIStore((s) => s.closeShortcutsHelp)
  const { os, isTauri } = usePlatform()

  return (
    <AppOverlay open={open} onClose={close} label="Keyboard shortcuts" maxWidth="640px">
      <OverlayHeader
        title="Keyboard shortcuts"
        icon={<Keyboard size={14} />}
        onClose={close}
        closeLabel="Close keyboard shortcuts"
      />
      <div className={cn(OVERLAY_BODY, 'space-y-8')}>
        <p className={cn('max-w-prose', TEXT.body)}>
          Escape closes whatever is on top. While a dialog is open, app shortcuts wait; ⌘K, ⌘P and ⌘, can still switch to another overlay.
        </p>
        {shortcutHelp(os, { desktopApp: isTauri }).map((group) => (
          <PanelSection key={group.title} title={group.title} flush>
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
        ))}
      </div>
    </AppOverlay>
  )
}
