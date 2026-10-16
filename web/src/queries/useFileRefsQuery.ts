/**
 * Workspace file/folder list for the InputComposer's @-mention picker.
 *
 * Hits the workspace files endpoint:
 *   GET /api/agent/workspace/files/list?workspace=...
 *
 * Both return a flat list of files (max 5,000): visible files first, then
 * gitignored ones flagged ``ignored`` (noise dirs such as ``node_modules`` are
 * never listed). Folder entries are derived client-side from the path prefixes
 * so the user can also reference directories with `@some/dir/`; a folder is
 * ``ignored`` when every file listed under it is.
 *
 * The query shares its cache entry with the workspace file tree
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
import type { FileRef } from '@/components/InputComposer.mentions'
/**
 * The picker only reads ``files``; the value written to the cache is still the
 * full, unmodified response object (see ``workspace-files.ts``).
 */
interface WorkspaceFileListing {
  files: WorkspaceFileInfo[]
}
import {
  WORKSPACE_FILES_STALE_MS,
  workspaceFileListQueryOptions,
} from './workspace-files'

interface UseFileRefsQueryArgs {
  workspace?: string | null
  /** Only fetch when the input bar wants the list (focus / @ keystroke). */
  enabled?: boolean
}

/**
 * Derive folder entries from a flat file list by walking each path's prefixes.
 * Maps each folder to whether it holds only ignored files.
 */
function deriveDirs(files: readonly { path: string; ignored?: boolean }[]): Map<string, boolean> {
  const dirs = new Map<string, boolean>()
  for (const f of files) {
    const parts = f.path.split('/')
    // Last segment is the file basename — skip it. Every earlier segment
    // forms a directory path when joined cumulatively.
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      dirs.set(dir, (dirs.get(dir) ?? true) && f.ignored === true)
    }
  }
  return new Map([...dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

export function useFileRefsQuery({
  workspace,
  enabled = true,
}: UseFileRefsQueryArgs) {
  const options = workspaceFileListQueryOptions(workspace ?? '')

  const query = useQuery<WorkspaceFileListing, Error, WorkspaceFileListing, readonly unknown[]>({
    queryKey: options.queryKey,
    queryFn: options.queryFn,
    enabled: enabled && Boolean(workspace),
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
      ...(f.ignored ? { ignored: true } : {}),
    }))
    const dirRefs: FileRef[] = [...deriveDirs(files)].map(([p, ignored]) => ({
      path: p,
      name: basename(p),
      type: 'directory',
      ...(ignored ? { ignored: true } : {}),
    }))
    return [...fileRefs, ...dirRefs]
  }, [query.data])

  return { refs, isLoading: query.isLoading, error: query.error }
}
