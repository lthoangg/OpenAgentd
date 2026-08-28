import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LongPressButton } from '@/components/ui/long-press-button'
import { cn } from '@/lib/utils'
import type { GitCommit } from '@/api/types'
import {
  type ChangedFileInfo,
  type DiffFileSection,
  safeDecodeURIComponent,
} from './diff-helpers'
import {
  CommitDetail,
  type ParsedGraphLine,
  renderGraphPrefix,
} from './CommitDetail'

export interface CommitHistorySubPanelProps {
  workspace: string
  subTab: 'commits' | 'tree'
  gitHistory: {
    isLoading: boolean
    isError: boolean
    isFetchingNextPage: boolean
    hasNextPage?: boolean
    fetchNextPage: () => Promise<unknown>
    data?: {
      pages: Array<{
        is_git_repo?: boolean
        commits: GitCommit[]
        graph?: string
      }>
    }
  }
  commits: GitCommit[]
  expandedCommitSha: string | null
  setExpandedCommitSha: (updater: string | null | ((prev: string | null) => string | null)) => void
  expandedCommitFiles: Set<string>
  setExpandedCommitFiles: React.Dispatch<React.SetStateAction<Set<string>>>
  commitDiff: { isLoading: boolean; isError: boolean }
  commitChangedFiles: ChangedFileInfo[]
  commitDiffSections: Map<string, DiffFileSection>
  parsedGraphLines: ParsedGraphLine[]
  commitsScrollRef: React.RefObject<HTMLDivElement | null>
  pendingScrollShaRef: React.MutableRefObject<string | null>
  setSubTab: (tab: 'changes' | 'commits' | 'tree') => void
  mobile?: boolean
  setMobileCommitActions: React.Dispatch<React.SetStateAction<{ sha: string; shortSha: string; subject: string } | null>>
  setDesktopCommitActions: React.Dispatch<React.SetStateAction<{ sha: string; shortSha: string; subject: string; x: number; y: number } | null>>
  setMobileFileActions: React.Dispatch<React.SetStateAction<ChangedFileInfo | null>>
  setDesktopFileActions: React.Dispatch<React.SetStateAction<{ file: ChangedFileInfo; x: number; y: number } | null>>
}

export function CommitHistorySubPanel({
  subTab,
  gitHistory,
  commits,
  expandedCommitSha,
  setExpandedCommitSha,
  expandedCommitFiles,
  setExpandedCommitFiles,
  commitDiff,
  commitChangedFiles,
  commitDiffSections,
  parsedGraphLines,
  commitsScrollRef,
  pendingScrollShaRef,
  setSubTab,
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
    return () => {
      observer.unobserve(el)
    }
  }, [subTab])

  if (subTab === 'commits') {
    if (gitHistory.isLoading) {
      return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading commits…</p>
    }
    if (gitHistory.isError) {
      return <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load commits</p>
    }
    if (gitHistory.data?.pages[0]?.is_git_repo === false) {
      return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
    }
    if (commits.length === 0) {
      return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No commits found</p>
    }

    return (
      <div className="space-y-2">
        {commits.map((commit) => {
          const isExpanded = expandedCommitSha === commit.sha
          return (
            <div
              key={commit.sha}
              data-commit-sha={commit.sha}
              className="overflow-hidden rounded-sm border border-(--color-border-subtle) bg-(--bg-card) p-2 transition-colors hover:border-(--color-border) hover:bg-(--bg-key)"
            >
              <LongPressButton
                type="button"
                onClick={(e) => {
                  const card = (e.currentTarget as HTMLElement).closest('[data-commit-sha]') as HTMLElement | null
                  const scroller = commitsScrollRef.current
                  const cardOffsetBefore = card && scroller
                    ? card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                    : null
                  flushSync(() => {
                    setExpandedCommitSha((prev) => (prev === commit.sha ? null : commit.sha))
                    setExpandedCommitFiles(new Set())
                  })
                  if (card && scroller && cardOffsetBefore !== null) {
                    const cardOffsetAfter = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                    scroller.scrollTop += cardOffsetAfter - cardOffsetBefore
                  }
                }}
                enabled={mobile}
                onLongPress={() =>
                  setMobileCommitActions({
                    sha: commit.sha,
                    shortSha: commit.short_sha,
                    subject: safeDecodeURIComponent(commit.subject),
                  })
                }
                onContextMenu={(e) => {
                  if (!mobile) {
                    e.preventDefault()
                    setDesktopCommitActions({
                      sha: commit.sha,
                      shortSha: commit.short_sha,
                      subject: safeDecodeURIComponent(commit.subject),
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                }}
                className="flex w-full cursor-pointer flex-col gap-1 text-left"
              >
                <div className="flex w-full items-start justify-between gap-1.5">
                  <div className="flex items-start gap-1.5 min-w-0 flex-1">
                    <span className="shrink-0 font-mono text-xs text-(--color-text-subtle) select-none mt-0.5">•</span>
                    <Tooltip className="min-w-0">
                      <TooltipTrigger
                        className="min-w-0"
                        render={
                          <span className="truncate font-mono text-[11px] font-semibold text-(--color-text)">
                            {safeDecodeURIComponent(commit.subject)}
                          </span>
                        }
                      />
                      <TooltipContent>{safeDecodeURIComponent(commit.subject)}</TooltipContent>
                    </Tooltip>
                  </div>
                  <span className="shrink-0 rounded-xs border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] text-(--color-text-subtle)">
                    {commit.short_sha}
                  </span>
                </div>

                {commit.refs && (
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {commit.refs.split(',').map((ref) => (
                      <span
                        key={ref}
                        className="text-[9px] font-semibold px-1 rounded-xs bg-(--color-accent)/10 text-(--color-accent) border border-(--color-accent)/20"
                      >
                        {ref.trim()}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex w-full items-center justify-between text-[10px] text-(--color-text-muted) mt-1">
                  <span>{commit.author_name}</span>
                  <span>
                    {new Date(commit.timestamp * 1000).toLocaleDateString('en-GB')}{' '}
                    {new Date(commit.timestamp * 1000).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                </div>
              </LongPressButton>

              {isExpanded && (
                <>
                  {commit.body && (
                    <p className="mt-2 max-h-32 overflow-y-auto touch-pan-y whitespace-pre-wrap break-words rounded-sm border border-(--color-border) bg-(--bg-page) px-2 py-1.5 text-[11px] leading-relaxed text-(--color-text-2)">
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
                </>
              )}
            </div>
          )
        })}

        {gitHistory.isFetchingNextPage && (
          <p className="text-center py-2 text-[10px] text-(--color-text-subtle)">Loading more commits…</p>
        )}
        <div ref={sentinelRef} className="h-1" />
      </div>
    )
  }

  // subTab === 'tree'
  if (gitHistory.isLoading) {
    return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Loading tree graph…</p>
  }
  if (gitHistory.isError) {
    return <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load tree graph</p>
  }
  if (gitHistory.data?.pages[0]?.is_git_repo === false) {
    return <p className="px-2 py-4 text-xs text-(--color-text-subtle)">Not a git repository</p>
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-(--color-border) bg-(--bg-card) p-2 select-none">
        {parsedGraphLines.length === 0 ? (
          <p className="px-2 py-4 text-xs text-(--color-text-subtle)">No graph history.</p>
        ) : (
          <div className="flex flex-col min-w-max">
            {parsedGraphLines.map((line) => (
              <div
                key={line.key}
                className="flex items-center gap-2 hover:bg-(--bg-key)/40 px-1 py-0.5 rounded-xs transition-colors group h-5"
              >
                <span className="font-mono text-[11px] leading-none whitespace-pre select-none shrink-0 tracking-widest">
                  {renderGraphPrefix(line.graphPart)}
                </span>
                {line.sha ? (
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Tooltip className="shrink-0">
                      <TooltipTrigger
                        className="shrink-0"
                        render={
                          <button
                            type="button"
                            onClick={() => {
                              const shortSha = line.sha ?? null
                              const fullSha = shortSha
                                ? (commits.find((c) => c.sha.startsWith(shortSha))?.sha ?? shortSha)
                                : null
                              pendingScrollShaRef.current = fullSha
                              setExpandedCommitFiles(new Set())
                              setExpandedCommitSha(fullSha)
                              setSubTab('commits')
                            }}
                            className="shrink-0 cursor-pointer rounded-xs border border-(--color-border-subtle) bg-(--bg-card) px-1 py-0.5 font-mono text-[9px] text-(--color-text-subtle) transition-colors hover:border-(--color-accent)/30 hover:bg-(--color-accent)/10 hover:text-(--color-accent)"
                          >
                            {line.sha.substring(0, 7)}
                          </button>
                        }
                      />
                      <TooltipContent>Click to view commit details</TooltipContent>
                    </Tooltip>

                    {line.decorations && (
                      <div className="flex items-center gap-1 shrink-0 max-w-[200px] overflow-hidden">
                        {line.decorations.split(',').map((ref) => {
                          const trimmed = ref.trim()
                          const isHead = trimmed.includes('HEAD ->')
                          const isRemote = trimmed.includes('origin/')
                          const badgeClassName = cn(
                            'text-[10px] font-semibold px-1 py-0.5 rounded-xs border truncate leading-none select-none',
                            isHead
                              ? 'bg-(--color-diff-add-bg) text-(--color-diff-add-text) border-(--color-success)/20'
                              : isRemote
                              ? 'bg-(--color-diff-del-bg) text-(--color-diff-del-text) border-(--color-error)/20'
                              : 'bg-(--color-accent)/10 text-(--color-accent) border-(--color-accent)/20',
                          )
                          return (
                            <Tooltip key={ref} className="min-w-0">
                              <TooltipTrigger
                                className="min-w-0"
                                render={<span className={badgeClassName}>{trimmed}</span>}
                              />
                              <TooltipContent>{trimmed}</TooltipContent>
                            </Tooltip>
                          )
                        })}
                      </div>
                    )}
                    <Tooltip className="min-w-0 flex-1">
                      <TooltipTrigger
                        className="min-w-0 flex-1"
                        render={
                          <span className="truncate font-mono text-[11px] text-(--color-text-2) group-hover:text-(--color-text) transition-colors">
                            {line.message}
                          </span>
                        }
                      />
                      <TooltipContent>{line.message}</TooltipContent>
                    </Tooltip>
                  </div>
                ) : (
                  line.raw.trim().length > line.graphPart.trim().length && (
                    <span className="font-mono text-[11px] text-(--color-text-subtle) truncate flex-1">
                      {line.raw.substring(line.graphPart.length)}
                    </span>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
