import { memo, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Collapsible } from '@/components/ui/collapsible'
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

/** What "Ask agent to commit" puts in the composer. It is never sent for the user. */
export const COMMIT_PROMPT = 'Commit the current changes with a clear message.'

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
  openDiffTab: (file: ChangedFileInfo) => void
  /**
   * Puts text in the composer without sending it. Without it the list has
   * no "Ask agent to commit" footer.
   */
  onInsertPrompt?: (text: string) => void
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
    return <DockLoadError message="Failed to load the diff." onRetry={() => void diff.refetch()} retrying={diff.isFetching} />
  }
  if (!body) return <p className="px-3 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>
  return (
    <>
      {diff.data?.truncated && <p className={NOTICE_CLASS}>This diff is too large to show in full.</p>}
      {/* Capped peek; the row's own click opens the diff in a tab at full height. */}
      <div className="max-h-[70vh] min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
        <DiffPreview diff={body} autoScroll={false} />
      </div>
    </>
  )
}

/**
 * The list's footer: what is changed, and the one way to commit it — asking
 * the agent, which writes the message. Stays at the bottom of the scroller.
 */
function ChangesFooter({
  changedFiles,
  total,
  truncated,
  onInsertPrompt,
}: {
  changedFiles: ChangedFileInfo[]
  total: number
  truncated: boolean
  onInsertPrompt: (text: string) => void
}) {
  const empty = changedFiles.length === 0
  const summary = useMemo(() => {
    if (empty) return 'No changes'
    const files = `${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}`
    // A capped list cannot add up the lines it left out.
    if (truncated) return files
    const additions = changedFiles.reduce((sum, file) => sum + file.additions, 0)
    const deletions = changedFiles.reduce((sum, file) => sum + file.deletions, 0)
    return [files, additions > 0 && `+${additions.toLocaleString()}`, deletions > 0 && `−${deletions.toLocaleString()}`]
      .filter(Boolean)
      .join(' · ')
  }, [changedFiles, empty, total, truncated])
  return (
    <div className="sticky bottom-0 flex min-h-(--spacing-toolbar) items-center gap-2 border-t border-(--color-border-subtle) bg-(--bg-page) px-3 py-1">
      <span className="min-w-0 flex-1 truncate text-xs text-(--color-text-muted)">{summary}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" size="sm" variant="default" disabled={empty} onClick={() => onInsertPrompt(COMMIT_PROMPT)}>
              Ask agent to commit
            </Button>
          }
        />
        <TooltipContent side="top">
          {empty ? 'No changes' : 'Puts a commit request in the composer. Nothing is sent yet.'}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

interface ChangedFileRowProps {
  workspace: string
  file: ChangedFileInfo
  selected: boolean
  expanded: boolean
  mobile: boolean
  toggleDiffExpanded: (path: string) => void
  openDiffTab: (file: ChangedFileInfo) => void
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
  openDiffTab,
  setMobileFileActions,
  setDesktopFileActions,
}: ChangedFileRowProps) {
  const openMenu = (x: number, y: number) => setDesktopFileActions({ file, x, y })
  return (
    <li>
      {/* Row: chevron peeks at the diff in place, the name opens it in a tab,
          ⋯ (always there, any platform) holds the rest — the right-click menu. */}
      <div className="flex h-(--spacing-list-row) items-center gap-0.5 pr-1 pl-1 transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60">
        <button
          type="button"
          onClick={() => toggleDiffExpanded(file.path)}
          className={ROW_ACTION}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${file.path}`}
          aria-expanded={expanded}
        >
          <ChevronRight
            size={12}
            className={cn('transition-transform duration-(--motion-instant)', expanded && 'rotate-90')}
            aria-hidden="true"
          />
        </button>
        <Tooltip className="h-full min-w-0 flex-1">
          <TooltipTrigger
            className="h-full min-w-0 flex-1"
            render={
              <LongPressButton
                type="button"
                onClick={() => openDiffTab(file)}
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
                aria-label={`Open diff tab for ${file.path}`}
              >
                <FileTypeIcon name={file.path} size={13} />
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
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
  openDiffTab,
  onInsertPrompt,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
}: GitReviewSubPanelProps) {
  const [shownRows, setShownRows] = useState(CHANGED_ROWS_PAGE)
  if (changes.isLoading || files.isLoading) return <DockListNotice>Loading changed files…</DockListNotice>
  if (changes.isError) {
    const refetch = changes.refetch
    if (!refetch) return <DockListNotice tone="error">Failed to load changed files</DockListNotice>
    return <DockLoadError message="Failed to load changed files." onRetry={() => void refetch()} retrying={changes.isFetching} />
  }
  if (!changes.data?.is_git_repo) return <DockListNotice>Not a git repository</DockListNotice>
  const footer = onInsertPrompt && (
    <ChangesFooter
      changedFiles={changedFiles}
      total={changes.data.total}
      truncated={changes.data.truncated}
      onInsertPrompt={onInsertPrompt}
    />
  )
  if (changedFiles.length === 0) {
    return (
      <div>
        <DockListNotice>No changed files</DockListNotice>
        {footer}
      </div>
    )
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
            openDiffTab={openDiffTab}
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
      {footer}
    </div>
  )
}

/** Memoized: the dock re-renders on every width change; the rows need not. */
export const GitReviewSubPanel = memo(GitReviewSubPanelView)
