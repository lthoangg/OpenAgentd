/**
 * Open-file requests: a window event that asks the chat view to show a
 * workspace file in the dock, at a line when given. The terminal's file links
 * use it, since the terminal lives inside the dock and must not import the
 * panel that hosts it. ``useOverlayState`` listens and opens the file the same
 * way a ``src/app.ts:42`` reference in the chat does.
 */
import type { FileRef } from '@/utils/file-refs'

export const OPEN_WORKSPACE_FILE_EVENT = 'workspace:open-file'

/** Ask the open session's dock to show ``ref`` (a workspace-relative path). */
export function requestOpenWorkspaceFile(ref: FileRef): void {
  window.dispatchEvent(new CustomEvent<FileRef>(OPEN_WORKSPACE_FILE_EVENT, { detail: ref }))
}

/** Listen for open-file requests; returns the unsubscribe function. */
export function onOpenWorkspaceFileRequest(handler: (ref: FileRef) => void): () => void {
  const listener = (event: Event) => {
    const ref = (event as CustomEvent<FileRef | undefined>).detail
    if (ref?.path) handler(ref)
  }
  window.addEventListener(OPEN_WORKSPACE_FILE_EVENT, listener)
  return () => window.removeEventListener(OPEN_WORKSPACE_FILE_EVENT, listener)
}
