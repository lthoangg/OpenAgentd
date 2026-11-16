// Not compiled, as when this code was part of Sidebar, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
/** A session's menu: a context menu on desktop, a bottom sheet on a phone. */
import { Fragment } from 'react'
import { ActionSheet } from '@/components/ui/action-sheet'
import {
  CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import type { SessionActions } from './useSessionActions'

export function SessionActionsMenu({ actions }: { actions: SessionActions }) {
  const { desktopSessionActions, setDesktopSessionActions, mobileSessionActions, setMobileSessionActions, sessionMenuActions } = actions
  return (
    <>
      {desktopSessionActions && (
        <ContextMenu
          at={desktopSessionActions}
          label={`Actions for ${desktopSessionActions.session.title || 'Untitled'}`}
          onDismiss={() => setDesktopSessionActions(null)}
          className="min-w-44"
        >
          {sessionMenuActions(desktopSessionActions.session).map(({ id, label, icon: Icon, danger, separatorBefore, run }) => (
            <Fragment key={id}>
              {separatorBefore && <ContextMenuSeparator />}
              <button
                type="button"
                role="menuitem"
                className={danger ? CONTEXT_MENU_ITEM_DANGER_CLASS : CONTEXT_MENU_ITEM_CLASS}
                onClick={() => {
                  setDesktopSessionActions(null)
                  run()
                }}
              >
                <Icon size={12} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            </Fragment>
          ))}
        </ContextMenu>
      )}

      {/* A phone's long-press menu is a sheet from the bottom edge, the iOS
          app included (``ActionSheet``). */}
      <ActionSheet
        open={mobileSessionActions !== null}
        onClose={() => setMobileSessionActions(null)}
        title={mobileSessionActions?.session.title || 'Untitled'}
        description="Choose a session action."
        items={mobileSessionActions ? sessionMenuActions(mobileSessionActions.session) : []}
      />
    </>
  )
}
