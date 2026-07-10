/**
 * Workspace file/folder list for the InputBar's @-mention picker.
 *
 * Hits one of two existing endpoints depending on mode:
 *   - coding:  GET /api/team/workspace/files/list?workspace=...
 *   - normal:  GET /api/team/{session_id}/files
 *
 * Both return a flat list of files (max 500, gitignore-aware). Folder entries
 * are derived client-side from the path prefixes so the user can also reference
 * directories with `@some/dir/`.
 *
 * The query is gated on input-bar activation (``enabled``) so we don't walk the
 * workspace on every chat-view mount — the picker only fetches when the user
 * actually opens the composer or types ``@``.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listCodingWorkspaceFiles, listWorkspaceFiles } from '@/api/client'
import type { WorkspaceFileInfo } from '@/api/types'
import type { FileRef } from '@/components/InputBar.mentions'
import { queryKeys } from './keys'

// Both endpoints share the same row shape but differ on the envelope. We only
// care about ``files`` here, so normalise to that.
interface FileListing { files: WorkspaceFileInfo[] }

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

  const query = useQuery<FileListing>({
    queryKey: isCoding
      ? queryKeys.coding.files(workspace ?? '')
      : queryKeys.fileRefs.session(sessionId ?? ''),
    queryFn: async (): Promise<FileListing> => {
      const res = isCoding
        ? await listCodingWorkspaceFiles(workspace as string)
        : await listWorkspaceFiles(sessionId as string)
      return { files: res.files }
    },
    enabled: enabled && hasWorkspace,
    // Files change frequently while an agent writes them. 30s is a comfortable
    // window for casual @-mention use; users can re-fetch by closing/reopening
    // the menu (refetchOnMount runs when the query is re-enabled).
    staleTime: 30_000,
  })

  // Build the combined files+dirs list once per query response. Files appear
  // first so the most common case (referencing a file) is at the top.
  const refs = useMemo<FileRef[]>(() => {
    const files = query.data?.files ?? []
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
