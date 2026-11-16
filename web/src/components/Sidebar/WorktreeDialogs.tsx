/** The worktree dialogs: Create worktree and Rename worktree. */
import { Folder } from 'lucide-react'
import { workspaceLabel } from '@/utils/workspace'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WorktreeFields } from './WorktreeFields'
import type { WorktreeActions } from './useWorktreeActions'

export function CreateWorktreeDialog({ worktrees, error }: { worktrees: WorktreeActions; error: string | null }) {
  const { worktreeTarget, setWorktreeTarget, worktreeName, setWorktreeName, worktreeBranch, setWorktreeBranch, worktreeLoading, submitWorktree } = worktrees
  return (
    <Dialog
      open={worktreeTarget !== null}
      onOpenChange={(open) => { if (!open) setWorktreeTarget(null) }}
    >
      <DialogContent size="lg">
        <form onSubmit={submitWorktree} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Create worktree</DialogTitle>
            <DialogDescription>
              Isolated copy of {worktreeTarget ? workspaceLabel(worktreeTarget) : 'this workspace'}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <div className="rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5">
              <div className="mb-0.5 flex items-center gap-1.5 label-caps text-(--color-text-subtle)">
                <Folder size={12} aria-hidden="true" />
                Source workspace
              </div>
              {worktreeTarget ? (
                <Tooltip className="min-w-0">
                  <TooltipTrigger
                    className="min-w-0"
                    render={<p className="truncate font-mono text-meta text-(--color-text-muted)">{worktreeTarget}</p>}
                  />
                  <TooltipContent>{worktreeTarget}</TooltipContent>
                </Tooltip>
              ) : (
                <p className="truncate font-mono text-meta text-(--color-text-muted)" />
              )}
            </div>
            <WorktreeFields
              name={worktreeName}
              branch={worktreeBranch}
              onNameChange={setWorktreeName}
              onBranchChange={setWorktreeBranch}
            />
            {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setWorktreeTarget(null)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={worktreeLoading}>
              {worktreeLoading ? 'Creating…' : 'Create and open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RenameWorktreeDialog({ worktrees, error }: { worktrees: WorktreeActions; error: string | null }) {
  const { worktreeEditTarget, setWorktreeEditTarget, worktreeEditTitle, setWorktreeEditTitle, worktreeEditLoading, worktreeEditInputRef, submitWorktreeTitle } = worktrees
  return (
    <Dialog
      open={worktreeEditTarget !== null}
      onOpenChange={(open) => { if (!open) setWorktreeEditTarget(null) }}
    >
      <DialogContent size="xs" padding="compact">
        <form onSubmit={submitWorktreeTitle} className="space-y-3">
          <DialogHeader>
            <DialogTitle>Rename worktree</DialogTitle>
            {worktreeEditTarget?.directory ? (
              <Tooltip className="min-w-0">
                <TooltipTrigger
                  className="min-w-0"
                  render={<DialogDescription className="max-w-full truncate text-xs leading-4">{workspaceLabel(worktreeEditTarget.directory)}</DialogDescription>}
                />
                <TooltipContent>{worktreeEditTarget.directory}</TooltipContent>
              </Tooltip>
            ) : (
              <DialogDescription className="max-w-full truncate text-xs leading-4">Rename this sidebar item.</DialogDescription>
            )}
          </DialogHeader>
          <div>
            <input
              ref={worktreeEditInputRef}
              value={worktreeEditTitle}
              onChange={(e) => setWorktreeEditTitle(e.target.value)}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 text-xs text-(--color-text) outline-none transition-colors focus:outline-none focus:border-(--color-text-subtle) md:min-h-8 max-md:pointer-coarse:text-base"
              aria-label="Worktree title"
              maxLength={255}
            />
            {error && <p className="mt-2 text-xs text-(--color-error)">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setWorktreeEditTarget(null)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!worktreeEditTitle.trim() || worktreeEditLoading}>
              {worktreeEditLoading ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
