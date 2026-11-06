import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import {
  SIDEBAR_GROUP_BY,
  useSidebarViewStore,
} from '@/stores/useSidebarViewStore'
import type { WorkspaceGroup } from '@/api/types'
import { usePlatform } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { PanelRow } from '@/components/ui/panel-row'
import { useIsPhone } from '@/hooks/use-is-phone'
import { groupColor } from './groupColor'
import { MenuShortcut } from './MenuShortcut'

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

function ActionItem({ onSelect, shortcut, children }: { onSelect: () => void; shortcut?: string; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} onClick={onSelect}>
      <span className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <MenuShortcut>{shortcut}</MenuShortcut>}
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
  onCollapseAll,
  onOpenFolder,
  onDismiss,
}: {
  at: { x: number; y: number }
  /** Groups the Workspace view can be narrowed to. */
  workspaceGroups?: readonly WorkspaceGroup[]
  /** Folds every workspace (Workspace view only). */
  onCollapseAll?: () => void
  /** Adds a folder to the sidebar. */
  onOpenFolder?: () => void
  onDismiss: () => void
}) {
  const groupBy = useSidebarViewStore((s) => s.groupBy)
  const { os } = usePlatform()
  const showDetails = useSidebarViewStore((s) => s.showDetails)
  const groupFilter = useSidebarViewStore((s) => s.groupFilter)
  const setGroupBy = useSidebarViewStore((s) => s.setGroupBy)
  const setShowDetails = useSidebarViewStore((s) => s.setShowDetails)
  const setGroupFilter = useSidebarViewStore((s) => s.setGroupFilter)
  const reset = useSidebarViewStore((s) => s.reset)
  const activeFilter = groups.some((g) => g.id === groupFilter) ? groupFilter : null
  const isPhone = useIsPhone()

  // A phone gets a sheet (mockup J8): Group by as a segmented control and
  // Show details as a switch, the actions as full-width rows under them.
  if (isPhone) {
    const sheetAction = 'flex min-h-11 w-full items-center px-4 text-left text-sm text-(--color-text) active:bg-(--bg-key)'
    return (
      <BottomSheet open onClose={onDismiss} label="View options">
        <div className="flex flex-col gap-3 px-3 pb-4" data-view-options-sheet="">
          <SegmentedControl
            label="Group by"
            fill
            value={groupBy}
            onChange={setGroupBy}
            options={SIDEBAR_GROUP_BY.map((option) => ({ value: option.value, label: option.label }))}
          />
          {groupBy === 'project' && groups.length > 0 && (
            <div role="group" aria-label="Workspace group" className="flex flex-col">
              {[{ id: null, name: 'All workspaces' } as const, ...groups].map((group) => (
                <button
                  key={group.id ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={activeFilter === group.id}
                  onClick={() => setGroupFilter(group.id)}
                  className={sheetAction + ' gap-2'}
                >
                  {group.id !== null && (
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(group as WorkspaceGroup) }} aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {activeFilter === group.id && <Check size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
          <PanelRow label="Show details" labelId="view-options-details">
            <Switch checked={showDetails} onCheckedChange={setShowDetails} aria-labelledby="view-options-details" />
          </PanelRow>
          <div className="flex flex-col border-t border-(--color-border)">
            {onCollapseAll && <button type="button" className={sheetAction} onClick={() => { onCollapseAll(); onDismiss() }}>Collapse all workspaces</button>}
            {onOpenFolder && <button type="button" className={sheetAction} onClick={() => { onDismiss(); onOpenFolder() }}>Open workspace…</button>}
            <button type="button" className={sheetAction} onClick={() => { reset(); onDismiss() }}>Reset to defaults</button>
          </div>
        </div>
      </BottomSheet>
    )
  }

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
      {onCollapseAll && <ActionItem onSelect={() => { onCollapseAll(); onDismiss() }}>Collapse all workspaces</ActionItem>}
      {onOpenFolder && (
        <ActionItem shortcut={shortcutLabel(APP_SHORTCUTS.openWorkspace, os)} onSelect={() => { onDismiss(); onOpenFolder() }}>
          Open workspace…
        </ActionItem>
      )}
      {(onCollapseAll || onOpenFolder) && <ContextMenuSeparator />}
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
