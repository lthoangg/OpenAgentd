import { FolderOpen } from 'lucide-react'
import type { ScheduledTaskResponse } from '@/api/types'
import { workspaceLabel } from '@/utils/workspace'

export function ModeBadge({ task }: { task: Pick<ScheduledTaskResponse, 'mode' | 'workspace'> }) {
  if (task.mode === 'coding' && task.workspace) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1 truncate rounded-xs border border-(--color-border) bg-(--bg-key)/70 px-2 py-0.5 text-xs text-(--color-text-2)"
        title={task.workspace}
      >
        <FolderOpen size={10} className="shrink-0" />
        <span className="truncate">coding · {workspaceLabel(task.workspace)}</span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-xs border border-(--color-border) bg-(--bg-key)/70 px-2 py-0.5 text-xs text-(--color-text-2)">
      normal
    </span>
  )
}

/**
 * Mode toggle + workspace input — shared between Create and Edit forms.
 *
 * Workspace control:
 *   - When the caller has a context workspace (scheduler opened inside a
 *     coding chat), the input pre-fills with that path. The user can still
 *     edit it or switch modes.
 *   - Saved coding workspaces from localStorage are surfaced as quick-pick
 *     suggestions via a small `<Select>` next to the path input.
 */
/**
 * Internal subcomponent — exported solely for unit testing the mode/workspace
 * toggle contract. Not part of the public ``SchedulerPanel`` API; do not
 * consume from other modules.
 */
