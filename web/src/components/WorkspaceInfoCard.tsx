/**
 * WorkspaceInfoCard — coding-mode empty-state placeholder.
 *
 * Rendered inside ``AgentView`` (via the ``emptyState`` slot) when the user
 * is in coding mode and hasn't sent a message yet. Replaces the generic
 * "what's on your mind?" mascot with concrete context about the workspace
 * the agent is bound to: name, path, git branch, dirty counts, last commit.
 *
 * Backed by ``GET /api/agent/workspace/status``. Fetched once on mount;
 * manual refresh via the button — no polling.
 */

import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { Folder, GitBranch, RefreshCw } from 'lucide-react'
import { formatFullDateTime } from '@/utils/format'

import { getCodingWorkspaceStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { queryKeys } from '@/queries'
import { workspaceLabel } from '@/utils/workspace'

interface Props {
  workspace: string
}

export function WorkspaceInfoCard({ workspace }: Props) {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: () => getCodingWorkspaceStatus(workspace),
    // Workspace status is informational and can be reused across route
    // transitions; cache briefly to avoid duplicate git status probes when
    // coding views remount for the same workspace.
    staleTime: 30_000,
  })

  const name = data?.name ?? workspaceLabel(workspace)
  const dirty = data?.dirty
  const dirtyTotal = dirty ? dirty.staged + dirty.unstaged + dirty.untracked : 0

  return (
    <div className="mx-auto w-full max-w-md px-4 py-4">
      <div className="flex min-w-0 items-center gap-2">
        <Folder size={16} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <Tooltip className="min-w-0">
          <TooltipTrigger
            className="min-w-0"
            render={<h2 className="truncate text-sm font-medium text-(--color-text)">{name}</h2>}
          />
          <TooltipContent>{name}</TooltipContent>
        </Tooltip>
      </div>

      <Tooltip className="mt-1 w-full">
        <TooltipTrigger
          className="w-full"
          render={<p className="mt-1 truncate font-mono text-xs text-(--color-text-muted)">{workspace}</p>}
        />
        <TooltipContent>{workspace}</TooltipContent>
      </Tooltip>

      {isLoading ? (
        <p className="mt-3 text-xs text-(--color-text-subtle)">Loading…</p>
      ) : isError ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="text-xs text-(--color-error)">Could not load workspace status</p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={isFetching}
            onClick={() => { void refetch() }}
            aria-label="Retry workspace status"
          >
            <RefreshCw className={isFetching ? 'animate-spin' : ''} aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : data?.is_git_repo ? (
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.branch && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex items-center gap-1 text-(--color-text-2)">
                      <GitBranch size={11} aria-hidden="true" />
                      <span className="font-mono">{data.branch}</span>
                    </span>
                  }
                />
                <TooltipContent>Current branch</TooltipContent>
              </Tooltip>
            )}
            {dirty && dirtyTotal > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="font-mono text-(--color-text-muted)">
                      {dirty.staged > 0 && <span className="text-(--color-success)">+{dirty.staged}</span>}
                      {dirty.staged > 0 && (dirty.unstaged > 0 || dirty.untracked > 0) && ' '}
                      {dirty.unstaged > 0 && <span className="text-(--color-warning)">~{dirty.unstaged}</span>}
                      {dirty.unstaged > 0 && dirty.untracked > 0 && ' '}
                      {dirty.untracked > 0 && <span className="text-(--color-text-subtle)">?{dirty.untracked}</span>}
                    </span>
                  }
                />
                <TooltipContent>staged · unstaged · untracked</TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-(--color-text-subtle)">clean</span>
            )}
          </div>

          {data.head && (
            <div className="flex items-baseline gap-2 text-(--color-text-muted)">
              <span className="font-mono text-(--color-text-2)">{data.head.sha}</span>
              <Tooltip className="min-w-0 flex-1">
                <TooltipTrigger
                  className="min-w-0 flex-1"
                  render={<span className="min-w-0 flex-1 truncate">{data.head.subject}</span>}
                />
                <TooltipContent>{data.head.subject}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="shrink-0 text-(--color-text-subtle)">
                      {formatDistanceToNowStrict(new Date(data.head.timestamp * 1000), { addSuffix: true })}
                    </span>
                  }
                />
                <TooltipContent>{formatFullDateTime(new Date(data.head.timestamp * 1000))}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-(--color-text-subtle)">Not a git repository</p>
      )}
    </div>
  )
}
