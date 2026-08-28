import { ChevronRight, ExternalLink } from 'lucide-react'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../CodingFileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { cn } from '@/lib/utils'
import type { WorkspaceFileInfo, WorkspaceGitDiffResponse } from '@/api/types'
import {
  type ChangedFileInfo,
  type DiffFileSection,
  CHANGED_STATUS_LABELS,
} from './diff-helpers'

export interface GitReviewSubPanelProps {
  workspace: string
  changedFiles: ChangedFileInfo[]
  diffSections: Map<string, DiffFileSection>
  diff: { isLoading: boolean; isError: boolean; data?: WorkspaceGitDiffResponse }
  files: { isLoading: boolean; data?: { files: WorkspaceFileInfo[] } }
  selectedFilePath: string | null
  expandedDiffs: Set<string>
  toggleDiffExpanded: (path: string) => void
  openFileTab: (file: WorkspaceFileInfo) => void
  mobile?: boolean
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

export function GitReviewSubPanel({
  changedFiles,
  diffSections,
  diff,
  files,
  selectedFilePath,
  expandedDiffs,
  toggleDiffExpanded,
  openFileTab,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
}: GitReviewSubPanelProps) {
  if (diff.isLoading || files.isLoading) {
    return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading changed files…</p>
  }
  if (diff.isError) {
    return <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load changed files</p>
  }
  if (!diff.data?.is_git_repo) {
    return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
  }
  if (changedFiles.length === 0) {
    return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No changed files</p>
  }

  return (
    <div>
      {diff.data.truncated && (
        <p className="mb-2 rounded-sm bg-(--color-warning)/10 px-2 py-1 text-xs text-(--color-warning)">
          Changed list may be incomplete because the diff was truncated.
        </p>
      )}
      <div className="space-y-2">
        {changedFiles.map((changedFile) => {
          const isSelected = selectedFilePath === changedFile.path
          const expanded = expandedDiffs.has(changedFile.path)
          const fileDiff = diffSections.get(changedFile.path)?.diff
          return (
            <div
              key={changedFile.path}
              className="group overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card)"
            >
              <Tooltip className="w-full">
                <TooltipTrigger
                  className="w-full"
                  render={
                    <LongPressButton
                      type="button"
                      onClick={() => toggleDiffExpanded(changedFile.path)}
                      enabled={mobile}
                      onLongPress={() => setMobileFileActions(changedFile)}
                      onContextMenu={(e) => {
                        if (!mobile) {
                          e.preventDefault()
                          setDesktopFileActions({
                            file: changedFile,
                            x: e.clientX,
                            y: e.clientY,
                          })
                        }
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text)',
                        isSelected ? 'text-(--color-accent)' : 'text-(--color-text-2)',
                      )}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} diff for ${changedFile.path}`}
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        size={12}
                        className={cn(
                          'shrink-0 text-(--color-text-subtle) transition-transform',
                          expanded && 'rotate-90',
                        )}
                        aria-hidden="true"
                      />
                      <FileTypeIcon name={changedFile.path} size={13} />
                      <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                      {changedFile.status !== 'D' && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            const name = changedFile.path.split('/').pop() ?? changedFile.path
                            const file: WorkspaceFileInfo = files.data?.files.find(
                              (f) => f.path === changedFile.path,
                            ) ?? {
                              path: changedFile.path,
                              name,
                              size: 0,
                              mtime: 0,
                              mime: 'text/plain',
                            }
                            openFileTab(file)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click()
                          }}
                          className="hidden shrink-0 rounded-xs p-0.5 text-(--color-text-subtle) opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-(--color-text) md:block"
                          aria-label={`Open ${changedFile.path}`}
                        >
                          <ExternalLink size={11} aria-hidden="true" />
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-(--color-diff-add-text)">
                        {changedFile.additions > 0 ? `+${changedFile.additions}` : ''}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-(--color-diff-del-text)">
                        {changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}
                      </span>
                      <span
                        className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)"
                        aria-label={CHANGED_STATUS_LABELS[changedFile.status]}
                      >
                        {changedFile.status}
                      </span>
                    </LongPressButton>
                  }
                />
                <TooltipContent>{changedFile.path}</TooltipContent>
              </Tooltip>

              {expanded && (
                <div className="border-t border-(--color-border-subtle)">
                  {fileDiff ? (
                    <div className="max-h-[70vh] min-h-0 overflow-y-auto touch-pan-y">
                      <DiffPreview diff={fileDiff} />
                    </div>
                  ) : (
                    <p className="px-2 py-3 text-xs text-(--color-text-subtle)">
                      No diff body for this file.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
