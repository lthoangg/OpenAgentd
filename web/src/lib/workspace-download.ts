import { workspaceMediaUrl } from '@/api/client'
import { tauriDownload } from '@/lib/tauri-download'
import type { WorkspaceFileInfo } from '@/api/types'

export async function downloadWorkspaceFile(sessionId: string, file: WorkspaceFileInfo): Promise<void> {
  const url = workspaceMediaUrl(sessionId, file.path, { download: true })
  await tauriDownload(url, file.name)
}
