/**
 * TanStack Query hook for the per-session workspace file listing.
 *
 * Mirrors the pattern in ``useMemoryQuery`` — the list is invalidated by the
 * team store whenever a write/edit/rm tool targets the agent workspace so the
 * panel reflects changes as soon as a turn finishes producing them.
 */
import { useQuery } from '@tanstack/react-query'
import { WORKSPACE_TREE_STALE_MS, workspaceFilesQueryOptions } from './workspace-files'

export function useWorkspaceFilesQuery(sessionId: string | null | undefined) {
  return useQuery({
    // Shared cache entry with the InputBar @-mention picker — same endpoint,
    // same payload. See ``workspace-files.ts``.
    ...workspaceFilesQueryOptions(sessionId ?? ''),
    enabled: !!sessionId,
    // Short stale time — the panel is visible only on demand and we also
    // invalidate explicitly from the team store, so a small window is fine.
    staleTime: WORKSPACE_TREE_STALE_MS,
  })
}
