/**
 * Shared query options for the workspace git diff endpoints.
 *
 * The review dock reads the same data from several places — the Changes
 * list, the file tree's badges, expanded rows, full-height diff tabs, the
 * inline commit expansion, and commit tabs. Sharing one factory per endpoint
 * keeps them on one cache entry (and on the keys
 * ``cache-invalidation-bridge.ts`` refreshes after agent writes) instead of
 * each view fetching its own copy.
 *
 * The working tree is split in two: a small list of changed paths, refetched
 * after every write, and one diff body per file, fetched only while that file
 * is expanded or open in a tab. A whole-repo diff can be megabytes; sending it
 * after every agent write stalled the clients, and cutting it at the server's
 * cap dropped files from the list.
 *
 * ``staleTime`` / ``enabled`` stay per-observer, as in ``workspace-files.ts``.
 */
import { getCodingWorkspaceChanges, getCodingWorkspaceCommitDiff, getCodingWorkspaceGitDiff } from '@/api/client'
import type { WorkspaceChangesResponse, WorkspaceCommitDiffResponse, WorkspaceGitDiffResponse } from '@/api/types'
import { queryKeys } from './keys'

export const WORKSPACE_DIFF_STALE_MS = 5_000
/** Commit patches are immutable, so re-expanding one should not refetch. */
export const COMMIT_DIFF_STALE_MS = 30_000

/** ``GET /agent/workspace/git-diff/files`` — every changed path, no bodies. */
export function workspaceChangesQueryOptions(workspace: string) {
  return {
    queryKey: queryKeys.coding.changes(workspace),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkspaceChangesResponse> =>
      getCodingWorkspaceChanges(workspace, signal),
  }
}

/** ``GET /agent/workspace/git-diff/view?paths=…`` — one file's working-tree diff. */
export function workspaceFileDiffQueryOptions(workspace: string, path: string) {
  return {
    queryKey: queryKeys.coding.fileDiff(workspace, path),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkspaceGitDiffResponse> =>
      getCodingWorkspaceGitDiff(workspace, [path], signal),
  }
}

/** ``GET /agent/workspace/git/commit-diff`` — one commit's patch. */
export function commitDiffQueryOptions(workspace: string, sha: string) {
  return {
    queryKey: queryKeys.coding.commitDiff(workspace, sha),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkspaceCommitDiffResponse> =>
      getCodingWorkspaceCommitDiff(workspace, sha, signal),
  }
}
