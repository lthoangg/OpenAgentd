/**
 * Links to one session, for Copy link and Share… on a session's menu.
 *
 * The desktop and mobile apps hand out the ``openagentd://session/<id>`` deep
 * link, which opens the session in whichever app window shows it (or a new
 * one). A browser hands out its own address for the session, so the link
 * opens in the same web UI.
 */
import { getPlatform } from '@/hooks/use-platform'
import { shareOnMobile } from '@/lib/mobile-share'
import { canShareNatively, shareNative, type SharePoint } from '@/lib/native-share'

export function sessionLink(sessionId: string, isTauri: boolean): string {
  const id = encodeURIComponent(sessionId)
  return isTauri ? `openagentd://session/${id}` : `${window.location.origin}/${id}`
}

export type ShareOutcome = 'shared' | 'copied' | 'cancelled'

function isPhoneApp(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

/** Whether Share… can open a system share sheet here; without one it would only copy. */
export function canShareSession(): boolean {
  return canShareNatively() || isPhoneApp() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function')
}

/**
 * Share a session link with the system share sheet when the platform has one:
 * the desktop app's own (macOS, Windows), the phone app's (iOS, Android,
 * whose WebView has no Web Share), else Web Share (Safari, Edge…); otherwise
 * copy it. Closing the share sheet is not an error.
 * ``at`` anchors the macOS sheet (client coordinates); without it, the last
 * press does.
 */
export async function shareSessionLink(
  session: { id: string; title?: string | null },
  isTauri: boolean,
  at?: SharePoint,
): Promise<ShareOutcome> {
  const url = sessionLink(session.id, isTauri)
  const title = session.title || 'Untitled session'
  if (canShareNatively() && (await shareNative(url, title, at))) return 'shared'
  if (isPhoneApp() && (await shareOnMobile(url, title))) return 'shared'
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
