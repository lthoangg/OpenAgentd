import { workspaceLabel } from '@/utils/workspace'

const APP_NAME = 'OpenAgentd'

export function buildDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
}): string {
  const title = options.sessionTitle?.trim()
  if (title) return title
  if (options.workspace) {
    return workspaceLabel(options.workspace)
  }
  return APP_NAME
}

/**
 * Sync the browser tab title from the current session/workspace state.
 *
 * Only updates `document.title` — we intentionally do NOT call
 * `NSWindow.setTitle` on macOS Tauri because it triggers an AppKit
 * titlebar relayout that resets the traffic-light vertical position.
 * The native window title stays as "OpenAgentd" (set at build time in
 * `configure_window_chrome`) and is invisible to the user inside the app.
 */
export function syncDesktopWindowTitle(options: {
  workspace?: string | null
  sessionTitle?: string | null
}): void {
  const title = buildDesktopWindowTitle(options)
  if (typeof document !== 'undefined') document.title = title
}
