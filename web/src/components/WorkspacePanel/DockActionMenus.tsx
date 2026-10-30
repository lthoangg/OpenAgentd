/**
 * DockActionMenus — the review dock's per-row action surfaces.
 *
 * Desktop: right-click menus anchored at the pointer. Mobile: long-press
 * action sheets with the same choices. Both route into the panel's
 * handlers; this module only renders. The discard confirmation lives here
 * too because both surfaces open it.
 */
import { useState } from 'react'
import { Copy, ExternalLink, FileDiff, FolderOpen, RotateCcw, Undo2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  CONTEXT_MENU_ITEM_CLASS as MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS as MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { softHapticFeedback } from '@/lib/haptics'
import type { ChangedFileInfo } from './diff-helpers'

export interface CommitActionTarget {
  sha: string
  shortSha: string
  subject: string
}

type At<T> = T & { x: number; y: number }

export interface DockActionMenusProps {
  mobileFileActions: ChangedFileInfo | null
  setMobileFileActions: (value: ChangedFileInfo | null) => void
  desktopFileActions: { file: ChangedFileInfo; x: number; y: number } | null
  setDesktopFileActions: (value: { file: ChangedFileInfo; x: number; y: number } | null) => void
  mobileCommitActions: CommitActionTarget | null
  setMobileCommitActions: (value: CommitActionTarget | null) => void
  desktopCommitActions: At<CommitActionTarget> | null
  setDesktopCommitActions: (value: At<CommitActionTarget> | null) => void
  isLatestCommit: boolean
  gitActionPending: boolean
  /** Whether ``path`` has working-tree changes (a diff tab would be empty otherwise). */
  hasWorkingDiff: (path: string) => boolean
  onOpenFile: (path: string) => void
  onOpenDiffTab: (file: ChangedFileInfo) => void
  onOpenCommitTab: (sha: string) => void
  onUndoCommit: () => void
  onRevertCommit: (sha: string, shortSha: string) => void
  discardTarget: ChangedFileInfo | null
  setDiscardTarget: (value: ChangedFileInfo | null) => void
  discarding: boolean
  onConfirmDiscard: () => void
}

const MENU_DIVIDER = <ContextMenuSeparator />

function copy(text: string) {
  void navigator.clipboard?.writeText(text)
}

export function DockActionMenus({
  mobileFileActions,
  setMobileFileActions,
  desktopFileActions,
  setDesktopFileActions,
  mobileCommitActions,
  setMobileCommitActions,
  desktopCommitActions,
  setDesktopCommitActions,
  isLatestCommit,
  gitActionPending,
  hasWorkingDiff,
  onOpenFile,
  onOpenDiffTab,
  onOpenCommitTab,
  onUndoCommit,
  onRevertCommit,
  discardTarget,
  setDiscardTarget,
  discarding,
  onConfirmDiscard,
}: DockActionMenusProps) {
  const [commitConfirm, setCommitConfirm] = useState<{ kind: 'undo' } | { kind: 'revert'; sha: string; shortSha: string } | null>(null)
  return (
    <>
      <Dialog open={mobileFileActions !== null} onOpenChange={(open) => { if (!open) setMobileFileActions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{mobileFileActions?.path ?? ''}</DialogTitle>
            <DialogDescription>Choose an action for this file.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            {mobileFileActions && hasWorkingDiff(mobileFileActions.path) && (
              <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                const f = mobileFileActions; setMobileFileActions(null)
                softHapticFeedback()
                onOpenDiffTab(f)
              }}>
                <FileDiff size={14} aria-hidden="true" />
                Open diff in tab
              </Button>
            )}
            {mobileFileActions?.status !== 'D' && (
              <Button type="button" variant="ghost" className="justify-start" onClick={() => {
                const f = mobileFileActions; setMobileFileActions(null)
                if (!f) return
                softHapticFeedback()
                onOpenFile(f.path)
              }}>
                <FolderOpen size={14} aria-hidden="true" />
                Open file
              </Button>
            )}
            <Button type="button" variant="ghost" className="justify-start" onClick={() => {
              const f = mobileFileActions; setMobileFileActions(null)
              if (!f) return
              softHapticFeedback()
              copy(f.path)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy file path
            </Button>
            <Button type="button" variant="danger-subtle" className="justify-start" onClick={() => {
              const f = mobileFileActions
              setMobileFileActions(null)
              if (f) setDiscardTarget(f)
            }}>
              <Undo2 size={14} aria-hidden="true" />
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mobileCommitActions !== null} onOpenChange={(open) => { if (!open && !gitActionPending) setMobileCommitActions(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{mobileCommitActions?.subject ?? ''}</DialogTitle>
            <DialogDescription>SHA: {mobileCommitActions?.shortSha}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              onOpenCommitTab(c.sha)
            }}>
              <ExternalLink size={14} aria-hidden="true" />
              Open in tab
            </Button>
            {isLatestCommit && (
              <Button
                type="button"
                variant="danger-subtle"
                className="justify-start"
                disabled={gitActionPending}
                onClick={() => { if (mobileCommitActions) { setMobileCommitActions(null); setCommitConfirm({ kind: 'undo' }) } }}
              >
                <Undo2 size={14} aria-hidden="true" />
                {gitActionPending ? 'Undoing…' : 'Undo commit…'}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              disabled={gitActionPending}
              onClick={() => {
                const c = mobileCommitActions
                if (c) { setMobileCommitActions(null); setCommitConfirm({ kind: 'revert', sha: c.sha, shortSha: c.shortSha }) }
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {gitActionPending ? 'Reverting…' : 'Revert commit…'}
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.shortSha)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy short SHA
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.sha)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy full SHA
            </Button>
            <Button type="button" variant="ghost" className="justify-start" disabled={gitActionPending} onClick={() => {
              const c = mobileCommitActions; setMobileCommitActions(null)
              if (!c) return
              softHapticFeedback()
              copy(c.subject)
            }}>
              <Copy size={14} aria-hidden="true" />
              Copy commit message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {desktopCommitActions && (
        <ContextMenu
          label={`Actions for commit ${desktopCommitActions.shortSha}`}
          onDismiss={() => setDesktopCommitActions(null)}
          at={desktopCommitActions}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const c = desktopCommitActions; setDesktopCommitActions(null)
              onOpenCommitTab(c.sha)
            }}
            className={MENU_ITEM_CLASS}
          >
            <ExternalLink size={12} aria-hidden="true" />
            Open in tab
          </button>
          {MENU_DIVIDER}
          {isLatestCommit && (
            <button
              type="button"
              role="menuitem"
              disabled={gitActionPending}
              onClick={() => { setDesktopCommitActions(null); setCommitConfirm({ kind: 'undo' }) }}
              className={MENU_ITEM_DANGER_CLASS}
            >
              <Undo2 size={12} aria-hidden="true" />
              {gitActionPending ? 'Undoing…' : 'Undo commit…'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={gitActionPending}
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); setCommitConfirm({ kind: 'revert', sha: c.sha, shortSha: c.shortSha }) }}
            className={MENU_ITEM_CLASS}
          >
            <RotateCcw size={12} aria-hidden="true" />
            {gitActionPending ? 'Reverting…' : 'Revert commit…'}
          </button>
          {MENU_DIVIDER}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.shortSha) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy short SHA
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.sha) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy full SHA
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { const c = desktopCommitActions; setDesktopCommitActions(null); copy(c.subject) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy commit message
          </button>
        </ContextMenu>
      )}

      {desktopFileActions && (
        <ContextMenu
          label={`Actions for ${desktopFileActions.file.path}`}
          onDismiss={() => setDesktopFileActions(null)}
          at={desktopFileActions}
        >
          {hasWorkingDiff(desktopFileActions.file.path) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); onOpenDiffTab(f) }}
              className={MENU_ITEM_CLASS}
            >
              <FileDiff size={12} aria-hidden="true" />
              Open diff in tab
            </button>
          )}
          {desktopFileActions.file.status !== 'D' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); onOpenFile(f.path) }}
              className={MENU_ITEM_CLASS}
            >
              <FolderOpen size={12} aria-hidden="true" />
              Open file
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); copy(f.path) }}
            className={MENU_ITEM_CLASS}
          >
            <Copy size={12} aria-hidden="true" />
            Copy file path
          </button>
          {MENU_DIVIDER}
          <button
            type="button"
            role="menuitem"
            onClick={() => { const f = desktopFileActions.file; setDesktopFileActions(null); setDiscardTarget(f) }}
            className={MENU_ITEM_DANGER_CLASS}
          >
            <Undo2 size={12} aria-hidden="true" />
            Discard changes…
          </button>
        </ContextMenu>
      )}

      <Dialog open={discardTarget !== null} onOpenChange={(open) => { if (!open && !discarding) setDiscardTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              Every change in <span className="font-mono text-(--color-text)">{discardTarget?.path}</span> goes back to the last commit. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" disabled={discarding} onClick={() => setDiscardTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={discarding} onClick={onConfirmDiscard}>
              {discarding ? 'Discarding…' : 'Discard changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={commitConfirm !== null}
        onOpenChange={(open) => { if (!open) setCommitConfirm(null) }}
        tone={commitConfirm?.kind === 'undo' ? 'danger' : 'default'}
        title={commitConfirm?.kind === 'undo' ? 'Undo the last commit?' : `Revert commit ${commitConfirm?.kind === 'revert' ? commitConfirm.shortSha : ''}?`}
        description={commitConfirm?.kind === 'undo'
          ? 'The commit is removed from the branch. Its changes stay in your working copy.'
          : 'A new commit is added that undoes this commit\'s changes. History is kept.'}
        confirmLabel={commitConfirm?.kind === 'undo' ? 'Undo commit' : 'Revert commit'}
        onConfirm={() => {
          if (commitConfirm?.kind === 'undo') onUndoCommit()
          else if (commitConfirm?.kind === 'revert') onRevertCommit(commitConfirm.sha, commitConfirm.shortSha)
        }}
      />
    </>
  )
}
