/**
 * Whether a drag event's ``DataTransfer`` carries files (vs. text/other).
 *
 * Matched strictly against the two markers browsers actually set for OS file
 * drags. Notably ``text/uri-list`` does *not* count: an image or link dragged
 * out of another tab advertises it, but ``dataTransfer.files`` is empty on
 * drop — so a looser test lights up the "Drop files to attach" overlay for a
 * gesture that can never produce an attachment.
 *
 * Lives in ``lib/`` rather than beside the chat composer because both the
 * chat column's drop zone and the app-wide stray-drop guard
 * (``usePreventStrayFileDrop``) have to agree on what counts as a file drag.
 */
export function isDraggingFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (!dt.types) return false
  return Array.from(dt.types).some(
    (type) =>
      type.toLowerCase() === 'files' ||
      type === 'application/x-moz-file'
  )
}
