/**
 * DiffTabView — one working-tree file's diff as a full-height dock tab.
 *
 * Reads the same per-file diff query as the file's expanded row in the
 * Changes list, and the shared changed-paths list for its counts, so both
 * follow the agent's writes through the normal invalidation path. The inline
 * peek in the Changes list keeps its capped height; this is the "give it the
 * whole dock" view. Its toolbar ends with Refresh (it moved here from the tab
 * strip), which reloads this diff and the changed-paths list.
 *
 * On desktop, Side by side lays the old file beside the new one. The choice
 * is kept for every diff tab; while the panel is narrower than two readable
 * columns the diff stays unified (and says so on the toggle).
 */
import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Columns2, ExternalLink, FileDiff, WrapText } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useElementWidthSelect } from '@/hooks/use-element-width'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { WORKSPACE_DIFF_STALE_MS, workspaceChangesQueryOptions, workspaceFileDiffQueryOptions } from '@/queries/workspace-git'
import { changedFilesFromResponse, fileDiffBody } from './diff-helpers'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'
import { ChangeCounts } from './ChangeCounts'
import { DockLoadError } from './DockLoadError'
import { DiffSkeleton } from './DiffSkeleton'
import { DockRefreshButton } from './DockRefreshButton'

export interface DiffTabViewProps {
  workspace: string
  path: string
  onOpenFile?: (path: string) => void
}

/** Two columns of about 45 characters each, plus their line numbers. */
const SPLIT_MIN_WIDTH = 640
const wideEnoughForSplit = (width: number) => width >= SPLIT_MIN_WIDTH

export function DiffTabView({ workspace, path, onOpenFile }: DiffTabViewProps) {
  const changes = useQuery({ ...workspaceChangesQueryOptions(workspace), staleTime: WORKSPACE_DIFF_STALE_MS })
  const diff = useQuery({ ...workspaceFileDiffQueryOptions(workspace, path), staleTime: WORKSPACE_DIFF_STALE_MS })
  const scrollRef = useScrollMemory(`diff:${workspace}:${path}`)
  const changed = useMemo(
    () => changedFilesFromResponse(changes.data).find((file) => file.path === path) ?? null,
    [changes.data, path],
  )
  const fileDiff = useMemo(() => fileDiffBody(diff.data, path), [diff.data, path])
  const canOpen = onOpenFile && changed?.status !== 'D'
  // A phone keeps lines whole and scrolls sideways, a desktop wraps them; the
  // toggle flips either default for this tab.
  const isPhone = useIsPhone()
  const [wrapChoice, setWrapChoice] = useState<boolean | null>(null)
  const wrap = wrapChoice ?? !isPhone
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useElementWidthSelect(rootRef, wideEnoughForSplit)
  const diffLayout = useDisplayPrefsStore((s) => s.diffLayout)
  const setDiffLayout = useDisplayPrefsStore((s) => s.setDiffLayout)
  const splitChosen = !isPhone && diffLayout === 'split'
  const split = splitChosen && wide
  const splitNote = splitChosen && !wide ? 'Shown unified until the panel is wider' : undefined
  const refresh = () => {
    void diff.refetch()
    void changes.refetch()
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
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
        {!isPhone && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Side by side"
                  aria-pressed={splitChosen}
                  aria-description={splitNote}
                  onClick={() => setDiffLayout(splitChosen ? 'unified' : 'split')}
                  className={DOCK_ACTION_BUTTON_CLASS}
                >
                  <Columns2 size={14} aria-hidden="true" className={split ? 'text-(--color-text)' : undefined} />
                </button>
              }
            />
            <TooltipContent side="bottom">{splitNote ?? (splitChosen ? 'Unified' : 'Side by side')}</TooltipContent>
          </Tooltip>
        )}
        {!split && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Wrap lines"
                aria-pressed={wrap}
                onClick={() => setWrapChoice(!wrap)}
                className={DOCK_ACTION_BUTTON_CLASS}
              >
                <WrapText size={14} aria-hidden="true" className={wrap ? 'text-(--color-text)' : undefined} />
              </button>
            }
          />
          <TooltipContent side="bottom">{wrap ? 'Keep lines whole' : 'Wrap lines'}</TooltipContent>
        </Tooltip>
        )}
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
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">Open file</TooltipContent>
          </Tooltip>
        )}
        <DockRefreshButton label="Refresh diff" onClick={refresh} />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto touch-pan-y">
        {diff.isLoading ? (
          <DiffSkeleton />
        ) : diff.isError ? (
          <DockLoadError message="Couldn't load the diff." onRetry={() => void diff.refetch()} retrying={diff.isFetching} />
        ) : fileDiff ? (
          <>
            {diff.data?.truncated && (
              <p className="border-b border-(--color-border-subtle) bg-(--color-warning-subtle) px-3 py-1.5 text-xs text-(--accent-orange-text)">
                This diff is too large to show in full.
              </p>
            )}
            <DiffPreview diff={fileDiff} wrap={wrap} layout={split ? 'split' : 'unified'} />
          </>
        ) : (
          <EmptyState
            icon={FileDiff}
            title={changed ? 'No diff body for this file' : 'No uncommitted changes in this file'}
            body={changed ? undefined : 'It matches the last commit.'}
          />
        )}
      </div>
    </div>
  )
}
