import { memo, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink, FileDiff } from 'lucide-react'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Collapsible } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import { WORKSPACE_DIFF_STALE_MS, workspaceFileDiffQueryOptions } from '@/queries/workspace-git'
import type { WorkspaceChangesResponse, WorkspaceFileInfo } from '@/api/types'
import { ChangeCounts } from './ChangeCounts'
import { type ChangedFileInfo, fileDiffBody } from './diff-helpers'
import { DOCK_ROW_ACTION_CLASS } from './dock-tab-styles'
import { DockLoadError } from './DockLoadError'

/** Rows rendered per step; thousands of untracked files must not stall a render. */
export const CHANGED_ROWS_PAGE = 200

export interface GitReviewSubPanelProps {
  workspace: string
  changedFiles: ChangedFileInfo[]
  changes: { isLoading: boolean; isError: boolean; data?: WorkspaceChangesResponse }
  files: { isLoading: boolean; data?: { files: WorkspaceFileInfo[] } }
  selectedFilePath: string | null
  expandedDiffs: Set<string>
  toggleDiffExpanded: (path: string) => void
  openChangedFile: (path: string) => void
  openDiffTab: (file: ChangedFileInfo) => void
  mobile?: boolean
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

/** Empty / loading / error line for a dock list view. */
export function DockListNotice({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'error' }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn('px-3 py-4 text-xs', tone === 'error' ? 'text-(--color-error)' : 'text-(--color-text-subtle)')}
    >
      {children}
    </p>
  )
}

const NOTICE_CLASS = 'border-b border-(--color-border-subtle) bg-(--color-warning)/10 px-3 py-1.5 text-xs text-(--color-warning)'

/** An expanded row's diff: fetched for this file alone, only while open. */
function ChangedFileDiff({ workspace, path }: { workspace: string; path: string }) {
  const diff = useQuery({ ...workspaceFileDiffQueryOptions(workspace, path), staleTime: WORKSPACE_DIFF_STALE_MS })
  const body = useMemo(() => fileDiffBody(diff.data, path), [diff.data, path])
  if (diff.isLoading) return <p className="px-3 py-3 text-xs text-(--color-text-subtle)">Loading diff…</p>
  if (diff.isError) {
    return <DockLoadError message="Failed to load the diff." onRetry={() => void diff.refetch()} retrying={diff.isFetching} />
  }
  if (!body) return <p className="px-3 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>
  return (
    <>
      {diff.data?.truncated && <p className={NOTICE_CLASS}>This diff is too large to show in full.</p>}
      {/* Capped peek; "Open diff in tab" gives the full height. */}
      <div className="max-h-[70vh] min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
        <DiffPreview diff={body} autoScroll={false} />
      </div>
    </>
  )
}

function GitReviewSubPanelView({
  workspace,
  changedFiles,
  changes,
  files,
  selectedFilePath,
  expandedDiffs,
  toggleDiffExpanded,
  openChangedFile,
  openDiffTab,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
}: GitReviewSubPanelProps) {
  const [shownRows, setShownRows] = useState(CHANGED_ROWS_PAGE)
  if (changes.isLoading || files.isLoading) return <DockListNotice>Loading changed files…</DockListNotice>
  if (changes.isError) return <DockListNotice tone="error">Failed to load changed files</DockListNotice>
  if (!changes.data?.is_git_repo) return <DockListNotice>Not a git repository</DockListNotice>
  if (changedFiles.length === 0) return <DockListNotice>No changed files</DockListNotice>

  const hiddenRows = changedFiles.length - shownRows
  return (
    <div>
      {changes.data.truncated && (
        <p className={NOTICE_CLASS}>
          Showing {changedFiles.length.toLocaleString()} of {changes.data.total.toLocaleString()} changed files.
        </p>
      )}
      <ul aria-label="Changed files" className="divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)">
        {changedFiles.slice(0, shownRows).map((changedFile) => {
          const isSelected = selectedFilePath === changedFile.path
          const expanded = expandedDiffs.has(changedFile.path)
          return (
            <li key={changedFile.path}>
              <div className="group/row flex h-(--spacing-list-row) items-center pr-2 transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60">
                <Tooltip className="h-full min-w-0 flex-1">
                  <TooltipTrigger
                    className="h-full min-w-0 flex-1"
                    render={
                      <LongPressButton
                        type="button"
                        onClick={() => toggleDiffExpanded(changedFile.path)}
                        enabled={mobile}
                        onLongPress={() => setMobileFileActions(changedFile)}
                        onContextMenu={(e) => {
                          if (mobile) return
                          e.preventDefault()
                          setDesktopFileActions({ file: changedFile, x: e.clientX, y: e.clientY })
                        }}
                        onKeyDown={(e) => {
                          if (mobile || !isMenuKey(e)) return
                          e.preventDefault()
                          const at = menuPointFor(e.currentTarget)
                          setDesktopFileActions({ file: changedFile, x: at.clientX, y: at.clientY })
                        }}
                        className={cn(
                          'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-3 text-left text-xs outline-none hover:text-(--color-text) focus-key:bg-(--bg-key)/60',
                          isSelected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                        )}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${changedFile.path}`}
                        aria-expanded={expanded}
                      >
                        <ChevronRight
                          size={12}
                          className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')}
                          aria-hidden="true"
                        />
                        <FileTypeIcon name={changedFile.path} size={13} />
                        <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                        {/* Counts give way to the row actions on hover/focus (desktop). */}
                        <ChangeCounts
                          file={changedFile}
                          className={mobile ? undefined : 'md:group-hover/row:hidden md:group-focus-within/row:hidden'}
                        />
                      </LongPressButton>
                    }
                  />
                  <TooltipContent>{changedFile.path}</TooltipContent>
                </Tooltip>
                {!mobile && (
                  <div className="hidden shrink-0 items-center gap-0.5 md:group-hover/row:flex md:group-focus-within/row:flex">
                    <button
                      type="button"
                      onClick={() => openDiffTab(changedFile)}
                      className={DOCK_ROW_ACTION_CLASS}
                      aria-label={`Open diff tab for ${changedFile.path}`}
                      title="Open diff in tab"
                    >
                      <FileDiff size={12} aria-hidden="true" />
                    </button>
                    {changedFile.status !== 'D' && (
                      <button
                        type="button"
                        onClick={() => openChangedFile(changedFile.path)}
                        className={DOCK_ROW_ACTION_CLASS}
                        aria-label={`Open ${changedFile.path}`}
                        title="Open file"
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>

              <Collapsible open={expanded}>
                <div className="border-t border-(--color-border-subtle)">
                  <ChangedFileDiff workspace={workspace} path={changedFile.path} />
                </div>
              </Collapsible>
            </li>
          )
        })}
      </ul>
      {hiddenRows > 0 && (
        <button
          type="button"
          onClick={() => setShownRows((n) => n + CHANGED_ROWS_PAGE)}
          className="flex h-(--spacing-list-row) w-full cursor-pointer items-center px-3 text-left text-xs text-(--color-text-subtle) outline-none hover:bg-(--bg-key)/60 hover:text-(--color-text) focus-key:bg-(--bg-key)/60"
        >
          Show {Math.min(hiddenRows, CHANGED_ROWS_PAGE).toLocaleString()} more ({hiddenRows.toLocaleString()} not shown)
        </button>
      )}
    </div>
  )
}

/** Memoized: the dock re-renders on every width change; the rows need not. */
export const GitReviewSubPanel = memo(GitReviewSubPanelView)
