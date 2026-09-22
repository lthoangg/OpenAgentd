/**
 * WorkspaceInfoCard — coding-mode empty-state placeholder.
 *
 * Rendered inside ``AgentView`` (via the ``emptyState`` slot) when the user
 * is in coding mode and hasn't sent a message yet. Replaces the generic
 * "what's on your mind?" mascot with concrete context about the workspace
 * the agent is bound to: name, path, git branch, dirty counts, last commit.
 *
 * The chat workspace renders a chat variant instead: its root is the user's
 * home directory, so the path, git branch, and dirty counts are noise (and
 * the path would just echo the account name). Pass ``chatWorkspace`` to get
 * that variant — it also skips the git status request entirely.
 *
 * Backed by ``GET /api/agent/workspace/status``. Fetched once on mount;
 * manual refresh via the button — no polling.
 *
 * The starter action chips are desktop-only. On a phone the empty state is
 * already competing with the composer and the keyboard, and the same actions
 * are reachable from the composer and the chat actions drawer.
 */

import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { Folder, GitBranch, MessageCircle, RefreshCw } from 'lucide-react'
import { formatFullDateTime } from '@/utils/format'

import { getCodingWorkspaceStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { queryKeys } from '@/queries'
import { workspaceLabel } from '@/utils/workspace'

interface Props {
  workspace: string
  /** True when ``workspace`` is the chat root (see ``useChatWorkspace``). */
  chatWorkspace?: boolean
  onAsk?: () => void
  onInit?: () => void
  onOpenTerminal?: () => void
}

export function WorkspaceInfoCard({ workspace, chatWorkspace = false, onAsk, onInit, onOpenTerminal }: Props) {
  const isMobile = useIsMobile()
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    // Chat has no repository to report on, so the git-shaped request is
    // skipped rather than rendered as "Not a git repository".
    enabled: !chatWorkspace,
    // Workspace status is informational and can be reused across route
    // transitions; cache briefly to avoid duplicate git status probes when
    // coding views remount for the same workspace.
    staleTime: 30_000,
  })

  if (chatWorkspace) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-4">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircle size={16} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
          <h2 className="truncate text-sm font-medium text-(--color-text)">Chat</h2>
        </div>
        <p className="mt-2 text-xs text-(--color-text-muted)">
          OpenAgentd runs here, in your home directory. Ask about your own files by
          name, type <span className="font-medium text-(--color-text-2)">@</span> to
          reference one, or drop a file into the composer.
        </p>
      </div>
    )
  }

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

      {!isMobile && (onAsk || onInit || onOpenTerminal) && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {onAsk && (
            <Button type="button" size="xs" variant="subtle" onClick={onAsk}>
              Ask about this repo
            </Button>
          )}
          {onInit && (
            <Button type="button" size="xs" variant="subtle" onClick={onInit}>
              Generate AGENTS.md
            </Button>
          )}
          {onOpenTerminal && (
            <Button type="button" size="xs" variant="subtle" onClick={onOpenTerminal}>
              Open terminal
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
