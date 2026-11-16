// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/**
 * The phone drawer's footer: Settings, Usage and the command palette as
 * icons, the server (which takes the free width and names itself, so the
 * connection is readable at a glance), and the theme. On desktop these live
 * in the status bar (AppFooter).
 */
import { Activity, Command, Settings } from 'lucide-react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { openTelemetry } from '@/stores/useTelemetryStore'
import { HealthDot } from '@/components/HealthDot'
import { ThemeToggle } from '@/components/ThemeToggle'

export function MobileDrawerFooter({
  onMobileClose,
  onOpenPalette,
}: {
  onMobileClose?: () => void
  /** Opens the command palette; the icon hides without it. */
  onOpenPalette?: () => void
}) {
  const openSettings = useSettingsStore((s) => s.openSettings)
  return (
    <div className="flex md:hidden items-center gap-1 border-t border-(--color-border) px-2 py-1 pb-safe">
      <button
        type="button"
        onClick={() => { openSettings(); onMobileClose?.() }}
        aria-label="Settings"
        className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        <Settings size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => { openTelemetry(); onMobileClose?.() }}
        aria-label="Usage"
        className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        <Activity size={16} aria-hidden="true" />
      </button>
      {onOpenPalette && (
        <button
          type="button"
          onClick={() => { onMobileClose?.(); onOpenPalette() }}
          aria-label="Command palette"
          className="flex size-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        >
          <Command size={16} aria-hidden="true" />
        </button>
      )}
      <HealthDot labeled className="h-9 min-w-0 flex-1 justify-start px-2 text-xs" />
      <ThemeToggle collapsed className="h-9 w-9" />
    </div>
  )
}
