import { memo, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { ExternalLink, GitCommitHorizontal } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import type { GitCommit } from '@/api/types'
import {
  type ChangedFileInfo,
  type DiffFileSection,
  formatCommitTime,
  safeDecodeURIComponent,
} from './diff-helpers'
import { CommitDetail } from './CommitDetail'
import { DOCK_ROW_ACTION_CLASS } from './dock-tab-styles'
import { DockLoadError } from './DockLoadError'
import { DockListNotice } from './GitReviewSubPanel'

type CommitTarget = { sha: string; shortSha: string; subject: string }

export interface CommitHistorySubPanelProps {
  workspace: string
  gitHistory: {
    isLoading: boolean
    isError: boolean
    isFetching?: boolean
    isFetchingNextPage: boolean
    hasNextPage?: boolean
    fetchNextPage: () => Promise<unknown>
    refetch?: () => Promise<unknown>
    data?: {
      pages: Array<{
        is_git_repo?: boolean
        commits: GitCommit[]
      }>
    }
  }
  commits: GitCommit[]
  expandedCommitSha: string | null
  setExpandedCommitSha: (updater: string | null | ((prev: string | null) => string | null)) => void
  expandedCommitFiles: Set<string>
  setExpandedCommitFiles: React.Dispatch<React.SetStateAction<Set<string>>>
  commitDiff: {
    isLoading: boolean
    isError: boolean
    isFetching?: boolean
    refetch?: () => Promise<unknown>
  }
  commitChangedFiles: ChangedFileInfo[]
  commitDiffSections: Map<string, DiffFileSection>
  commitsScrollRef: React.RefObject<HTMLDivElement | null>
  openCommitTab: (commit: GitCommit) => void
  mobile?: boolean
  setMobileCommitActions: React.Dispatch<React.SetStateAction<CommitTarget | null>>
  setDesktopCommitActions: React.Dispatch<React.SetStateAction<(CommitTarget & { x: number; y: number }) | null>>
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

/** History: the commit list of the current branch, newest first, paged as it scrolls. */
function CommitHistorySubPanelView({
  gitHistory,
  commits,
  expandedCommitSha,
  setExpandedCommitSha,
  expandedCommitFiles,
  setExpandedCommitFiles,
  commitDiff,
  commitChangedFiles,
  commitDiffSections,
  commitsScrollRef,
  openCommitTab,
  mobile = false,
  setMobileCommitActions,
  setDesktopCommitActions,
  setMobileFileActions,
  setDesktopFileActions,
}: CommitHistorySubPanelProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const hasNextPageRef = useRef(gitHistory.hasNextPage)
  const isFetchingNextPageRef = useRef(gitHistory.isFetchingNextPage)
  const fetchNextPageRef = useRef(gitHistory.fetchNextPage)
  useEffect(() => {
    hasNextPageRef.current = gitHistory.hasNextPage
    isFetchingNextPageRef.current = gitHistory.isFetchingNextPage
    fetchNextPageRef.current = gitHistory.fetchNextPage
  })

  useEffect(() => {
    if (!sentinelRef.current || !hasNextPageRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPageRef.current && !isFetchingNextPageRef.current) {
          void fetchNextPageRef.current()
        }
      },
      { threshold: 0.1 },
    )

    const el = sentinelRef.current
    observer.observe(el)
    return () => observer.disconnect()
  }, [gitHistory.isLoading, gitHistory.hasNextPage, commits.length])

  const toggleCommit = (commit: GitCommit, row: HTMLElement) => {
    // Keep the clicked row visually anchored while the one above collapses.
    const card = row.closest('[data-commit-sha]') as HTMLElement | null
    const scroller = commitsScrollRef.current
    const offsetBefore = card && scroller
      ? card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : null
    flushSync(() => {
      setExpandedCommitSha((prev) => (prev === commit.sha ? null : commit.sha))
      setExpandedCommitFiles(new Set())
    })
    if (card && scroller && offsetBefore !== null) {
      scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offsetBefore
    }
  }

  if (gitHistory.isLoading) return <DockListNotice>Loading commits…</DockListNotice>
  if (gitHistory.isError) {
    const refetch = gitHistory.refetch
    if (!refetch) return <DockListNotice tone="error">Couldn&apos;t load commit history.</DockListNotice>
    return (
      <DockLoadError
        message="Couldn't load commit history."
        onRetry={() => void refetch()}
        retrying={gitHistory.isFetching}
      />
    )
  }
  if (gitHistory.data?.pages[0]?.is_git_repo === false) {
    return <EmptyState icon={GitCommitHorizontal} title="Not a git repository" body="Run git init in this folder to see its history here." />
  }
  if (commits.length === 0) {
    return <EmptyState icon={GitCommitHorizontal} title="No commits yet" body="Commits on this branch show up here." />
  }

  return (
    <div>
      <ul aria-label="Commits" className="divide-y divide-(--color-border-subtle) border-b border-(--color-border-subtle)">
        {commits.map((commit) => {
          const isExpanded = expandedCommitSha === commit.sha
          const subject = safeDecodeURIComponent(commit.subject)
          const target = { sha: commit.sha, shortSha: commit.short_sha, subject }
          const refs = commit.refs?.split(',').map((ref) => ref.trim()).filter(Boolean) ?? []
          return (
            <li key={commit.sha} data-commit-sha={commit.sha} className={cn(isExpanded && 'bg-(--bg-card)')}>
              <div className="group/row flex items-center transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60">
                <LongPressButton
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={(e) => toggleCommit(commit, e.currentTarget)}
                  enabled={mobile}
                  onLongPress={() => setMobileCommitActions(target)}
                  onContextMenu={(e) => {
                    if (mobile) return
                    e.preventDefault()
                    setDesktopCommitActions({ ...target, x: e.clientX, y: e.clientY })
                  }}
                  onKeyDown={(e) => {
                    if (mobile || !isMenuKey(e)) return
                    e.preventDefault()
                    const at = menuPointFor(e.currentTarget)
                    setDesktopCommitActions({ ...target, x: at.clientX, y: at.clientY })
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left outline-none focus-key:bg-(--bg-key)/60"
                >
                  <span className="flex w-full items-center gap-2">
                    <Tooltip className="min-w-0 flex-1">
                      <TooltipTrigger
                        className="min-w-0 flex-1"
                        render={<span className="truncate text-xs text-(--color-text)">{subject}</span>}
                      />
                      <TooltipContent>{subject}</TooltipContent>
                    </Tooltip>
                    <span className="shrink-0 font-mono text-meta text-(--color-text-subtle)">{commit.short_sha}</span>
                  </span>
                  <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-(--color-text-muted) md:text-meta">
                    {refs.length > 0 && (
                      // Labels shrink (and end in "…") before the date does.
                      <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
                        {refs.map((ref) => (
                          <span
                            key={ref}
                            className="max-w-32 min-w-0 shrink truncate rounded-xs bg-(--bg-key) px-1 font-mono text-(--color-text-2)"
                          >
                            {ref}
                          </span>
                        ))}
                      </span>
                    )}
                    <span className="min-w-0 truncate">{commit.author_name}</span>
                    <span className="ml-auto shrink-0">{formatCommitTime(commit.timestamp)}</span>
                  </span>
                </LongPressButton>
                {!mobile && (
                  <div className="hidden shrink-0 pr-2 md:group-hover/row:flex md:group-focus-within/row:flex">
                    <button
                      type="button"
                      onClick={() => openCommitTab(commit)}
                      className={DOCK_ROW_ACTION_CLASS}
                      aria-label={`Open commit ${commit.short_sha} in tab`}
                      title="Open in tab"
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>

              {isExpanded && (
                <div className="px-3 pb-2">
                  {commit.body && (
                    <p className="max-h-32 overflow-y-auto touch-pan-y whitespace-pre-wrap break-words border-l-2 border-(--color-border) py-0.5 pl-2 text-meta leading-relaxed text-(--color-text-2)">
                      {commit.body}
                    </p>
                  )}
                  <CommitDetail
                    commitDiff={commitDiff}
                    commitChangedFiles={commitChangedFiles}
                    commitDiffSections={commitDiffSections}
                    expandedCommitFiles={expandedCommitFiles}
                    setExpandedCommitFiles={setExpandedCommitFiles}
                    mobile={mobile}
                    setMobileFileActions={setMobileFileActions}
                    setDesktopFileActions={setDesktopFileActions}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {gitHistory.isFetchingNextPage && (
        <p className="py-2 text-center text-xs text-(--color-text-subtle) md:text-meta">Loading more commits…</p>
      )}
      <div ref={sentinelRef} className="h-1" />
      {gitHistory.hasNextPage && (
        <div className="px-3 pb-3">
          <Button
            size="sm"
            className="w-full min-h-9 md:min-h-8"
            disabled={gitHistory.isFetchingNextPage}
            onClick={() => void gitHistory.fetchNextPage()}
          >
            Load more commits
          </Button>
        </div>
      )}
    </div>
  )
}

/** Memoized: the dock re-renders on every width change; the list need not. */
export const CommitHistorySubPanel = memo(CommitHistorySubPanelView)
