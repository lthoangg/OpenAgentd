import { memo, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, GitCompare, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Collapsible } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { ROW_ACTION } from '@/components/ui/list-row'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import { WORKSPACE_DIFF_STALE_MS, workspaceFileDiffQueryOptions } from '@/queries/workspace-git'
import type { WorkspaceChangesResponse, WorkspaceFileInfo } from '@/api/types'
import { ChangeCounts } from './ChangeCounts'
import { type ChangedFileInfo, fileDiffBody } from './diff-helpers'
import { DockLoadError } from './DockLoadError'

/** Rows rendered per step; thousands of untracked files must not stall a render. */
export const CHANGED_ROWS_PAGE = 200

/** Where a row's ⋯ menu opens, relative to the button: under it, right edge aligned. */
const ROW_MENU_WIDTH = 176

export interface GitReviewSubPanelProps {
  workspace: string
  changedFiles: ChangedFileInfo[]
  changes: {
    isLoading: boolean
    isError: boolean
    isFetching?: boolean
    refetch?: () => Promise<unknown>
    data?: WorkspaceChangesResponse
  }
  files: { isLoading: boolean; data?: { files: WorkspaceFileInfo[] } }
  selectedFilePath: string | null
  expandedDiffs: Set<string>
  toggleDiffExpanded: (path: string) => void
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

const NOTICE_CLASS = 'border-b border-(--color-border-subtle) bg-(--color-warning-subtle) px-3 py-1.5 text-xs text-(--accent-orange-text)'

/** An expanded row's diff: fetched for this file alone, only while open. */
function ChangedFileDiff({ workspace, path }: { workspace: string; path: string }) {
  const diff = useQuery({ ...workspaceFileDiffQueryOptions(workspace, path), staleTime: WORKSPACE_DIFF_STALE_MS })
  const body = useMemo(() => fileDiffBody(diff.data, path), [diff.data, path])
  if (diff.isLoading) return <p className="px-3 py-3 text-xs text-(--color-text-subtle)">Loading diff…</p>
  if (diff.isError) {
    return <DockLoadError message="Couldn't load the diff." onRetry={() => void diff.refetch()} retrying={diff.isFetching} />
  }
  if (!body) return <p className="px-3 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>
  return (
    <>
      {diff.data?.truncated && <p className={NOTICE_CLASS}>This diff is too large to show in full.</p>}
      {/* Capped peek; "Open diff in tab" (the row's menu) shows it at full height. */}
      <div className="max-h-[70vh] min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
        <DiffPreview diff={body} autoScroll={false} />
      </div>
    </>
  )
}

interface ChangedFileRowProps {
  workspace: string
  file: ChangedFileInfo
  selected: boolean
  expanded: boolean
  mobile: boolean
  toggleDiffExpanded: (path: string) => void
  setMobileFileActions: GitReviewSubPanelProps['setMobileFileActions']
  setDesktopFileActions: GitReviewSubPanelProps['setDesktopFileActions']
}

/**
 * One changed file. Memoized with the dock's stable callbacks, so opening one
 * peek, or showing 200 more rows, renders only the rows that changed.
 */
const ChangedFileRow = memo(function ChangedFileRow({
  workspace,
  file,
  selected,
  expanded,
  mobile,
  toggleDiffExpanded,
  setMobileFileActions,
  setDesktopFileActions,
}: ChangedFileRowProps) {
  const openMenu = (x: number, y: number) => setDesktopFileActions({ file, x, y })
  const { name, folder } = splitRepoPath(file.path)
  return (
    <li>
      {/* Row: a click shows or hides the diff in place; ⋯ (always there, any
          platform) holds the rest — the right-click menu, with Open diff in tab. */}
      <div className="flex h-(--spacing-list-row) items-center gap-0.5 pr-1 pl-1 transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60">
        <Tooltip className="h-full min-w-0 flex-1">
          <TooltipTrigger
            className="h-full min-w-0 flex-1"
            render={
              <LongPressButton
                type="button"
                onClick={() => toggleDiffExpanded(file.path)}
                enabled={mobile}
                onLongPress={() => setMobileFileActions(file)}
                onContextMenu={(e) => {
                  if (mobile) return
                  e.preventDefault()
                  openMenu(e.clientX, e.clientY)
                }}
                onKeyDown={(e) => {
                  if (mobile || !isMenuKey(e)) return
                  e.preventDefault()
                  const at = menuPointFor(e.currentTarget)
                  openMenu(at.clientX, at.clientY)
                }}
                className={cn(
                  'flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 pl-1 text-left text-xs outline-none hover:text-(--color-text) focus-key:bg-(--bg-key)/60',
                  selected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                )}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${file.path}`}
                aria-expanded={expanded}
              >
                <span className="grid size-5 shrink-0 place-items-center text-(--color-text-muted)" aria-hidden="true">
                  <ChevronRight
                    size={12}
                    className={cn('transition-transform duration-(--motion-instant)', expanded && 'rotate-90')}
                  />
                </span>
                <FileTypeIcon name={file.path} size={13} />
                {/* The name first, its folder after it in muted text (as
                    source control lists do): a path cut at the end hid the
                    one part that tells the files apart. */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono">
                  <span className="max-w-full shrink-0 truncate">{name}</span>
                  {folder && <span className="min-w-0 truncate text-meta text-(--color-text-muted)">{folder}</span>}
                </span>
                <ChangeCounts file={file} />
              </LongPressButton>
            }
          />
          <TooltipContent>{file.path}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={(e) => {
                  if (mobile) {
                    setMobileFileActions(file)
                    return
                  }
                  const rect = e.currentTarget.getBoundingClientRect()
                  openMenu(rect.right - ROW_MENU_WIDTH, rect.bottom + 2)
                }}
                className={ROW_ACTION}
                aria-haspopup="menu"
                aria-label={`More actions for ${file.path}`}
              >
                <MoreHorizontal size={12} aria-hidden="true" />
              </button>
            }
          />
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
      </div>

      <Collapsible open={expanded}>
        <div className="border-t border-(--color-border-subtle)">
          <ChangedFileDiff workspace={workspace} path={file.path} />
        </div>
      </Collapsible>
    </li>
  )
})

function GitReviewSubPanelView({
  workspace,
  changedFiles,
  changes,
  files,
  selectedFilePath,
  expandedDiffs,
  toggleDiffExpanded,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
}: GitReviewSubPanelProps) {
  const [shownRows, setShownRows] = useState(CHANGED_ROWS_PAGE)
  if (changes.isLoading || files.isLoading) return <DockListNotice>Loading changed files…</DockListNotice>
  if (changes.isError) {
    const refetch = changes.refetch
    if (!refetch) return <DockListNotice tone="error">Couldn&apos;t load changed files.</DockListNotice>
    return <DockLoadError message="Couldn't load changed files." onRetry={() => void refetch()} retrying={changes.isFetching} />
  }
  if (!changes.data?.is_git_repo) {
    // The Git toolbar (with its Refresh) shows only inside a repository, so the
    // empty state carries the way to look again after a ``git init``.
    const refetch = changes.refetch
    return (
      <EmptyState
        icon={GitCompare}
        title="Not a git repository"
        body="Run git init in this folder to review its changes here."
        action={refetch ? <Button size="sm" onClick={() => void refetch()}>Refresh</Button> : undefined}
      />
    )
  }
  if (changedFiles.length === 0) {
    return <EmptyState icon={GitCompare} title="No changes" body="Files that change in this workspace show up here." />
  }

  const hiddenRows = changedFiles.length - shownRows
  return (
    <div>
      {changes.data.truncated && (
        <p className={NOTICE_CLASS}>
          Showing {changedFiles.length.toLocaleString()} of {changes.data.total.toLocaleString()} changed files.
        </p>
      )}
      <ul aria-label="Changed files" className="divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)">
        {changedFiles.slice(0, shownRows).map((changedFile) => (
          <ChangedFileRow
            key={changedFile.path}
            workspace={workspace}
            file={changedFile}
            selected={selectedFilePath === changedFile.path}
            expanded={expandedDiffs.has(changedFile.path)}
            mobile={mobile}
            toggleDiffExpanded={toggleDiffExpanded}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        ))}
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

/** `a/b/c.ts` → `c.ts` in `a/b`; an untracked folder (`a/new/`) keeps its slash. */
function splitRepoPath(path: string): { name: string; folder: string } {
  const slash = path.endsWith('/') ? '/' : ''
  const trimmed = slash ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at > 0 ? { name: trimmed.slice(at + 1) + slash, folder: trimmed.slice(0, at) } : { name: path, folder: '' }
}
