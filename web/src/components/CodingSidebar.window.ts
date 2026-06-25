import type React from 'react'
import type { SessionResponse } from '@/api/types'

export function shouldOpenSessionInNewWindow(
  event: React.MouseEvent | undefined,
  isTauri: boolean,
  os: string,
): boolean {
  if (!event || !isTauri) return false
  return os === 'macos' ? event.metaKey : (event.ctrlKey || event.metaKey)
}

export async function openSessionInNewWindow(options: {
  session: SessionResponse
  importCore?: () => Promise<{ invoke: (command: string, args: Record<string, string>) => Promise<unknown> }>
}): Promise<void> {
  const core = await (options.importCore ?? (() => import('@tauri-apps/api/core')))()
  await core.invoke('app_new_window', {
    initialPath: `/coding/${options.session.id}`,
    initial_path: `/coding/${options.session.id}`,
  })
}

export function sessionWindowErrorDescription(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}
