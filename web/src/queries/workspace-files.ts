/**
 * Shared query options for the two workspace file-listing endpoints.
 *
 * Both listings are served by a **recursive `os.walk` + per-file stat +
 * gitignore match** on the backend (capped at 500 entries and offloaded to a
 * worker thread precisely because it is slow). Every consumer must therefore
 * share one cache entry per workspace/session rather than fetching its own
 * copy.
 *
 * Consumers: `WorkspaceFilesPanel` (artifacts tree), `CodingWorkspacePanel`
 * (coding file tree), the InputBar `@`-mention picker (`useFileRefsQuery`), and
 * the coding command palette (`useCommandPalette`).
 *
 * Two invariants these factories exist to enforce:
 *
 * 1. **One key per endpoint.** The `workspace_files` / `coding_workspace`
 *    invalidations in `cache-invalidation-bridge.ts` target exactly these
 *    keys, so a consumer that invents its own key silently stops receiving
 *    post-write refreshes.
 * 2. **One cached shape per key.** Consumers that narrowed the payload (e.g.
 *    to `{ files }`) used to race the ones that stored the full response —
 *    whichever resolved last won, and fields like `truncated` became
 *    `undefined` for the other reader. Always cache the full response and let
 *    each consumer read the fields it needs.
 *
 * `staleTime` is deliberately *not* fixed here: it is a per-observer concern.
 * The always-visible trees use a short window; the on-demand pickers use a
 * longer one. Freshness after agent writes comes from explicit invalidation,
 * not from polling.
 */
import { listCodingWorkspaceFiles, listWorkspaceFiles } from '@/api/client'
import type { CodingWorkspaceFilesResponse, WorkspaceFilesResponse } from '@/api/types'
import { queryKeys } from './keys'

/** Default staleness for on-demand consumers (pickers, palettes). */
export const WORKSPACE_FILES_STALE_MS = 30_000
/** Default staleness for always-visible file trees. */
export const WORKSPACE_TREE_STALE_MS = 5_000

/** `GET /team/{session_id}/files` — normal-mode session workspace. */
export function workspaceFilesQueryOptions(sessionId: string) {
  return {
    queryKey: queryKeys.team.files(sessionId),
    queryFn: (): Promise<WorkspaceFilesResponse> => listWorkspaceFiles(sessionId),
  }
}

/** `GET /team/workspace/files/list` — coding-mode workspace. */
export function codingWorkspaceFilesQueryOptions(workspace: string) {
  return {
    queryKey: queryKeys.coding.files(workspace),
    queryFn: (): Promise<CodingWorkspaceFilesResponse> =>
      listCodingWorkspaceFiles(workspace),
  }
}
