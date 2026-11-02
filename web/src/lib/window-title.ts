import { workspaceLabel } from '@/utils/workspace'
import { getPlatform } from '@/hooks/use-platform'
import { isDesktopShell } from '@/lib/desktop-shell'

const APP_NAME = 'OpenAgentd'

/** Longest session title kept in a window title (the Window menu and taskbar get unwieldy past this). */
const MAX_SESSION_TITLE_LEN = 60

export function buildDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
  /** Display label for the workspace; defaults to its basename. */
  workspaceName?: string | null
  /** Sessions waiting on the user; shown as a ``(n)`` prefix. */
  needsYou?: number
}): string {
  const base = baseTitle(options)
  return options.needsYou ? `(${options.needsYou}) ${base}` : base
}

function baseTitle(options: { workspace?: string | null; sessionTitle?: string | null; workspaceName?: string | null }): string {
  const title = truncate(options.sessionTitle?.trim() ?? '')
  const name = options.workspaceName?.trim() || (options.workspace ? workspaceLabel(options.workspace) : '')
  if (name && title && name !== title) return `${name} - ${title}`
  return title || name || APP_NAME
}

function truncate(text: string): string {
  return text.length > MAX_SESSION_TITLE_LEN ? `${text.slice(0, MAX_SESSION_TITLE_LEN - 1).trimEnd()}…` : text
}

let lastNativeTitle: string | null = null

/**
 * Sync the window title from the current session/workspace state, as
 * ``"<workspace> - <session title>"``.
 *
 * Always updates `document.title`. In the desktop app it also sets the native
 * window title, which is what the macOS Window menu, Mission Control and the
 * Windows/Linux title bar and taskbar show — the way to tell windows apart.
 *
 * macOS caveat: `NSWindow.setTitle` used to knock the traffic lights off
 * centre (see 9fcc7111). tao >= 0.37 re-applies the traffic-light inset after
 * `setTitle`, so this is expected to be safe; if the buttons shift, that fix
 * has regressed. The native call is skipped when the title is unchanged so
 * streaming/no-op updates never trigger a title-bar relayout.
 */
export function syncDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
  workspaceName?: string | null
  needsYou?: number
}): void {
  const title = buildDesktopWindowTitle(options)
  if (typeof document !== 'undefined') document.title = title
  void syncNativeWindowTitle(title)
}

async function syncNativeWindowTitle(title: string): Promise<void> {
  if (!getPlatform().isTauri || title === lastNativeTitle) return
  lastNativeTitle = title
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch (err) {
    // Retry on the next change; a title is never worth an error.
    lastNativeTitle = null
    console.debug('window title update failed', err)
  }
}

/**
 * The ``(n) `` this module last put in front of the title, so the next count
 * can swap it out without touching a title that merely starts with digits.
 */
let titleCountPrefix = ''

/**
 * Show the number of sessions waiting on the user in front of the title:
 * the browser tab, and on routes that never build their own title. A route
 * that does (``syncDesktopWindowTitle``) writes the same prefix, so either
 * may run first. Returns whether the title changed.
 */
function applyTitleCount(count: number): boolean {
  if (typeof document === 'undefined') return false
  const next = count > 0 ? `(${count}) ` : ''
  let base = document.title
  if (titleCountPrefix && base.startsWith(titleCountPrefix)) base = base.slice(titleCountPrefix.length)
  else if (next && base.startsWith(next)) base = base.slice(next.length)
  titleCountPrefix = next
  const title = next + base
  if (title === document.title) return false
  document.title = title
  return true
}

/**
 * Badge the app with the number of sessions waiting on the user; zero clears
 * it. The desktop shell draws it: the dock (macOS), the launcher (Linux), a
 * taskbar overlay (Windows). The phone apps badge their own icon, and a
 * browser tab shows the count in its title. Every window sets the same
 * count, so the last one to update wins without disagreeing.
 */
export async function syncDesktopBadgeCount(count: number): Promise<void> {
  const titleChanged = applyTitleCount(count)
  if (!getPlatform().isTauri) return
  if (titleChanged && isDesktopShell()) void syncNativeWindowTitle(document.title)
  try {
    if (isDesktopShell()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_attention_badge', { count })
      return
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined)
  } catch (err) {
    // A badge is never worth an error.
    console.debug('app badge update failed', err)
  }
}

/**
 * Ask the OS to point at the app once: the Dock icon bounces once on macOS,
 * the taskbar button flashes on Windows (which has no badge), Linux marks
 * the window urgent. Only from the desktop app and only while this window
 * is in the background; in front of the user the change is already visible.
 */
export async function requestDesktopAttention(): Promise<void> {
  if (!isDesktopShell() || document.hasFocus()) return
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window')
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational)
  } catch (err) {
    console.debug('attention request failed', err)
  }
}
