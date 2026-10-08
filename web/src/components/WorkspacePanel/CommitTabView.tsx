/**
 * CommitTabView — one commit as a full-height dock tab.
 *
 * Header (subject, SHA, author, time, refs, body) followed by every changed
 * file's patch in a single scroller with sticky file headers, instead of the
 * Commits list's nested inline expansion. Shares the commit-diff cache entry
 * with that inline expansion.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Copy } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffPreview } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { cn } from '@/lib/utils'
import { COMMIT_DIFF_STALE_MS, commitDiffQueryOptions } from '@/queries/workspace-git'
import type { GitCommit } from '@/api/types'
import { ChangeCounts } from './ChangeCounts'
import {
  type DiffFileSection,
  collectChangedFiles,
  collectDiffSections,
  formatCommitTime,
  safeDecodeURIComponent,
} from './diff-helpers'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

/** Larger commits open collapsed so the tab paints without every patch. */
const AUTO_EXPAND_MAX_FILES = 10
/**
 * Changed lines opened by default. Tracked and commit diffs are not capped,
 * and one regenerated lockfile can be tens of thousands of rows, so files
 * open in order while they fit and the rest start collapsed.
 */
const AUTO_EXPAND_MAX_LINES = 2000

export interface CommitTabViewProps {
  workspace: string
  commit: GitCommit
}

export function CommitTabView({ workspace, commit }: CommitTabViewProps) {
  const commitDiff = useQuery({
    ...commitDiffQueryOptions(workspace, commit.sha),
    staleTime: COMMIT_DIFF_STALE_MS,
  })
  const diffText = commitDiff.data?.diff
  const files = useMemo(
    () => (diffText ? collectChangedFiles({ workspace, is_git_repo: true, diff: diffText }) : []),
    [diffText, workspace],
  )
  const sections = useMemo(
    () => (diffText
      ? collectDiffSections({ workspace, is_git_repo: true, diff: diffText })
      : new Map<string, DiffFileSection>()),
    [diffText, workspace],
  )
  const defaultCollapsed = useMemo(() => {
    if (files.length > AUTO_EXPAND_MAX_FILES) return new Set(files.map((f) => f.path))
    const closed = new Set<string>()
    let opened = 0
    for (const file of files) {
      const lines = file.additions + file.deletions
      if (opened + lines > AUTO_EXPAND_MAX_LINES) closed.add(file.path)
      else opened += lines
    }
    return closed
  }, [files])
  // ``null`` = follow the size default; a Set once the user toggles a file.
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null)
  const isCollapsed = (path: string) => (collapsed ?? defaultCollapsed).has(path)
  const toggle = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current ?? defaultCollapsed)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const subject = safeDecodeURIComponent(commit.subject)
  const refs = commit.refs?.split(',').map((ref) => ref.trim()).filter(Boolean) ?? []

  return (
    <div className="h-full min-h-0 overflow-auto touch-pan-y">
      <header className="border-b border-(--color-border-subtle) bg-(--bg-page) px-3 py-2.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-xs font-medium break-words text-(--color-text)">{subject}</p>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(commit.sha)}
                  className={cn(DOCK_ACTION_BUTTON_CLASS, '-mt-1 -mr-1')}
                  aria-label="Copy full SHA"
                >
                  <Copy size={12} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">Copy full SHA</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-(--color-text-muted)">
          <span className="font-mono text-(--color-text-subtle)">{commit.short_sha}</span>
          <span>{commit.author_name}</span>
          <span>{formatCommitTime(commit.timestamp)}</span>
          {refs.map((ref) => (
            <span key={ref} className="rounded-xs border border-(--color-border-subtle) bg-(--bg-key) px-1 font-mono text-(--color-text-2)">
              {ref}
            </span>
          ))}
        </div>
        {commit.body && (
          <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-(--color-text-2)">{commit.body}</p>
        )}
      </header>
      {commitDiff.isLoading ? (
        <p className="px-3 py-4 text-xs text-(--color-text-subtle)">Loading commit changes…</p>
      ) : commitDiff.isError ? (
        <p className="px-3 py-4 text-xs text-(--color-error)" role="alert">Failed to load commit changes.</p>
      ) : files.length === 0 ? (
        <p className="px-3 py-4 text-xs text-(--color-text-subtle)">No files changed in this commit.</p>
      ) : (
        files.map((file) => {
          const open = !isCollapsed(file.path)
          const body = sections.get(file.path)?.diff
          return (
            <section key={file.path} className="border-b border-(--color-border-subtle)">
              <button
                type="button"
                onClick={() => toggle(file.path)}
                aria-expanded={open}
                className="sticky top-0 z-2 flex h-(--spacing-list-row) w-full items-center gap-2 bg-(--bg-card) px-3 text-left text-xs text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)"
              >
                <ChevronRight
                  size={12}
                  className={cn('shrink-0 text-(--color-text-subtle) transition-transform', open && 'rotate-90')}
                  aria-hidden="true"
                />
                <FileTypeIcon name={file.path} size={13} />
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <ChangeCounts file={file} />
              </button>
              {open && (body
                ? <DiffPreview diff={body} autoScroll={false} />
                : <p className="px-3 py-2 text-[11px] text-(--color-text-subtle)">No diff body for this file.</p>)}
            </section>
          )
        })
      )}
    </div>
  )
}
