/**
 * Whether this page is on its way out (a reload onto another server, or
 * any navigation away). WebKit fires `visibilitychange` to hidden for a
 * document it unloads, and the phone must not read that as the app going to
 * the background: the new page never says it came back.
 */
let unloading = false

/** The page is about to unload (called before `location.reload()`, and on `pagehide`). */
export function markPageUnloading(): void {
  unloading = true
}

/** A page restored from the back/forward cache is live again. */
export function resetPageUnloading(): void {
  unloading = false
}

export function pageUnloading(): boolean {
  return unloading
}
