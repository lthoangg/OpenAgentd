/**
 * The Review panel's server state: the queries its tabs and menus share,
 * each paused while the dock is closed, and Git's while the workspace is
 * not a known repository. The workspace listing and the changed paths feed
 * every tab; the status and the history feed the Git tab and the commit
 * menus, the history only while the Git tab is on screen on Commits. Each
 * file's diff body loads in the view that shows it.
 */
// Not compiled, as when this code was part of WorkspacePanel, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { getCodingWorkspaceGitHistory, getCodingWorkspaceStatus } from '@/api/client'
import { queryKeys } from '@/queries'
import { WORKSPACE_TREE_STALE_MS, workspaceFileListQueryOptions } from '@/queries/workspace-files'
import { WORKSPACE_DIFF_STALE_MS, workspaceChangesQueryOptions } from '@/queries/workspace-git'
import { DEFAULT_WORKSPACE_STATE, useGitPanelStore } from '@/stores/useGitPanelStore'
import { changedFilesFromResponse } from './diff-helpers'

export function useDockQueries({
  workspace,
  open,
  gitKnown,
  noGit,
  reviewShown,
}: {
  workspace: string
  open: boolean
  /** The workspace is known to be a Git repository. */
  gitKnown: boolean
  /** Chat or a folder without Git: no Changes view. */
  noGit: boolean
  /** The Git tab shows in a pane on screen. */
  reviewShown: boolean
}) {
  const files = useQuery({
    ...workspaceFileListQueryOptions(workspace),
    enabled: open,
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
  // The changed paths only; each file's diff body loads when it is expanded
  // or opened in a tab (see ``workspace-git.ts``).
  const changes = useQuery({
    ...workspaceChangesQueryOptions(workspace),
    enabled: open && gitKnown,
    staleTime: WORKSPACE_DIFF_STALE_MS,
  })
  const queryClient = useQueryClient()
  /** Refetch the changed paths and every diff body on screen. */
  const refreshChanges = useCallback(() => {
    void changes.refetch()
    void queryClient.invalidateQueries({ queryKey: queryKeys.coding.diff(workspace) })
  }, [changes, queryClient, workspace])
  const workspaceStatus = useQuery({
    queryKey: queryKeys.coding.status(workspace),
    queryFn: ({ signal }) => getCodingWorkspaceStatus(workspace, signal),
    enabled: open && gitKnown,
    staleTime: 10_000,
  })
  const changedFiles = useMemo(() => changedFilesFromResponse(changes.data), [changes.data])
  // Working-tree status per changed path; ``has`` doubles as "is changed".
  const changedPaths = useMemo(() => new Map(changedFiles.map((file) => [file.path, file.status])), [changedFiles])
  const filesByPath = useMemo(() => new Map((files.data?.files ?? []).map((file) => [file.path, file])), [files.data?.files])

  const gitState = useGitPanelStore((s) => s.workspaces[workspace] || DEFAULT_WORKSPACE_STATE)
  const subTab = gitState.subTab
  const historyLimit = 50
  const gitHistory = useInfiniteQuery({
    queryKey: queryKeys.coding.history(workspace, historyLimit),
    queryFn: ({ pageParam, signal }) => getCodingWorkspaceGitHistory(workspace, historyLimit, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? null,
    enabled: open && gitKnown && reviewShown && subTab === 'commits',
    staleTime: 10_000,
  })

  const commits = useMemo(() => gitHistory.data?.pages.flatMap((page) => page.commits) ?? [], [gitHistory.data?.pages])

  const handleRefresh = useCallback(() => {
    void files.refetch()
    if (noGit) return
    refreshChanges()
    void workspaceStatus.refetch()
    if (subTab === 'commits') {
      void gitHistory.refetch()
    }
  }, [files, refreshChanges, workspaceStatus, gitHistory, subTab, noGit])

  // Expansions persist per workspace; forget files that are no longer
  // changed so a later edit to them does not reopen as a stale peek and the
  // stored list does not grow forever. A capped list (over 5,000 files)
  // cannot prove a path is gone.
  useEffect(() => {
    if (!changes.data?.is_git_repo || changes.data.truncated) return
    const stored = useGitPanelStore.getState().workspaces[workspace]?.expandedDiffs ?? []
    const kept = stored.filter((path) => changedPaths.has(path))
    if (kept.length !== stored.length) useGitPanelStore.getState().setExpandedDiffs(workspace, kept)
  }, [changes.data, changedPaths, workspace])

  return {
    files,
    changes,
    refreshChanges,
    workspaceStatus,
    changedFiles,
    changedPaths,
    filesByPath,
    gitState,
    gitHistory,
    commits,
    handleRefresh,
  }
}
