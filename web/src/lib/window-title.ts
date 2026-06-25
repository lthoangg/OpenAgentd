import { getCurrentWindow } from '@tauri-apps/api/window'
import { workspaceLabel } from '@/utils/workspace'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

const APP_NAME = 'OpenAgentd'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
}

export function buildDesktopWindowTitle(options: {
  mode: 'normal' | 'coding'
  workspace?: string | null
  sessionTitle?: string | null
}): string {
  if (options.mode === 'coding' && options.workspace) {
    return workspaceLabel(options.workspace)
  }
  const title = options.sessionTitle?.trim()
  if (title) return title
  return APP_NAME
}

export async function syncDesktopWindowTitle(options: {
  mode: 'normal' | 'coding'
  workspace?: string | null
  sessionTitle?: string | null
}): Promise<void> {
  const title = buildDesktopWindowTitle(options)
  if (typeof document !== 'undefined') document.title = title
  if (!isTauriRuntime()) return
  try {
    await getCurrentWindow().setTitle(title)
  } catch {
    // Ignore — title sync is cosmetic and must not break chat.
  }
}
