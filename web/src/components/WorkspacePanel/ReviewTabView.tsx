/**
 * The Review panel's Git tab: the Changes / Commits toolbar over the list it
 * picks. The panel owns the queries other tabs also read (files, changes,
 * status, history); this view owns what only it reads: the expanded rows
 * (remembered per workspace in ``useGitPanelStore``), the expanded commit's
 * diff, each list's scroll place, and the memoized slices of the query
 * results the memoized lists take.
 */
// Not compiled, as when this code was part of WorkspacePanel, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useCallback, useId, useMemo, useRef } from 'react'
import { useQuery, type InfiniteData, type UseInfiniteQueryResult, type UseQueryResult } from '@tanstack/react-query'
import type {
  CodingWorkspaceFilesResponse,
  GitCommit,
  WorkspaceChangesResponse,
  WorkspaceGitHistoryResponse,
  WorkspaceStatusResponse,
} from '@/api/types'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { COMMIT_DIFF_STALE_MS, commitDiffQueryOptions } from '@/queries/workspace-git'
import { DEFAULT_WORKSPACE_STATE, useGitPanelStore, type WorkspaceGitState } from '@/stores/useGitPanelStore'
import { CommitHistorySubPanel, type CommitHistorySubPanelProps } from './CommitHistorySubPanel'
import { type ChangedFileInfo, type DiffFileSection, collectChangedFiles, collectDiffSections } from './diff-helpers'
import { GitReviewSubPanel, type GitReviewSubPanelProps } from './GitReviewSubPanel'
import { type GitSubTab, GitViewToolbar, gitViewPanelId, gitViewTabId } from './GitViewToolbar'

export function ReviewTabView({
  workspace,
  gitState,
  queriesEnabled,
  mobile,
  changes,
  files,
  gitHistory,
  commits,
  changedFiles,
  status,
  selectedFilePath,
  onRefresh: handleRefresh,
  openCommitTab: openCommitPreview,
  setMobileFileActions,
  setDesktopFileActions,
  setMobileCommitActions,
  setDesktopCommitActions,
}: {
  workspace: string
  /** The workspace's Git view state (sub-tab, expanded rows). */
  gitState: WorkspaceGitState
  /** The panel is open on a Git workspace with this tab on screen. */
  queriesEnabled: boolean
  mobile: boolean
  changes: UseQueryResult<WorkspaceChangesResponse>
  files: UseQueryResult<CodingWorkspaceFilesResponse>
  gitHistory: UseInfiniteQueryResult<InfiniteData<WorkspaceGitHistoryResponse>>
  commits: GitCommit[]
  changedFiles: ChangedFileInfo[]
  status: WorkspaceStatusResponse | undefined
  selectedFilePath: string | null
  onRefresh: () => void
  openCommitTab: (commit: GitCommit) => void
  setMobileFileActions: GitReviewSubPanelProps['setMobileFileActions']
  setDesktopFileActions: GitReviewSubPanelProps['setDesktopFileActions']
  setMobileCommitActions: CommitHistorySubPanelProps['setMobileCommitActions']
  setDesktopCommitActions: CommitHistorySubPanelProps['setDesktopCommitActions']
}) {
  const gitViewIdBase = useId()
  const commitsScrollRef = useRef<HTMLDivElement>(null)
  const subTab = gitState.subTab
  // Each Git view (changes, commits) keeps its place across tab switches.
  const rememberReviewScroll = useScrollMemory(`review:${workspace}:${subTab}`, commitsScrollRef)
  const expandedCommitSha = gitState.expandedCommitSha
  const expandedDiffs = useMemo(() => new Set(gitState.expandedDiffs), [gitState.expandedDiffs])
  const expandedCommitFiles = useMemo(() => new Set(gitState.expandedCommitFiles), [gitState.expandedCommitFiles])

  // Stable setters (read the store at call time) so the memoized Git list
  // views below are not re-rendered by a fresh callback on every dock render.
  const setSubTab = useCallback((tab: GitSubTab) => useGitPanelStore.getState().setSubTab(workspace, tab), [workspace])
  const setExpandedCommitSha = useCallback((updater: string | null | ((prev: string | null) => string | null)) => {
    const store = useGitPanelStore.getState()
    const current = (store.workspaces[workspace] || DEFAULT_WORKSPACE_STATE).expandedCommitSha
    store.setExpandedCommitSha(workspace, typeof updater === 'function' ? updater(current) : updater)
  }, [workspace])
  const setExpandedCommitFiles = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const store = useGitPanelStore.getState()
    const current = new Set((store.workspaces[workspace] || DEFAULT_WORKSPACE_STATE).expandedCommitFiles)
    store.setExpandedCommitFiles(workspace, Array.from(typeof updater === 'function' ? updater(current) : updater))
  }, [workspace])

  const commitsAhead = status?.commits_ahead ?? null
  const commitsBehind = status?.commits_behind ?? null
  const upstream = status?.upstream ?? null

  const commitDiff = useQuery({
    ...commitDiffQueryOptions(workspace, expandedCommitSha ?? ''),
    enabled: queriesEnabled && subTab === 'commits' && expandedCommitSha !== null,
    staleTime: COMMIT_DIFF_STALE_MS,
  })
  const commitDiffText = commitDiff.data?.diff

  // React Query hands back a new result object every render; the list views
  // get memoized slices of the fields they read so ``memo`` can skip them.
  // ``isFetching`` matters only to a failed list's Retry; reading it always
  // would re-render the rows on every background refetch.
  const changesRetrying = changes.isError && changes.isFetching
  const changesView = useMemo(
    () => ({ isLoading: changes.isLoading, isError: changes.isError, isFetching: changesRetrying, refetch: changes.refetch, data: changes.data }),
    [changes.isLoading, changes.isError, changesRetrying, changes.refetch, changes.data],
  )
  const filesView = useMemo(() => ({ isLoading: files.isLoading, data: files.data }), [files.isLoading, files.data])
  const { isLoading: historyLoading, isError: historyError, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData } = gitHistory
  const historyFetching = historyError && gitHistory.isFetching
  const historyView = useMemo(
    () => ({ isLoading: historyLoading, isError: historyError, isFetching: historyFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch: refetchHistory, data: historyData }),
    [historyLoading, historyError, historyFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetchHistory, historyData],
  )
  // ``isFetching`` matters only to a failed load's Retry (as for the lists above).
  const commitDiffRetrying = commitDiff.isError && commitDiff.isFetching
  const commitDiffView = useMemo(
    () => ({ isLoading: commitDiff.isLoading, isError: commitDiff.isError, isFetching: commitDiffRetrying, refetch: commitDiff.refetch }),
    [commitDiff.isLoading, commitDiff.isError, commitDiffRetrying, commitDiff.refetch],
  )
  const commitChangedFiles = useMemo(() => {
    if (!commitDiffText) return []
    return collectChangedFiles({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])
  const commitDiffSections = useMemo(() => {
    if (!commitDiffText) return new Map<string, DiffFileSection>()
    return collectDiffSections({ workspace, is_git_repo: true, diff: commitDiffText })
  }, [commitDiffText, workspace])

  const toggleDiffExpanded = useCallback((path: string) => {
    useGitPanelStore.getState().toggleDiffExpanded(workspace, path)
  }, [workspace])
  const allExpanded = changedFiles.length > 0 && changedFiles.every((f) => expandedDiffs.has(f.path))
  const toggleExpandAll = () => {
    useGitPanelStore.getState().setExpandedDiffs(workspace, allExpanded ? [] : changedFiles.map((f) => f.path))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {changes.data?.is_git_repo && (
        <GitViewToolbar
          idBase={gitViewIdBase}
          subTab={subTab}
          onSubTabChange={setSubTab}
          changedCount={changedFiles.length}
          commitsAhead={commitsAhead}
          commitsBehind={commitsBehind}
          upstream={upstream}
          mobile={mobile}
          allExpanded={changedFiles.length > 0 ? allExpanded : null}
          onToggleExpandAll={toggleExpandAll}
          // A phone has no pane menu to hold it.
          onRefresh={mobile ? handleRefresh : undefined}
        />
      )}
      <div
        ref={rememberReviewScroll}
        id={changes.data?.is_git_repo ? gitViewPanelId(gitViewIdBase) : undefined}
        role={changes.data?.is_git_repo ? 'tabpanel' : undefined}
        aria-labelledby={changes.data?.is_git_repo ? gitViewTabId(gitViewIdBase, subTab) : undefined}
        // Vertical only: ``overflow: auto`` lets one over-wide row pan the
        // whole list sideways.
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto touch-pan-y"
      >
        {subTab === 'changes' ? (
          <GitReviewSubPanel
            workspace={workspace}
            changedFiles={changedFiles}
            changes={changesView}
            files={filesView}
            selectedFilePath={selectedFilePath}
            expandedDiffs={expandedDiffs}
            toggleDiffExpanded={toggleDiffExpanded}
            mobile={mobile}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        ) : (
          <CommitHistorySubPanel
            workspace={workspace}
            gitHistory={historyView}
            commits={commits}
            expandedCommitSha={expandedCommitSha}
            setExpandedCommitSha={setExpandedCommitSha}
            expandedCommitFiles={expandedCommitFiles}
            setExpandedCommitFiles={setExpandedCommitFiles}
            commitDiff={commitDiffView}
            commitChangedFiles={commitChangedFiles}
            commitDiffSections={commitDiffSections}
            commitsScrollRef={commitsScrollRef}
            openCommitTab={openCommitPreview}
            mobile={mobile}
            setMobileCommitActions={setMobileCommitActions}
            setDesktopCommitActions={setDesktopCommitActions}
            setMobileFileActions={setMobileFileActions}
            setDesktopFileActions={setDesktopFileActions}
          />
        )}
      </div>
    </div>
  )
}
