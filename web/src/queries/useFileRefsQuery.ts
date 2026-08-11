/**
 * Workspace file/folder list for the InputBar's @-mention picker.
 *
 * Hits one of two existing endpoints depending on mode:
 *   - coding:  GET /api/team/workspace/files/list?workspace=...
 *   - normal:  GET /api/team/{session_id}/files
 *
 * Both return a flat list of files (max 5,000, gitignore-aware). Folder entries
 * are derived client-side from the path prefixes so the user can also reference
 * directories with `@some/dir/`.
 *
 * The query shares its cache entry with the workspace file trees in both modes
 * (see ``queries/workspace-files.ts``) — the listing is an expensive recursive
 * walk, so the picker must never fetch its own copy, and sharing the key is
 * what makes the ``workspace_files`` / ``coding_workspace`` invalidations
 * refresh the picker after the agent writes files.
 *
 * The query is gated on input-bar activation (``enabled``) so we don't walk the
 * workspace on every chat-view mount — the picker only fetches when the user
 * actually opens the composer or types ``@``.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkspaceFileInfo } from '@/api/types'
import type { FileRef } from '@/components/InputBar.mentions'
/**
 * The picker only reads ``files``, and the two endpoints' responses differ in
 * their other fields. Typing the reader against this common supertype lets one
 * ``useQuery`` call serve both modes; the value written to the cache is still
 * the full, unmodified response object (see ``workspace-files.ts``).
 */
interface WorkspaceFileListing {
  files: WorkspaceFileInfo[]
}
import {
  WORKSPACE_FILES_STALE_MS,
  codingWorkspaceFilesQueryOptions,
  workspaceFilesQueryOptions,
} from './workspace-files'

interface UseFileRefsQueryArgs {
  mode: 'normal' | 'coding'
  sessionId?: string | null
  workspace?: string | null
  /** Only fetch when the input bar wants the list (focus / @ keystroke). */
  enabled?: boolean
}

/** Derive folder entries from a flat file list by walking each path's prefixes. */
function deriveDirs(files: readonly { path: string }[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.path.split('/')
    // Last segment is the file basename — skip it. Every earlier segment
    // forms a directory path when joined cumulatively.
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
  }
  return [...dirs].sort()
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

export function useFileRefsQuery({
  mode,
  sessionId,
  workspace,
  enabled = true,
}: UseFileRefsQueryArgs) {
  const isCoding = mode === 'coding'
  const hasWorkspace = isCoding ? Boolean(workspace) : Boolean(sessionId)

  const options = isCoding
    ? codingWorkspaceFilesQueryOptions(workspace ?? '')
    : workspaceFilesQueryOptions(sessionId ?? '')

  const query = useQuery<WorkspaceFileListing, Error, WorkspaceFileListing, readonly unknown[]>({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    enabled: enabled && hasWorkspace,
    // Files change frequently while an agent writes them, but the cache-
    // invalidation bridge refreshes this entry on every file-mutating tool_end
    // and after /undo + /redo, so time-based staleness only has to cover
    // out-of-band edits (the user's own editor).
    staleTime: WORKSPACE_FILES_STALE_MS,
  })

  // Build the combined files+dirs list once per query response. Files appear
  // first so the most common case (referencing a file) is at the top.
  const refs = useMemo<FileRef[]>(() => {
    const files: WorkspaceFileInfo[] = query.data?.files ?? []
    const fileRefs: FileRef[] = files.map((f) => ({
      path: f.path,
      name: f.name,
      type: 'file',
    }))
    const dirRefs: FileRef[] = deriveDirs(files).map((p) => ({
      path: p,
      name: basename(p),
      type: 'directory',
    }))
    return [...fileRefs, ...dirRefs]
  }, [query.data])

  return { refs, isLoading: query.isLoading, error: query.error }
}
