import { FolderOpen } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ScheduledTaskResponse } from '@/api/types'
import { workspaceLabel } from '@/utils/workspace'

export function WorkspaceBadge({ task }: { task: Pick<ScheduledTaskResponse, 'workspace'> }) {
  if (task.workspace) {
    return (
      <Tooltip className="min-w-0 max-w-full">
        <TooltipTrigger
          className="min-w-0 max-w-full"
          render={
            <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-xs border border-(--color-border-subtle) bg-(--bg-key)/80 px-2 py-0.5 text-[11px] font-medium text-(--color-text-2)">
              <FolderOpen size={11} className="shrink-0 text-(--color-accent)" />
              <span className="truncate">{workspaceLabel(task.workspace)}</span>
            </span>
          }
        />
        <TooltipContent>{task.workspace}</TooltipContent>
      </Tooltip>
    )
  }
  return null
}
