import { memo } from 'react'
import { ChevronRight, ExternalLink, FileDiff } from 'lucide-react'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Collapsible } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'
import { ChangeCounts } from './ChangeCounts'
import { type ChangedFileInfo, type DiffFileSection } from './diff-helpers'
import { DOCK_ROW_ACTION_CLASS } from './dock-tab-styles'

export interface GitReviewSubPanelProps {
  workspace: string
  changedFiles: ChangedFileInfo[]
  diffSections: Map<string, DiffFileSection>
  diff: { isLoading: boolean; isError: boolean; data?: WorkspaceGitDiffResponse }
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

function GitReviewSubPanelView({
  changedFiles,
  diffSections,
  diff,
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
  if (diff.isLoading || files.isLoading) return <DockListNotice>Loading changed files…</DockListNotice>
  if (diff.isError) return <DockListNotice tone="error">Failed to load changed files</DockListNotice>
  if (!diff.data?.is_git_repo) return <DockListNotice>Not a git repository</DockListNotice>
  if (changedFiles.length === 0) return <DockListNotice>No changed files</DockListNotice>

  return (
    <div>
      {diff.data.truncated && (
        <p className="border-b border-(--color-border-subtle) bg-(--color-warning)/10 px-3 py-1.5 text-xs text-(--color-warning)">
          Changed list may be incomplete because the diff was truncated.
        </p>
      )}
      <ul aria-label="Changed files" className="divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)">
        {changedFiles.map((changedFile) => {
          const isSelected = selectedFilePath === changedFile.path
          const expanded = expandedDiffs.has(changedFile.path)
          const fileDiff = diffSections.get(changedFile.path)?.diff
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
                  {fileDiff ? (
                    // Capped peek; "Open diff in tab" gives the full height.
                    <div className="max-h-[70vh] min-h-0 overflow-x-hidden overflow-y-auto touch-pan-y">
                      <DiffPreview diff={fileDiff} autoScroll={false} />
                    </div>
                  ) : (
                    <p className="px-3 py-3 text-xs text-(--color-text-subtle)">No diff body for this file.</p>
                  )}
                </div>
              </Collapsible>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Memoized: the dock re-renders on every width change; the rows need not. */
export const GitReviewSubPanel = memo(GitReviewSubPanelView)
