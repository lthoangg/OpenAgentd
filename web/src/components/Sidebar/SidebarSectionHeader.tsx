import { useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { ChevronsDownUp, FolderPlus, ListFilter, Search, SquarePen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SidebarGroupBy } from '@/stores/useSidebarViewStore'
import { SidebarViewMenu } from './SidebarViewMenu'

const ACTION_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text) md:h-6 md:w-6 pointer-coarse:size-9'

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
 * The sessions section header: its name, then New session (when the list
 * has no per-folder "+": the flat views, and every view on phones, which
 * have no ⌘N), Search, View options, Collapse all (the folder tree only)
 * and Open folder. It stays put however long the list below is.
 */
export function SidebarSectionHeader({
  groupBy,
  showNewSession,
  newSessionShortcut,
  searchOpen,
  searchButtonRef,
  onNewSession,
  onToggleSearch,
  onCollapseAll,
  onOpenFolder,
}: {
  groupBy: SidebarGroupBy
  showNewSession: boolean
  /** Shortcut hint for the New session tooltip, e.g. "⌘N". */
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
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 pl-3 pr-1.5">
      <span className="truncate label-caps leading-none text-(--color-text-subtle)">
        {project ? 'Workspaces' : 'Sessions'}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        {showNewSession && (
          <HeaderAction
            label="New session"
            tooltip={newSessionShortcut ? `New session (${newSessionShortcut})` : 'New session'}
            onClick={onNewSession}
          >
            <SquarePen size={13} aria-hidden="true" />
          </HeaderAction>
        )}
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
        {project && (
          <HeaderAction label="Collapse all workspaces" tooltip="Collapse all" onClick={onCollapseAll}>
            <ChevronsDownUp size={13} aria-hidden="true" />
          </HeaderAction>
        )}
        <HeaderAction label="Open folder" tooltip="Open folder…" onClick={onOpenFolder}>
          <FolderPlus size={13} aria-hidden="true" />
        </HeaderAction>
      </div>
      {viewMenuAt && <SidebarViewMenu at={viewMenuAt} onDismiss={() => setViewMenuAt(null)} />}
    </div>
  )
}
