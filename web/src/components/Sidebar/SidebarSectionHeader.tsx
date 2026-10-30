import { useState, type MouseEvent, type ReactNode, type Ref } from 'react'
import { ListFilter, Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceGroup } from '@/api/types'
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
 * The sessions section header: its name with Search and View options.
 * Collapse all and Open folder… live in View options. New sessions start
 * from a folder's "+", ⌘N or the command palette. It stays put however
 * long the list below is.
 */
export function SidebarSectionHeader({
  groupBy,
  workspaceGroups,
  searchOpen,
  searchButtonRef,
  onToggleSearch,
  onCollapseAll,
  onOpenFolder,
}: {
  groupBy: SidebarGroupBy
  /** Workspace groups for the View options filter (Workspace view). */
  workspaceGroups?: readonly WorkspaceGroup[]
  searchOpen: boolean
  searchButtonRef?: Ref<HTMLButtonElement>
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
