/**
 * Locate folder… for a workspace whose folder is gone from disk: the
 * relocate dialog, which picks the new folder with the OS dialog when the
 * desktop app runs on its own server, and the toast that says where it moved.
 */
import { useCallback, useState } from 'react'
import type { CodingWorkspaceTreeRepository, WorkspaceRelocateResponse } from '@/api/types'
import { RelocateWorkspaceDialog } from '@/components/LazyRelocateWorkspaceDialog'
import { useToastStore } from '@/stores/useToastStore'
import { renameSavedWorkspace, workspaceLabel } from '@/utils/workspace'
import { pickWorkspaceDirectory, shouldUseServerWorkspaceBrowser } from './browser'

export type LocateFolder = ReturnType<typeof useLocateFolder>

export function useLocateFolder({
  isTauri,
  isTauriMobile,
  refreshSessionList,
}: {
  isTauri: boolean
  isTauriMobile: boolean
  /** Refetches the session lists and the tree once the workspace moved. */
  refreshSessionList: () => Promise<unknown>
}) {
  const pushToast = useToastStore((s) => s.push)
  // "Locate folder…" for a workspace whose folder is gone. ``native`` picks
  // with the OS dialog (the desktop app on its own server).
  const [relocateTarget, setRelocateTarget] = useState<{ path: string; native: boolean } | null>(null)
  const openRelocate = useCallback(async (path: string) => {
    let native = false
    try {
      native = !(await shouldUseServerWorkspaceBrowser(isTauri, isTauriMobile))
    } catch {
      native = false
    }
    setRelocateTarget({ path, native })
    // Stable `useState` setters are listed for the React Compiler, which
    // otherwise skips optimizing this hook.
  }, [isTauri, isTauriMobile, setRelocateTarget])
  const handleRelocated = useCallback((result: WorkspaceRelocateResponse) => {
    setRelocateTarget(null)
    renameSavedWorkspace(result.from, result.workspace)
    for (const moved of result.moved_worktrees) renameSavedWorkspace(moved.from, moved.to)
    void refreshSessionList()
    pushToast(result.warnings.length > 0
      ? { tone: 'error', title: `Moved to ${workspaceLabel(result.workspace)}, but git needs a hand`, description: result.warnings.join('\n') }
      : { tone: 'info', title: `Moved to ${workspaceLabel(result.workspace)}` })
  }, [pushToast, refreshSessionList, setRelocateTarget])
  return { relocateTarget, setRelocateTarget, openRelocate, handleRelocated }
}

export function LocateFolderDialog({
  locateFolder,
  workspaceByPath,
}: {
  locateFolder: LocateFolder
  workspaceByPath: Map<string, CodingWorkspaceTreeRepository>
}) {
  const { relocateTarget, setRelocateTarget, handleRelocated } = locateFolder
  return (
    <RelocateWorkspaceDialog
      from={relocateTarget?.path ?? null}
      name={relocateTarget ? workspaceByPath.get(relocateTarget.path)?.name : undefined}
      pickFolder={relocateTarget?.native ? pickWorkspaceDirectory : null}
      onClose={() => setRelocateTarget(null)}
      onRelocated={handleRelocated}
    />
  )
}
