import { workspaceMediaUrl } from '@/api/client'
import { getPlatform } from '@/hooks/use-platform'
import type { WorkspaceFileInfo } from '@/api/types'

export async function downloadWorkspaceFile(sessionId: string, file: WorkspaceFileInfo): Promise<void> {
  const url = workspaceMediaUrl(sessionId, file.path, { download: true })
  if (getPlatform().isTauri) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_workspace_file', { request: { url, filename: file.name } })
    return
  }

  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
}
