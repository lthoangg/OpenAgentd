/**
 * A best-effort clear of something sensitive put on the clipboard (the
 * recovery code): once, `CLIPBOARD_CLEAR_MS` later, while the app is
 * visible; when it is in the background then, on its next return.
 *
 * Module-level on purpose: the step that copied may close before the time
 * is up (the person confirms quickly), and the clear must still happen. A
 * new copy restarts the wait. A browser may refuse a write without a user
 * gesture; that failure is silent (it is best effort, and says so in
 * tunnel-threats.md).
 */
export const CLIPBOARD_CLEAR_MS = 2 * 60_000

let timer: ReturnType<typeof setTimeout> | null = null
let waitingForVisible: (() => void) | null = null

/** Drops a pending clear (tests; a new copy). */
export function cancelClipboardClear(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (waitingForVisible) document.removeEventListener('visibilitychange', waitingForVisible)
  waitingForVisible = null
}

function clearNow(): void {
  void navigator.clipboard?.writeText('').catch(() => undefined)
}

/** Clears the clipboard once, `CLIPBOARD_CLEAR_MS` from now, when visible. */
export function scheduleClipboardClear(): void {
  cancelClipboardClear()
  timer = setTimeout(() => {
    timer = null
    if (document.visibilityState === 'visible') {
      clearNow()
      return
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      cancelClipboardClear()
      clearNow()
    }
    waitingForVisible = onVisible
    document.addEventListener('visibilitychange', onVisible)
  }, CLIPBOARD_CLEAR_MS)
}
