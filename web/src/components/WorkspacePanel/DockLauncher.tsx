/**
 * DockLauncher — what an empty review dock shows.
 *
 * The dock starts with no tabs (Git opens on demand, like any other tab),
 * so this lists what it can open, each with its shortcut, and the session's
 * goal while it has one. The tab strip's "+" menu lists the same rows
 * (``dockOpenItems``), so a tab can be opened while others are open too: on
 * a phone it is the only way to reach Git once the Plan is showing.
 */
import type { ReactNode } from 'react'
import { CalendarClock, FileText, GitCompare, Globe, ListTodo, MessageCircleQuestion, Search, Target, TerminalSquare } from 'lucide-react'

import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'

export interface DockOpenItem {
  id: string
  label: string
  icon: ReactNode
  shortcut?: string
  /** Views open as their own tabs; tools start something new. */
  group: 'view' | 'tool'
  /** A singleton tab that is already in the strip (picking it shows it). */
  open?: boolean
  run: () => void
}

/** What the dock can open; omitted handlers drop their row. */
export interface DockOpenActions {
  /** Project workspaces only: chat workspaces are not repositories. */
  onOpenGit?: () => void
  onOpenPlan?: () => void
  onOpenGoal?: () => void
  onOpenTasks?: () => void
  onOpenSideQuestions?: () => void
  onOpenSchedule?: () => void
  onOpenTerminal?: () => void
  onOpenPreview?: () => void
  onOpenFile?: () => void
}

/** The rows of the launcher and the tab strip's "+" menu, in order. */
export function dockOpenItems(os: OS, actions: DockOpenActions, openIds: ReadonlySet<string> = new Set()): DockOpenItem[] {
  const rows: DockOpenItem[] = []
  const view = (id: string, label: string, icon: ReactNode, run: (() => void) | undefined, shortcut?: string) => {
    if (run) rows.push({ id, label, icon, shortcut, group: 'view', open: openIds.has(id), run })
  }
  const tool = (id: string, label: string, icon: ReactNode, run: (() => void) | undefined, shortcut?: string) => {
    if (run) rows.push({ id, label, icon, shortcut, group: 'tool', run })
  }
  view('review', 'Git', <GitCompare size={14} aria-hidden="true" />, actions.onOpenGit, shortcutLabel(APP_SHORTCUTS.openGit, os))
  view('goal', 'Goal', <Target size={14} aria-hidden="true" />, actions.onOpenGoal)
  view('plan', 'Plan', <FileText size={14} aria-hidden="true" />, actions.onOpenPlan)
  view('tasks', 'Tasks', <ListTodo size={14} aria-hidden="true" />, actions.onOpenTasks, shortcutLabel(APP_SHORTCUTS.tasks, os))
  view('btw', 'Side questions', <MessageCircleQuestion size={14} aria-hidden="true" />, actions.onOpenSideQuestions)
  view('schedule', 'Scheduled tasks', <CalendarClock size={14} aria-hidden="true" />, actions.onOpenSchedule)
  tool('terminal', 'Terminal', <TerminalSquare size={14} aria-hidden="true" />, actions.onOpenTerminal, shortcutLabel(APP_SHORTCUTS.terminal, os))
  tool('preview', 'Preview', <Globe size={14} aria-hidden="true" />, actions.onOpenPreview)
  tool('file', 'Find file…', <Search size={14} aria-hidden="true" />, actions.onOpenFile, shortcutLabel(APP_SHORTCUTS.quickOpen, os))
  return rows
}

export function DockLauncher({ os, ...actions }: { os: OS } & Pick<DockOpenActions, 'onOpenGit' | 'onOpenGoal' | 'onOpenTerminal' | 'onOpenPreview' | 'onOpenFile'>) {
  const rows = dockOpenItems(os, actions)
  return (
    <div data-dock-launcher className="flex h-full flex-col px-4 pt-[12vh] md:items-center">
      <div role="group" aria-labelledby="dock-launcher-title" className="flex w-full max-w-64 flex-col gap-0.5">
        <h2 id="dock-launcher-title" className="mb-2 px-2 text-xs font-medium text-(--color-text-2)">
          Open in the review panel
        </h2>
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            aria-label={row.shortcut ? `${row.label} (${row.shortcut})` : row.label}
            onClick={row.run}
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-key:bg-(--bg-key) focus-visible:text-(--color-text) pointer-coarse:h-9"
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
