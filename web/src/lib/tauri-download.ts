/**
 * Shared Tauri download helper.
 *
 * - http/https/data URLs → passed directly to Rust (reqwest fetches on device)
 * - blob: URLs           → read to base64 in JS (Rust can't reach browser-only blob URLs)
 * - Non-Tauri            → plain anchor download
 */
import { getPlatform } from '@/hooks/use-platform'
import { useToastStore } from '@/stores/useToastStore'

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function anchorDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function tauriDownload(url: string, filename: string): Promise<void> {
  if (getPlatform().isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (url.startsWith('blob:')) {
        const blob = await fetch(url).then((r) => r.blob())
        const base64 = await blobToBase64(blob)
        await invoke('save_workspace_file', { request: { base64, filename } })
      } else {
        await invoke('save_workspace_file', { request: { url, filename } })
      }
      return
    } catch (e) {
      console.error('[tauri-download] invoke failed:', e)
      useToastStore.getState().push({
        tone: 'error',
        title: 'Download failed',
        description: e instanceof Error ? e.message : String(e),
      })
      return
    }
  }
  anchorDownload(url, filename)
}
