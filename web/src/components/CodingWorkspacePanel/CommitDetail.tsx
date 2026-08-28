import React from 'react'
import { ChevronRight } from 'lucide-react'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../CodingFileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { cn } from '@/lib/utils'
import type { ChangedFileInfo, DiffFileSection } from './diff-helpers'

export interface CommitDetailProps {
  commitDiff: { isLoading: boolean; isError: boolean }
  commitChangedFiles: ChangedFileInfo[]
  commitDiffSections: Map<string, DiffFileSection>
  expandedCommitFiles: Set<string>
  setExpandedCommitFiles: React.Dispatch<React.SetStateAction<Set<string>>>
  mobile?: boolean
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

export function CommitSyncBadge({
  count,
  direction,
  upstream,
}: {
  count: number
  direction: 'ahead' | 'behind'
  upstream?: string | null
}) {
  const isAhead = direction === 'ahead'
  const noun = count === 1 ? 'commit' : 'commits'
  const target = upstream || 'origin'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'rounded-xs border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] font-semibold leading-none',
              isAhead ? 'text-(--color-diff-add-text)' : 'text-(--color-diff-del-text)',
            )}
          >
            {count}{isAhead ? '↑' : '↓'}
          </span>
        }
      />
      <TooltipContent>{`${count} ${isAhead ? `local ${noun} ahead of ${target}` : `${noun} behind ${target}`}`}</TooltipContent>
    </Tooltip>
  )
}

export function CommitDetail({
  commitDiff,
  commitChangedFiles,
  commitDiffSections,
  expandedCommitFiles,
  setExpandedCommitFiles,
  mobile = false,
  setMobileFileActions,
  setDesktopFileActions,
}: CommitDetailProps) {
  const toggleFileExpanded = (path: string) => {
    setExpandedCommitFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (commitDiff.isLoading) {
    return <p className="px-2 py-2 text-[10px] text-(--color-text-subtle)">Loading commit changes…</p>
  }
  if (commitDiff.isError) {
    return <p className="px-2 py-2 text-[10px] text-(--color-error)">Failed to load commit changes</p>
  }

  if (commitChangedFiles.length === 0) {
    return <p className="px-2 py-2 text-[10px] text-(--color-text-subtle)">No files changed in this commit.</p>
  }

  return (
    <div className="mt-2 space-y-1.5 border-l border-(--color-border-strong) py-0.5 pr-0.5 pl-2">
      {commitChangedFiles.map((changedFile) => {
        const expanded = expandedCommitFiles.has(changedFile.path)
        const fileDiff = commitDiffSections.get(changedFile.path)?.diff
        return (
          <div key={changedFile.path} className="overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card)">
            <Tooltip className="w-full">
              <TooltipTrigger
                className="w-full"
                render={
                  <LongPressButton
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleFileExpanded(changedFile.path) }}
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
                    className="flex w-full cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left text-[10px] text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-expanded={expanded}
                  >
                    <ChevronRight size={10} className={cn('shrink-0 text-(--color-text-subtle) transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                    <FileTypeIcon name={changedFile.path} size={11} />
                    <span className="min-w-0 flex-1 truncate font-mono">{changedFile.path}</span>
                    <span className="shrink-0 font-mono text-[10px] text-(--color-diff-add-text)">{changedFile.additions > 0 ? `+${changedFile.additions}` : ''}</span>
                    <span className="shrink-0 font-mono text-[10px] text-(--color-diff-del-text)">{changedFile.deletions > 0 ? `-${changedFile.deletions}` : ''}</span>
                    <span className="shrink-0 font-mono text-[10px] font-semibold text-(--accent-orange-text)">{changedFile.status}</span>
                  </LongPressButton>
                }
              />
              <TooltipContent>{changedFile.path}</TooltipContent>
            </Tooltip>
            {expanded && (
              <div className="border-t border-(--color-border-subtle)">
                {fileDiff ? (
                  <div className="max-h-[40vh] min-h-0 overflow-y-auto touch-pan-y">
                    <DiffPreview diff={fileDiff} />
                  </div>
                ) : (
                  <p className="px-2 py-2 text-[9px] text-(--color-text-subtle)">No diff body for this file.</p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface ParsedGraphLine {
  key: string
  raw: string
  graphPart: string
  sha?: string
  decorations?: string
  message?: string
}

export function renderGraphPrefix(prefix: string) {
  return prefix.split('').map((char, index) => {
    if (char === '*') {
      return (
        <span key={index} className="text-(--color-accent) font-bold font-mono">
          ●
        </span>
      )
    }
    if (char === '|') {
      return (
        <span key={index} className="text-(--color-text-subtle) opacity-60 font-mono">
          |
        </span>
      )
    }
    if (char === '/' || char === '\\' || char === '_') {
      return (
        <span key={index} className="text-(--color-text-muted) opacity-85 font-mono">
          {char}
        </span>
      )
    }
    return <span key={index} className="font-mono">{char}</span>
  })
}
