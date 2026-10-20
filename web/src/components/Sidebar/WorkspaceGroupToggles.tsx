import { Check, Settings2 } from 'lucide-react'

import { buttonVariants } from '@/components/ui/button'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenuSeparator } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { useSetWorkspaceGroupsMutation, useWorkspaceGroups } from '@/queries/useWorkspaceGroups'
import { groupColor } from './groupColor'

const SHEET_ITEM_CLASS = buttonVariants({ variant: 'ghost', className: 'justify-start' })

/**
 * A repository's workspace groups as toggles in its actions menu, plus a way
 * to Settings → Workspaces, where groups are created,
 * briefed and deleted. A toggle saves at once and leaves the menu open, so
 * several groups can be set in one go.
 *
 * `menu` renders context-menu rows; `sheet` renders buttons for the mobile
 * workspace actions dialog.
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
  const iconSize = menu ? 12 : 14

  const toggle = (id: string) => {
    const next = tags.includes(id) ? tags.filter((t) => t !== id) : [...tags, id]
    // A failed save leaves the toggle as it was; the tree is the truth.
    setGroups.mutate({ workspace, groupIds: next })
  }

  return (
    <>
      {menu && <ContextMenuSeparator />}
      <p className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-(--color-text-subtle)">Groups</p>
      {groups.map((group) => {
        const checked = tags.includes(group.id)
        return (
          <button
            key={group.id}
            type="button"
            role={menu ? 'menuitemcheckbox' : undefined}
            aria-checked={menu ? checked : undefined}
            aria-pressed={menu ? undefined : checked}
            disabled={setGroups.isPending}
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
