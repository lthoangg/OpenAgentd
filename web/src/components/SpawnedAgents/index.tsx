import { memo } from 'react'
import { useRouter } from '@tanstack/react-router'
import { GitBranch } from 'lucide-react'
import { useTeamAgentsQuery } from '@/queries'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SpawnedAgentSummary } from '@/api/types'

interface SpawnedAgentsProps {
  workspace: string | null
  sessionId: string | null
}

export const SpawnedAgents = memo(function SpawnedAgents({
  workspace,
  sessionId,
}: SpawnedAgentsProps) {
  const router = useRouter()
  const { data: teamAgentsData } = useTeamAgentsQuery(workspace, Boolean(workspace), sessionId)
  const children = teamAgentsData?.children ?? []

  if (children.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 no-scrollbar" role="region" aria-label="Spawned agents">
      {children.map((child: SpawnedAgentSummary) => {
        const isRunning = child.running || child.state === 'working' || child.state === 'busy'
        return (
          <Tooltip key={child.session_id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => {
                    void router.navigate({
                      to: '/coding/$sessionId',
                      params: { sessionId: child.session_id },
                    })
                  }}
                  className="flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-full border border-(--color-border) bg-(--bg-card) px-2.5 text-xs text-(--color-text) transition-colors hover:bg-(--bg-key) hover:border-(--color-border-strong) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--focus-ring)"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isRunning ? 'animate-pulse bg-(--color-accent)' : 'bg-(--color-text-muted)'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="truncate font-mono text-[11px]">{child.name}</span>
                  {child.branch && (
                    <span className="flex shrink-0 items-center text-[10px] text-(--color-text-muted)">
                      <GitBranch size={10} className="mr-0.5" aria-hidden="true" />
                      <span className="truncate max-w-[70px]">{child.branch}</span>
                    </span>
                  )}
                </button>
              }
            />
            <TooltipContent>
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold">{child.name}</span>
                <span className="text-[10px] text-(--color-text-muted)">Branch: {child.branch || 'unknown'}</span>
                <span className="text-[10px] text-(--color-text-muted)">State: {child.state}</span>
                <span className="text-[10px] text-(--color-text-muted)">Click to open session</span>
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
})
