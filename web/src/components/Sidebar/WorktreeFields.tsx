/**
 * The Create worktree dialog's fields: one name. The branch follows from it
 * (``openagentd/<name>``, as the server derives it) and is shown as a line;
 * "Change" opens a field for the case where it should differ.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'

const INPUT_CLASS = 'min-h-9 w-full min-w-0 rounded-sm border border-(--color-border) bg-(--bg-page) px-2.5 py-1 font-mono text-xs text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:outline-none focus:border-(--color-text-subtle) md:min-h-8 max-md:pointer-coarse:text-base'

/** The branch the server gives a worktree named ``name`` when none is sent (``worktrees.rs``: slug, then ``openagentd/``). */
export function defaultWorktreeBranch(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/^-+|-+$/g, '')
  return `openagentd/${slug || 'session'}`
}

export function WorktreeFields({ name, branch, onNameChange, onBranchChange }: {
  name: string
  /** Empty while the branch is left to follow the name. */
  branch: string
  onNameChange: (name: string) => void
  onBranchChange: (branch: string) => void
}) {
  const [editingBranch, setEditingBranch] = useState(branch !== '')
  const derived = defaultWorktreeBranch(name)

  return (
    <div className="space-y-2.5">
      <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="feature-login"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={INPUT_CLASS}
          maxLength={80}
          autoFocus
        />
      </label>
      {editingBranch ? (
        <label className="block space-y-1 text-xs font-medium text-(--color-text-2)">
          <span>Branch</span>
          <input
            value={branch}
            onChange={(e) => onBranchChange(e.target.value)}
            placeholder={derived}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={INPUT_CLASS}
            maxLength={255}
          />
        </label>
      ) : (
        <p className="flex min-w-0 items-center gap-2 text-xs text-(--color-text-muted)">
          <span className="shrink-0">Branch</span>
          <span className="min-w-0 truncate font-mono text-(--color-text-2)">{derived}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="shrink-0 px-0"
            onClick={() => { onBranchChange(derived); setEditingBranch(true) }}
          >
            Change
          </Button>
        </p>
      )}
    </div>
  )
}
