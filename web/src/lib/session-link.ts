/**
 * Links to one session, for Copy link and Share… on a session's menu.
 *
 * The desktop and mobile apps hand out the ``openagentd://session/<id>`` deep
 * link, which opens the session in whichever app window shows it (or a new
 * one). A browser hands out its own address for the session, so the link
 * opens in the same web UI.
 */

export function sessionLink(sessionId: string, isTauri: boolean): string {
  const id = encodeURIComponent(sessionId)
  return isTauri ? `openagentd://session/${id}` : `${window.location.origin}/${id}`
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled'

/**
 * Share a session link with the system share sheet when the platform has one
 * (Web Share: iOS, Android, Safari, Edge…); otherwise copy it. Closing the
 * share sheet is not an error.
 */
export async function shareSessionLink(
  session: { id: string; title?: string | null },
  isTauri: boolean,
): Promise<ShareOutcome> {
  const url = sessionLink(session.id, isTauri)
  const title = session.title || 'Untitled session'
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
      // A refused share (no user gesture, blocked by policy) falls back to copying.
    }
  }
  await navigator.clipboard.writeText(url)
  return 'copied'
}

/** Copy a session link to the clipboard. */
export async function copySessionLink(sessionId: string, isTauri: boolean): Promise<void> {
  await navigator.clipboard.writeText(sessionLink(sessionId, isTauri))
}
