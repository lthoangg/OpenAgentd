/**
 * The phone shell's answer to "the app is in front again".
 *
 * iOS may take a suspended app's listening sockets, so the shell reopens its
 * local bridges when the page says `resumed` (`lib/account-route.ts`). A
 * request sent before that answer finds no bridge and fails, and the chat's
 * reload on return was the first to try. It waits here instead, for a
 * bounded time. Kept apart from `account-route` so the chat does not load
 * the phone-only module.
 */

/** How long the chat's reload waits for the shell. */
export const SHELL_RESUME_CAP_MS = 2000

let watchers = 0
let pending: Promise<void> | null = null

/** The shell reports its resumes from now on. Returns the stop. */
export function watchShellResume(): () => void {
  watchers += 1
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    watchers -= 1
    if (watchers === 0) pending = null
  }
}

/** `poke` settles once the shell has answered a `resumed` poke. */
export function noteShellResume(poke: Promise<unknown>): void {
  if (watchers === 0) return
  const settled = poke.then(() => undefined, () => undefined)
  pending = settled
  void settled.then(() => {
    if (pending === settled) pending = null
  })
}

/**
 * Resolves once the shell has answered the resume in progress, or after
 * `capMs`. At once where no shell reports resumes (browser, desktop).
 */
export async function shellResumed(capMs: number = SHELL_RESUME_CAP_MS): Promise<void> {
  if (watchers === 0) return
  // Every listener of the event that brought the app back has run by then,
  // whichever was registered first.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const current = pending
  if (!current) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs) })
  await Promise.race([current, cap])
  clearTimeout(timer)
}
