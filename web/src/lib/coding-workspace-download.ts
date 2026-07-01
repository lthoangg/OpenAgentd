import { codingWorkspaceFileUrl } from '@/api/client'
import { tauriDownload } from '@/lib/tauri-download'
import type { WorkspaceFileInfo } from '@/api/types'

export async function downloadCodingWorkspaceFile(workspace: string, file: WorkspaceFileInfo): Promise<void> {
  const url = codingWorkspaceFileUrl(workspace, file.path, { download: true })
  await tauriDownload(url, file.name)
}
