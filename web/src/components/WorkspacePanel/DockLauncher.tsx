/**
 * DockLauncher — what an empty review dock shows.
 *
 * The dock starts with no tabs (Git opens on demand, like any other tab),
 * so this lists what it can open, each with its shortcut.
 */
import type { ReactNode } from 'react'
import { GitCompare, Globe, Search, TerminalSquare } from 'lucide-react'

import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'

interface LauncherRow {
  label: string
  icon: ReactNode
  shortcut?: string
  run: () => void
}

export function DockLauncher({ os, onOpenGit, onOpenTerminal, onOpenPreview, onOpenFile }: {
  os: OS
  /** Project workspaces only: chat workspaces are not repositories. */
  onOpenGit?: () => void
  onOpenTerminal?: () => void
  onOpenPreview?: () => void
  onOpenFile?: () => void
}) {
  const rows: LauncherRow[] = []
  if (onOpenGit) rows.push({ label: 'Git', icon: <GitCompare size={14} aria-hidden="true" />, shortcut: shortcutLabel(APP_SHORTCUTS.openGit, os), run: onOpenGit })
  if (onOpenTerminal) rows.push({ label: 'Terminal', icon: <TerminalSquare size={14} aria-hidden="true" />, shortcut: shortcutLabel(APP_SHORTCUTS.terminal, os), run: onOpenTerminal })
  if (onOpenPreview) rows.push({ label: 'Preview', icon: <Globe size={14} aria-hidden="true" />, run: onOpenPreview })
  if (onOpenFile) rows.push({ label: 'Open File', icon: <Search size={14} aria-hidden="true" />, shortcut: shortcutLabel(APP_SHORTCUTS.quickOpen, os), run: onOpenFile })
  return (
    <div data-dock-launcher className="flex h-full items-center justify-center px-4">
      <div role="group" aria-label="Open in the dock" className="flex w-full max-w-60 flex-col gap-0.5">
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            aria-label={row.shortcut ? `${row.label} (${row.shortcut})` : row.label}
            onClick={row.run}
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:bg-(--bg-key) focus-visible:text-(--color-text) pointer-coarse:h-11"
          >
            {row.icon}
            <span className="flex-1">{row.label}</span>
            {row.shortcut && (
              // Phones have no keyboard to press it with.
              <kbd aria-hidden="true" className="hidden font-mono text-[11px] text-(--color-text-subtle) md:inline">{row.shortcut}</kbd>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
