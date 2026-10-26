/**
 * DiffTabView — one working-tree file's diff as a full-height dock tab.
 *
 * Reads the same per-file diff query as the file's expanded row in the
 * Changes list, and the shared changed-paths list for its counts, so both
 * follow the agent's writes through the normal invalidation path. The inline
 * peek in the Changes list keeps its capped height; this is the "give it the
 * whole dock" view.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { WORKSPACE_DIFF_STALE_MS, workspaceChangesQueryOptions, workspaceFileDiffQueryOptions } from '@/queries/workspace-git'
import { changedFilesFromResponse, fileDiffBody } from './diff-helpers'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'
import { ChangeCounts } from './ChangeCounts'
import { DockLoadError } from './DockLoadError'

export interface DiffTabViewProps {
  workspace: string
  path: string
  onOpenFile?: (path: string) => void
}

export function DiffTabView({ workspace, path, onOpenFile }: DiffTabViewProps) {
  const changes = useQuery({ ...workspaceChangesQueryOptions(workspace), staleTime: WORKSPACE_DIFF_STALE_MS })
  const diff = useQuery({ ...workspaceFileDiffQueryOptions(workspace, path), staleTime: WORKSPACE_DIFF_STALE_MS })
  const changed = useMemo(
    () => changedFilesFromResponse(changes.data).find((file) => file.path === path) ?? null,
    [changes.data, path],
  )
  const fileDiff = useMemo(() => fileDiffBody(diff.data, path), [diff.data, path])
  const canOpen = onOpenFile && changed?.status !== 'D'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) pr-1 pl-3">
        <FileTypeIcon name={path} size={13} />
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            className="min-w-0 flex-1"
            render={<span className="truncate font-mono text-xs text-(--color-text)">{path}</span>}
          />
          <TooltipContent side="bottom">{path}</TooltipContent>
        </Tooltip>
        {changed && <ChangeCounts file={changed} />}
        {canOpen && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => onOpenFile(path)}
                  className={DOCK_ACTION_BUTTON_CLASS}
                  aria-label={`Open ${path}`}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">Open file</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto touch-pan-y">
        {diff.isLoading ? (
          <p className="px-3 py-4 text-xs text-(--color-text-subtle)">Loading diff…</p>
        ) : diff.isError ? (
          <DockLoadError message="Failed to load the diff." onRetry={() => void diff.refetch()} retrying={diff.isFetching} />
        ) : fileDiff ? (
          <>
            {diff.data?.truncated && (
              <p className="border-b border-(--color-border-subtle) bg-(--color-warning)/10 px-3 py-1.5 text-xs text-(--color-warning)">
                This diff is too large to show in full.
              </p>
            )}
            <DiffPreview diff={fileDiff} />
          </>
        ) : (
          <p className="px-3 py-4 text-xs text-(--color-text-subtle)">
            {changed ? 'No diff body for this file.' : 'No uncommitted changes in this file.'}
          </p>
        )}
      </div>
    </div>
  )
}
