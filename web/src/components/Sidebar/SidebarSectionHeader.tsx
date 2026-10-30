import { useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { ListFilter, Search, SquarePen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceGroup } from '@/api/types'
import type { SidebarGroupBy } from '@/stores/useSidebarViewStore'
import { SidebarViewMenu } from './SidebarViewMenu'

const ACTION_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6 pointer-coarse:size-11'

function HeaderAction({
  label,
  tooltip = label,
  active = false,
  onClick,
  buttonRef,
  pressed,
  hasPopup,
  children,
}: {
  label: string
  tooltip?: string
  active?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  buttonRef?: Ref<HTMLButtonElement>
  pressed?: boolean
  hasPopup?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            type="button"
            onClick={onClick}
            className={`${ACTION_CLASS} ${active ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted)'}`}
            aria-label={label}
            aria-pressed={pressed}
            aria-haspopup={hasPopup ? 'menu' : undefined}
            aria-expanded={hasPopup ? active : undefined}
          >
            {children}
          </button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The sessions section header: its name with Search and View options, then
 * a New session row that is always there (with ⌘N on desktop), so starting
 * a session never depends on finding a per-folder "+". Collapse all and
 * Open folder… live in View options. It stays put however long the list
 * below is.
 */
export function SidebarSectionHeader({
  groupBy,
  workspaceGroups,
  newSessionShortcut,
  searchOpen,
  searchButtonRef,
  onNewSession,
  onToggleSearch,
  onCollapseAll,
  onOpenFolder,
}: {
  groupBy: SidebarGroupBy
  /** Workspace groups for the View options filter (Workspace view). */
  workspaceGroups?: readonly WorkspaceGroup[]
  /** Shortcut hint shown on the New session row, e.g. "⌘N". */
  newSessionShortcut?: string
  searchOpen: boolean
  searchButtonRef?: Ref<HTMLButtonElement>
  onNewSession: () => void
  onToggleSearch: () => void
  onCollapseAll: () => void
  onOpenFolder: () => void
}) {
  const [viewMenuAt, setViewMenuAt] = useState<{ x: number; y: number } | null>(null)
  const project = groupBy === 'project'

  return (
    <div className="shrink-0">
      <div className="flex h-8 items-center justify-between gap-2 pl-3 pr-1.5">
        <span className="truncate text-xs font-medium text-(--color-text-muted)">
          {project ? 'Workspaces' : 'Sessions'}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderAction
            label="Search sessions"
            active={searchOpen}
            pressed={searchOpen}
            buttonRef={searchButtonRef}
            onClick={onToggleSearch}
          >
            <Search size={13} aria-hidden="true" />
          </HeaderAction>
          <HeaderAction
            label="View options"
            active={viewMenuAt !== null}
            hasPopup
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setViewMenuAt({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <ListFilter size={13} aria-hidden="true" />
          </HeaderAction>
        </div>
      </div>
      <div className="px-1.5 pb-1">
        <button
          type="button"
          onClick={onNewSession}
          aria-label="New session"
          aria-keyshortcuts={newSessionShortcut}
          className="flex h-8 w-full items-center gap-2 rounded-sm px-1.5 text-left text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring) pointer-coarse:h-11"
        >
          <SquarePen size={13} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
          <span className="flex-1">New session</span>
          {newSessionShortcut && <kbd className="font-mono text-[11px] text-(--color-text-subtle)">{newSessionShortcut}</kbd>}
        </button>
      </div>
      {viewMenuAt && (
        <SidebarViewMenu
          at={viewMenuAt}
          workspaceGroups={workspaceGroups}
          onCollapseAll={project ? onCollapseAll : undefined}
          onOpenFolder={onOpenFolder}
          onDismiss={() => setViewMenuAt(null)}
        />
      )}
    </div>
  )
}
