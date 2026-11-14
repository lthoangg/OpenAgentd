/**
 * The tray menu's session row, which Windows and Linux have
 * (``desktop/src-tauri/src/menu.rs``). The Mac tray is a popup with no such
 * row, so nothing is sent there.
 *
 * On non-Tauri runtimes (regular browser tab, headless build, unit tests)
 * these are no-ops so callers can fire them unconditionally without guards.
 */
import { getPlatform } from '@/hooks/use-platform'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
}

/**
 * Update the tray menu's session label to describe what the user is
 * currently working on (e.g. ``"openagentd"`` or
 * ``"Chat: Refactor auth flow"``). Pass an empty string to reset the
 * label to the idle placeholder.
 *
 * Failures are swallowed: a missing or stale Tauri command must not
 * crash the chat surface.
 */
export async function setTraySession(text: string): Promise<void> {
  if (!isTauriRuntime() || getPlatform().os === 'macos') return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_tray_session', { text })
  } catch {
    // Ignore — the tray is informational; backend silence is acceptable.
  }
}
