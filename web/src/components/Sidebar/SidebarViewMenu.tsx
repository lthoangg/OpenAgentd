import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import {
  SIDEBAR_GROUP_BY,
  useSidebarViewStore,
} from '@/stores/useSidebarViewStore'
import type { WorkspaceGroup } from '@/api/types'
import { groupColor } from './groupColor'

function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div aria-hidden="true" className="px-2 pb-0.5 pt-1.5 label-caps text-(--color-text-subtle)">{label}</div>
      {children}
    </div>
  )
}

function CheckItem({
  role,
  checked,
  onSelect,
  children,
}: {
  role: 'menuitemradio' | 'menuitemcheckbox'
  checked: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      className={`${CONTEXT_MENU_ITEM_CLASS} ${checked ? 'text-(--color-text)' : ''}`}
      onClick={(event) => {
        // The menu stays open after a choice. WebKit does not focus a
        // clicked button, so keep focus here for the arrows and Escape.
        event.currentTarget.focus({ preventScroll: true })
        onSelect()
      }}
    >
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        {checked && <Check size={12} />}
      </span>
      {children}
    </button>
  )
}

/**
 * The sidebar's View options: how sessions group, and whether rows
 * show their age and place; in Project view, which workspace group's
 * repositories to show. Choices apply at once and the menu stays open,
 * so several can be changed in one visit; Escape or a click outside closes
 * it and focus returns to the trigger.
 */
export function SidebarViewMenu({
  at,
  workspaceGroups: groups = [],
  onDismiss,
}: {
  at: { x: number; y: number }
  /** Groups the Project view can be narrowed to. */
  workspaceGroups?: readonly WorkspaceGroup[]
  onDismiss: () => void
}) {
  const groupBy = useSidebarViewStore((s) => s.groupBy)
  const showDetails = useSidebarViewStore((s) => s.showDetails)
  const groupFilter = useSidebarViewStore((s) => s.groupFilter)
  const setGroupBy = useSidebarViewStore((s) => s.setGroupBy)
  const setShowDetails = useSidebarViewStore((s) => s.setShowDetails)
  const setGroupFilter = useSidebarViewStore((s) => s.setGroupFilter)
  const reset = useSidebarViewStore((s) => s.reset)
  const activeFilter = groups.some((g) => g.id === groupFilter) ? groupFilter : null

  return (
    <ContextMenu at={at} label="View options" onDismiss={onDismiss} className="min-w-48">
      <MenuGroup label="Group by">
        {SIDEBAR_GROUP_BY.map((option) => (
          <CheckItem key={option.value} role="menuitemradio" checked={groupBy === option.value} onSelect={() => setGroupBy(option.value)}>
            {option.label}
          </CheckItem>
        ))}
      </MenuGroup>
      <ContextMenuSeparator />
      {groupBy === 'project' && groups.length > 0 && (
        <>
          <MenuGroup label="Workspace group">
            <CheckItem role="menuitemradio" checked={activeFilter === null} onSelect={() => setGroupFilter(null)}>
              All workspaces
            </CheckItem>
            {groups.map((group) => (
              <CheckItem key={group.id} role="menuitemradio" checked={activeFilter === group.id} onSelect={() => setGroupFilter(group.id)}>
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(group) }} aria-hidden="true" />
                <span className="truncate">{group.name}</span>
              </CheckItem>
            ))}
          </MenuGroup>
          <ContextMenuSeparator />
        </>
      )}
      <CheckItem role="menuitemcheckbox" checked={showDetails} onSelect={() => setShowDetails(!showDetails)}>
        Show details
      </CheckItem>
      <ContextMenuSeparator />
      <button
        type="button"
        role="menuitem"
        className={CONTEXT_MENU_ITEM_CLASS}
        onClick={() => {
          reset()
          onDismiss()
        }}
      >
        <span className="size-3 shrink-0" aria-hidden="true" />
        Reset to defaults
      </button>
    </ContextMenu>
  )
}
