/**
 * Starting the app on this page, for a server switch that would otherwise
 * reload it.
 *
 * A switch to another server reloads the window, so nothing of the old
 * server stays in the page. A phone that only uses its account's computers
 * has no server to be on when it launches: the launch check opens the
 * computer last used before the app (the router) has started at all, and a
 * reload there loads the same bundle a second time for nothing. The
 * bootstrap hook says how to start (`setAppStarter`); the switch asks
 * (`startAppHere`, through `landOnSwitchedBackend`).
 */
type Starter = () => Promise<boolean>

let starter: Starter | null = null
let started = false

/** How to start the app on the server the shell is on now; `null` when nothing can. */
export function setAppStarter(next: Starter | null): void {
  starter = next
}

/** The app is running on this page: from here a switch reloads. */
export function noteAppStarted(): void {
  started = true
}

/**
 * Start the app on the server the shell is on, if it has not started on
 * this page. True when this call started it; false leaves the caller to
 * reload.
 */
export async function startAppHere(): Promise<boolean> {
  if (started || !starter) return false
  return starter().catch(() => false)
}

/** Test seam: a new page. */
export function resetAppStart(): void {
  starter = null
  started = false
}
