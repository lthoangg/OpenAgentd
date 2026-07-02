/**
 * Shared "is this keydown target something the user is typing into"
 * check. Used to gate window-level keyboard handlers (global Backspace
 * guard, type-to-focus-chat-input) so they don't interfere with normal
 * editing inside inputs, textareas, contenteditable areas, or scoped
 * scroll/selection containers (e.g. text preview pane, code viewer —
 * see ``data-scroll-capture``).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('[data-scroll-capture]')) return true
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}
