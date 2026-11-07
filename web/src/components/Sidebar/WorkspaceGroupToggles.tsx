import { Check, Settings2 } from 'lucide-react'

import { CONTEXT_MENU_ITEM_CLASS, ContextMenuSeparator } from '@/components/ui/context-menu'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { cn } from '@/lib/utils'
import { useSetWorkspaceGroupsMutation, useWorkspaceGroups } from '@/queries/useWorkspaceGroups'
import { groupColor } from './groupColor'

/** A row of the phone's workspace actions sheet (``--phone-control``, like its other rows). */
const SHEET_ITEM_CLASS = cn(MENU_ITEM_CLASS, 'min-h-(--phone-control) text-sm')

/**
 * A repository's workspace groups as toggles in its actions menu, plus a way
 * to Settings → Workspaces, where groups are created,
 * briefed and deleted. A toggle saves at once and leaves the menu open, so
 * several groups can be set in one go.
 *
 * `menu` renders context-menu rows; `sheet` renders rows for the phone's
 * workspace actions sheet.
 */
export function WorkspaceGroupToggles({
  workspace,
  variant,
  onManage,
}: {
  /** Repository path. */
  workspace: string
  variant: 'menu' | 'sheet'
  onManage: () => void
}) {
  const { groups, groupIdsByRepo } = useWorkspaceGroups()
  const setGroups = useSetWorkspaceGroupsMutation()
  const tags = groupIdsByRepo.get(workspace) ?? []
  const menu = variant === 'menu'
  const iconSize = menu ? 12 : 16

  const toggle = (id: string) => {
    const next = tags.includes(id) ? tags.filter((t) => t !== id) : [...tags, id]
    // Shows at once; a failed save puts the toggle back.
    setGroups.mutate({ workspace, groupIds: next })
  }

  return (
    <>
      {menu && <ContextMenuSeparator />}
      <p className="px-2 pt-1 pb-0.5 text-meta font-medium text-(--color-text-subtle)">Groups</p>
      {groups.map((group) => {
        const checked = tags.includes(group.id)
        return (
          <button
            key={group.id}
            type="button"
            role={menu ? 'menuitemcheckbox' : undefined}
            aria-checked={menu ? checked : undefined}
            aria-pressed={menu ? undefined : checked}
            className={menu ? CONTEXT_MENU_ITEM_CLASS : SHEET_ITEM_CLASS}
            onClick={() => toggle(group.id)}
          >
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: groupColor(group) }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
            <Check size={iconSize} aria-hidden="true" className={cn('shrink-0', !checked && 'invisible')} />
          </button>
        )
      })}
      <button
        type="button"
        role={menu ? 'menuitem' : undefined}
        className={menu ? CONTEXT_MENU_ITEM_CLASS : SHEET_ITEM_CLASS}
        onClick={onManage}
      >
        <Settings2 size={iconSize} aria-hidden="true" />
        Manage groups…
      </button>
      {menu && <ContextMenuSeparator />}
    </>
  )
}
