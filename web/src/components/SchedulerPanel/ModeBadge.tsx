import { FolderOpen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ScheduledTaskResponse } from '@/api/types'
import { workspaceLabel } from '@/utils/workspace'

export function ModeBadge({ task }: { task: Pick<ScheduledTaskResponse, 'mode' | 'workspace'> }) {
  if (task.mode === 'coding' && task.workspace) {
    return (
      <Tooltip className="min-w-0 max-w-full">
        <TooltipTrigger
          className="min-w-0 max-w-full"
          render={
            <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-2 py-0.5 text-[11px] font-medium text-(--color-text-2)">
              <FolderOpen size={11} className="shrink-0 text-(--color-accent)" />
              <span className="truncate">coding · {workspaceLabel(task.workspace)}</span>
            </span>
          }
        />
        <TooltipContent>{task.workspace}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <span className="inline-flex items-center rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-2 py-0.5 text-[11px] font-medium text-(--color-text-muted)">
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
