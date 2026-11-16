/**
 * Which checkouts a repository row lists. A repository lists the sessions
 * of all its checkouts (its own folder and each worktree) unless the user
 * picked one from the row's worktree chip; that menu (a context menu on
 * desktop, a sheet on touch) also holds the selected worktree's actions.
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Folder, GitBranch, Pencil, Plus, Trash2, X } from 'lucide-react'
import { setCodingWorkspaceVisibility } from '@/api/client'
import type { SessionResponse, WorktreeInfo } from '@/api/types'
import { failureToast } from '@/lib/failure-toast'
import { sessionWorking } from '@/lib/active-sessions'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries/keys'
import { useToastStore } from '@/stores/useToastStore'
import { workspaceLabel } from '@/utils/workspace'
import { ACTION_SHEET_ROW_CLASS } from '@/components/ui/action-sheet'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Chip } from '@/components/ui/chip'
import {
  CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import type { repositoryCheckouts } from './helpers'
import { MissingBadge } from './MissingBadge'
import type { WorktreeActions } from './useWorktreeActions'

/**
 * Repository path → the checkout its list shows. Opening a session the
 * filter hides drops the filter.
 */
export function useCheckoutFilter({
  currentSessionId,
  activeWorkspace,
  activeWorktreeSource,
}: {
  currentSessionId?: string
  activeWorkspace: string | null
  activeWorktreeSource: string | null | undefined
}) {
  // Repository path → the one checkout its list shows (its own path or a
  // worktree's). Absent means every checkout.
  const [checkoutFilter, setCheckoutFilter] = useState<Record<string, string>>({})

  // Opening a session its repository's checkout filter hides (from Needs
  // you, search, another window) shows every checkout again. Picking a
  // filter never moves the current session, so that choice sticks.
  useEffect(() => {
    if (!activeWorkspace) return
    const repository = activeWorktreeSource ?? activeWorkspace
    setCheckoutFilter((current) => {
      const selected = current[repository]
      if (selected === undefined || selected === activeWorkspace) return current
      const next = { ...current }
      delete next[repository]
      return next
    })
  }, [currentSessionId, activeWorkspace, activeWorktreeSource])

  const selectCheckout = (repository: string, checkout: string | null) => {
    setCheckoutFilter((current) => {
      const next = { ...current }
      if (checkout === null) delete next[repository]
      else next[repository] = checkout
      return next
    })
  }
  return { checkoutFilter, selectCheckout }
}

/** One pick-one row of a repository's checkout menu. */
function CheckoutMenuItem({ checked, title, onSelect, children }: { checked: boolean; title?: string; onSelect: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      title={title}
      className={`${CONTEXT_MENU_ITEM_CLASS} ${checked ? 'text-(--color-text)' : ''}`}
      onClick={onSelect}
    >
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        {checked && <Check size={12} />}
      </span>
      {children}
    </button>
  )
}

export function CheckoutMenu({
  checkoutMenu,
  setCheckoutMenu,
  checkoutMenuRepository,
  mobileLongPressActions,
  sessionsByWorkspace,
  selectCheckout,
  worktreeActions,
  refreshWorkspaceTree,
}: {
  /** The repository whose chip opened the menu, and where. */
  checkoutMenu: { repo: string; x: number; y: number } | null
  setCheckoutMenu: (menu: null) => void
  checkoutMenuRepository: ReturnType<typeof repositoryCheckouts> | null
  /** Touch: a sheet with each checkout's session counts instead of the menu. */
  mobileLongPressActions: boolean
  sessionsByWorkspace: Map<string, SessionResponse[]>
  selectCheckout: (repository: string, checkout: string | null) => void
  worktreeActions: WorktreeActions
  refreshWorkspaceTree: () => Promise<void>
}) {
  const { openWorktreeDialog, handleWorktreeEdit, setRemoveWorktreeTarget, worktreeRemoving } = worktreeActions
  const queryClient = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  const checkoutMenuSelection = checkoutMenuRepository?.selectedWorktree
  const checkoutMenuWorktree: WorktreeInfo | null = checkoutMenuSelection
    ? { name: checkoutMenuSelection.name, directory: checkoutMenuSelection.path, managed: checkoutMenuSelection.managed }
    : null

  // A checkout that is not OpenAgentd's to delete (a subfolder, an outside
  // worktree, or one whose folder is gone) leaves the sidebar only.
  const hideCheckout = (path: string) => {
    void setCodingWorkspaceVisibility(path, true)
      .then(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.session.sessions.all() })
        await refreshWorkspaceTree()
      })
      .catch((err: unknown) => {
        pushToast(failureToast("Couldn't remove it from the sidebar", err))
      })
  }

  return (
    <>
      {checkoutMenu && checkoutMenuRepository && mobileLongPressActions && (
        // Touch: a sheet (mockup J8 8.4), names in sans, each row with its
        // session count and what runs there.
        <BottomSheet open onClose={() => setCheckoutMenu(null)} label={`Worktrees for ${workspaceLabel(checkoutMenu.repo)}`}>
          <div data-worktree-sheet="" className="flex flex-col px-2 pb-3">
            {[
              { path: null as string | null, name: 'Workspace and worktrees', counted: [...checkoutMenuRepository.worktrees.map((w) => w.path), checkoutMenu.repo] },
              { path: checkoutMenu.repo as string | null, name: 'Main workspace', counted: [checkoutMenu.repo] },
              ...checkoutMenuRepository.worktrees.map((w) => ({ path: w.path as string | null, name: w.name, counted: [w.path] })),
            ].map((row) => {
              const rowSessions = row.counted.flatMap((p) => sessionsByWorkspace.get(p) ?? [])
              const running = rowSessions.filter(sessionWorking).length
              const checked = checkoutMenuRepository.selected === row.path
              return (
                <button
                  key={row.path ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => { selectCheckout(checkoutMenu.repo, row.path); setCheckoutMenu(null) }}
                  className={cn(ACTION_SHEET_ROW_CLASS, 'min-h-14 items-center')}
                >
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm text-(--color-text)">{row.name}</span>
                    <span className="block truncate text-meta text-(--color-text-muted)">
                      {`${rowSessions.length} ${rowSessions.length === 1 ? 'session' : 'sessions'}${running > 0 ? ` · ${running} running` : ''}`}
                    </span>
                  </span>
                  {checked && <Check size={16} aria-hidden="true" />}
                </button>
              )
            })}
            <div className="my-1 border-t border-(--color-border)" />
            <button
              type="button"
              className={ACTION_SHEET_ROW_CLASS}
              onClick={() => { const repo = checkoutMenu.repo; setCheckoutMenu(null); openWorktreeDialog(repo) }}
            >
              <Plus size={16} aria-hidden="true" />
              Create worktree…
            </button>
            {checkoutMenuWorktree && (
              <button type="button" className={ACTION_SHEET_ROW_CLASS} onClick={() => { setCheckoutMenu(null); handleWorktreeEdit(checkoutMenuWorktree) }}>
                <Pencil size={16} aria-hidden="true" />
                {`Rename ${checkoutMenuWorktree.name}…`}
              </button>
            )}
            {checkoutMenuWorktree?.managed && (
              <button
                type="button"
                className={cn(ACTION_SHEET_ROW_CLASS, 'text-(--color-error)')}
                disabled={worktreeRemoving === checkoutMenuWorktree.directory}
                onClick={() => { setCheckoutMenu(null); setRemoveWorktreeTarget(checkoutMenuWorktree) }}
              >
                <Trash2 size={16} aria-hidden="true" />
                {`Delete worktree ${checkoutMenuWorktree.name}…`}
              </button>
            )}
          </div>
        </BottomSheet>
      )}
      {checkoutMenu && checkoutMenuRepository && !mobileLongPressActions && (
        <ContextMenu
          at={checkoutMenu}
          label={`Worktrees for ${workspaceLabel(checkoutMenu.repo)}`}
          onDismiss={() => setCheckoutMenu(null)}
          className="min-w-48 max-w-64"
        >
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === null}
            onSelect={() => { selectCheckout(checkoutMenu.repo, null); setCheckoutMenu(null) }}
          >
            Workspace and worktrees
          </CheckoutMenuItem>
          <CheckoutMenuItem
            checked={checkoutMenuRepository.selected === checkoutMenu.repo}
            onSelect={() => { selectCheckout(checkoutMenu.repo, checkoutMenu.repo); setCheckoutMenu(null) }}
          >
            <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
            Workspace
          </CheckoutMenuItem>
          {checkoutMenuRepository.worktrees.map((item) => (
            <CheckoutMenuItem
              key={item.path}
              checked={checkoutMenuRepository.selected === item.path}
              title={item.missing ? `Folder not found at ${item.path}` : undefined}
              onSelect={() => { selectCheckout(checkoutMenu.repo, item.path); setCheckoutMenu(null) }}
            >
              {item.kind === 'folder'
                ? <Folder size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
                : <GitBranch size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate font-mono">{item.name}</span>
              {item.missing
                ? <MissingBadge />
                : item.kind === 'folder'
                  ? <Chip>folder</Chip>
                  : !item.managed && <Chip>external</Chip>}
            </CheckoutMenuItem>
          ))}
          <ContextMenuSeparator />
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              const repo = checkoutMenu.repo
              setCheckoutMenu(null)
              openWorktreeDialog(repo)
            }}
          >
            <Plus size={12} aria-hidden="true" />
            Create worktree…
          </button>
          {/* Worktree actions act on the selected worktree, which the chip
              names, so the menu never needs a second level. */}
          {checkoutMenuWorktree && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                setCheckoutMenu(null)
                handleWorktreeEdit(checkoutMenuWorktree)
              }}
            >
              <Pencil size={12} aria-hidden="true" />
              {`Rename ${checkoutMenuWorktree.name}…`}
            </button>
          )}
          {checkoutMenuWorktree?.managed && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_DANGER_CLASS}
              disabled={worktreeRemoving === checkoutMenuWorktree.directory}
              onClick={() => {
                setCheckoutMenu(null)
                setRemoveWorktreeTarget(checkoutMenuWorktree)
              }}
            >
              <Trash2 size={12} aria-hidden="true" />
              {`Delete worktree ${checkoutMenuWorktree.name}…`}
            </button>
          )}
          {checkoutMenuWorktree && !checkoutMenuWorktree.managed && (
            <button
              type="button"
              role="menuitem"
              className={CONTEXT_MENU_ITEM_CLASS}
              onClick={() => {
                const target = checkoutMenuWorktree.directory
                selectCheckout(checkoutMenu.repo, null)
                setCheckoutMenu(null)
                hideCheckout(target)
              }}
            >
              <X size={12} aria-hidden="true" />
              {`Hide ${checkoutMenuWorktree.name} from sidebar`}
            </button>
          )}
        </ContextMenu>
      )}
    </>
  )
}
