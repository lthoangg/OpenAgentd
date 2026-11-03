/**
 * Open the file a terminal link names: resolve it against the shell's cwd and
 * the workspace, then ask the chat view to show it in the dock (at the line,
 * when the output gave one). Paths outside the workspace are refused with a
 * toast, because the dock only shows workspace files.
 */
import { requestOpenWorkspaceFile } from '@/lib/open-file-request'
import { useToastStore } from '@/stores/useToastStore'
import type { FileRef } from '@/utils/file-refs'
import { resolveTerminalPath } from './terminal-links'

export function openTerminalFileLink(ref: FileRef, cwd: string | null, workspace: string | null): boolean {
  const path = resolveTerminalPath(ref.path, cwd, workspace)
  if (!path) {
    useToastStore.getState().push({
      tone: 'info',
      title: 'Outside the workspace',
      description: `${ref.path} is not in this workspace, so it cannot open here.`,
    })
    return false
  }
  requestOpenWorkspaceFile({ ...ref, path })
  return true
}
