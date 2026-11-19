// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/**
 * A workspace row's actions: New session, Locate folder… (when its folder is
 * gone), Copy path, Create worktree… (a Git repository), its workspace
 * groups, and Hide from sidebar. A context menu on desktop (⋯ or
 * right-click), a bottom sheet on a phone (long press); Chat's sheet has only
 * New session.
 */
import { Copy, FolderSearch, GitBranch, Plus } from 'lucide-react'
import type { CodingWorkspaceTreeRepository } from '@/api/types'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { usePlatform } from '@/hooks/use-platform'
import { workspaceLabel } from '@/utils/workspace'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ACTION_SHEET_ROW_CLASS } from '@/components/ui/action-sheet'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import {
  CONTEXT_MENU_ITEM_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { MenuShortcut } from './MenuShortcut'
import { WorkspaceGroupToggles } from './WorkspaceGroupToggles'
import { copyText } from '@/lib/copy-text'

/** Who a workspace menu is for. ``path`` is the repository; "New session" starts in ``sessionPath``, the checkout its list shows. */
export interface WorkspaceMenuTarget {
  path: string
  sessionPath: string
}

/** What a workspace's menus can do, the same on desktop and phone. */
interface WorkspaceMenuActions {
  workspaceByPath: Map<string, CodingWorkspaceTreeRepository>
  newSessionIn: (path: string) => void
  openRelocate: (path: string) => Promise<void>
  openWorktreeDialog: (path: string) => void
  hideWorkspaceFromSidebar: (path: string) => void
}

export function WorkspaceActionsSheet({
  mobileWorkspaceActions,
  setMobileWorkspaceActions,
  chatName,
  workspaceByPath,
  newSessionIn,
  openRelocate,
  openWorktreeDialog,
  hideWorkspaceFromSidebar,
}: WorkspaceMenuActions & {
  mobileWorkspaceActions: (WorkspaceMenuTarget & { kind: 'main' | 'chat' }) | null
  setMobileWorkspaceActions: (target: null) => void
  chatName: string | undefined
}) {
  const openSettings = useSettingsStore((s) => s.openSettings)
  const mobileWorkspaceActionsTitle = mobileWorkspaceActions?.kind === 'chat'
    ? (chatName ?? 'Chat')
    : mobileWorkspaceActions
      ? workspaceLabel(mobileWorkspaceActions.path)
      : 'Workspace actions'
  return (
    <BottomSheet
      open={mobileWorkspaceActions !== null}
      onClose={() => setMobileWorkspaceActions(null)}
      label={mobileWorkspaceActionsTitle}
    >
      <div className="px-4 pb-1">
        <p className="text-sm font-medium text-(--color-text) [overflow-wrap:anywhere]">{mobileWorkspaceActionsTitle}</p>
        <p className="text-xs text-(--color-text-muted)">
          {mobileWorkspaceActions?.kind === 'chat'
            ? 'Choose a chat action.'
            : 'Choose a main workspace action.'}
        </p>
      </div>
      <div className="flex flex-col px-2 pb-3">
          <button
            type="button"
            className={ACTION_SHEET_ROW_CLASS}
            onClick={() => {
              const action = mobileWorkspaceActions
              setMobileWorkspaceActions(null)
              if (action) newSessionIn(action.sessionPath)
            }}
          >
            <Plus size={16} aria-hidden="true" />
            New session
          </button>
          {/* Chat's root is the home directory — the path is noise there,
              and there is no repository to act on. */}
          {mobileWorkspaceActions?.kind !== 'chat' && (
            <button
              type="button"
              className={ACTION_SHEET_ROW_CLASS}
              onClick={() => {
                const action = mobileWorkspaceActions
                setMobileWorkspaceActions(null)
                if (action) void copyText(action.path)
              }}
            >
              <Copy size={16} aria-hidden="true" />
              Copy path
            </button>
          )}
          {mobileWorkspaceActions?.kind === 'main' && (
            <>
              {workspaceByPath.get(mobileWorkspaceActions.path)?.missing && (
                <button
                  type="button"
                  data-sidebar-locate=""
                  className={ACTION_SHEET_ROW_CLASS}
                  onClick={() => {
                    const action = mobileWorkspaceActions
                    setMobileWorkspaceActions(null)
                    if (action) void openRelocate(action.path)
                  }}
                >
                  <FolderSearch size={16} aria-hidden="true" />
                  Locate folder…
                </button>
              )}
              {workspaceByPath.get(mobileWorkspaceActions.path)?.git !== false && (
              <button
                type="button"
                className={ACTION_SHEET_ROW_CLASS}
                onClick={() => {
                  const action = mobileWorkspaceActions
                  setMobileWorkspaceActions(null)
                  if (action) openWorktreeDialog(action.path)
                }}
              >
                <GitBranch size={16} aria-hidden="true" />
                Create worktree…
              </button>
              )}
              <WorkspaceGroupToggles
                workspace={mobileWorkspaceActions.path}
                variant="sheet"
                onManage={() => {
                  setMobileWorkspaceActions(null)
                  openSettings('workspaces')
                }}
              />
              <button
                type="button"
                className={ACTION_SHEET_ROW_CLASS}
                onClick={() => {
                  const action = mobileWorkspaceActions
                  setMobileWorkspaceActions(null)
                  if (action) hideWorkspaceFromSidebar(action.path)
                }}
              >
                <span className="size-4 shrink-0" aria-hidden="true" />
                Hide from sidebar
              </button>
            </>
          )}
      </div>
    </BottomSheet>
  )
}

export function WorkspaceActionsContextMenu({
  desktopWorkspaceActions,
  setDesktopWorkspaceActions,
  activeWorkspace,
  newSessionKeys,
  workspaceByPath,
  newSessionIn,
  openRelocate,
  openWorktreeDialog,
  hideWorkspaceFromSidebar,
}: WorkspaceMenuActions & {
  desktopWorkspaceActions: (WorkspaceMenuTarget & { x: number; y: number }) | null
  setDesktopWorkspaceActions: (target: null) => void
  activeWorkspace: string | null
  /** ``aria-keyshortcuts`` for ⌘N. */
  newSessionKeys: string
}) {
  const { os } = usePlatform()
  const openSettings = useSettingsStore((s) => s.openSettings)
  if (!desktopWorkspaceActions) return null
  return (
    <ContextMenu
      at={desktopWorkspaceActions}
      label={`Actions for ${workspaceLabel(desktopWorkspaceActions.path)}`}
      onDismiss={() => setDesktopWorkspaceActions(null)}
      className="min-w-48"
    >
        <button
          type="button"
          role="menuitem"
          className={CONTEXT_MENU_ITEM_CLASS}
          // ⌘N starts a session in the workspace on screen: the key and the
          // entry agree only for that one, so only its menu shows the key.
          aria-keyshortcuts={desktopWorkspaceActions.sessionPath === activeWorkspace ? newSessionKeys : undefined}
          onClick={() => {
            const action = desktopWorkspaceActions
            setDesktopWorkspaceActions(null)
            newSessionIn(action.sessionPath)
          }}
        >
          <Plus size={12} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">New session</span>
          {desktopWorkspaceActions.sessionPath === activeWorkspace && (
            <MenuShortcut>{shortcutLabel(APP_SHORTCUTS.newSession, os)}</MenuShortcut>
          )}
        </button>
        <ContextMenuSeparator />
        {workspaceByPath.get(desktopWorkspaceActions.path)?.missing && (
          <button
            type="button"
            role="menuitem"
            data-sidebar-locate=""
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              const action = desktopWorkspaceActions
              setDesktopWorkspaceActions(null)
              void openRelocate(action.path)
            }}
          >
            <FolderSearch size={12} aria-hidden="true" />
            Locate folder…
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={CONTEXT_MENU_ITEM_CLASS}
          onClick={() => {
            const action = desktopWorkspaceActions
            setDesktopWorkspaceActions(null)
            void copyText(action.path)
          }}
        >
          <Copy size={12} aria-hidden="true" />
          Copy path
        </button>
        {/* A folder without Git has no worktrees to make. */}
        {workspaceByPath.get(desktopWorkspaceActions.path)?.git !== false && (
        <button
          type="button"
          role="menuitem"
          className={CONTEXT_MENU_ITEM_CLASS}
          onClick={() => {
            const action = desktopWorkspaceActions
            setDesktopWorkspaceActions(null)
            openWorktreeDialog(action.path)
          }}
        >
          <GitBranch size={12} aria-hidden="true" />
          Create worktree…
        </button>
        )}
        <WorkspaceGroupToggles
          workspace={desktopWorkspaceActions.path}
          variant="menu"
          onManage={() => {
            setDesktopWorkspaceActions(null)
            openSettings('workspaces')
          }}
        />
        <button
          type="button"
          role="menuitem"
          className={CONTEXT_MENU_ITEM_CLASS}
          onClick={() => {
            const action = desktopWorkspaceActions
            setDesktopWorkspaceActions(null)
            hideWorkspaceFromSidebar(action.path)
          }}
        >
          <span className="size-3 shrink-0" aria-hidden="true" />
          Hide from sidebar
        </button>
    </ContextMenu>
  )
}
