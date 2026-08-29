import { useEffect } from 'react'
import { isDraggingFiles } from '@/lib/is-dragging-files'

/** Elements that accept file drops mark themselves with this attribute. */
const DROP_ZONE_SELECTOR = '[data-file-drop-zone]'

/**
 * Dropping a file anywhere on a page is, by browser default, a request to
 * *navigate to that file* — the SPA is replaced by a `file://` view of the
 * dropped image and every bit of unsent state (draft message, attachments,
 * scroll position, open panels) is gone. Missing the chat column by a few
 * pixels and landing on the sidebar or header is enough to trigger it.
 *
 * Swallow file drags globally, except inside elements that opted in with
 * ``data-file-drop-zone`` — those run their own handlers (see
 * ``AgentChatView/useDragDrop``). Non-file drags are left completely alone so
 * native text drag-and-drop keeps working.
 */
export function usePreventStrayFileDrop(): void {
  useEffect(() => {
    const isInsideDropZone = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest(DROP_ZONE_SELECTOR) !== null

    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented) return
      if (!isDraggingFiles(e.dataTransfer)) return
      if (isInsideDropZone(e.target)) return
      // ``preventDefault`` here is what stops the drop from reaching the
      // browser's navigation default; ``dropEffect = 'none'`` keeps the
      // cursor honest about there being nothing to drop onto.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }

    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return
      if (!isDraggingFiles(e.dataTransfer)) return
      if (isInsideDropZone(e.target)) return
      e.preventDefault()
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])
}
