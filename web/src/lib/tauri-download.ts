/**
 * Shared Tauri download helper.
 *
 * - http/https/data URLs → passed directly to Rust (reqwest fetches on device)
 * - blob: URLs           → read to base64 in JS (Rust can't reach browser-only blob URLs)
 * - Non-Tauri            → plain anchor download
 */
import { getPlatform } from '@/hooks/use-platform'
import { useToastStore } from '@/stores/useToastStore'

/** Chunk size for `String.fromCharCode`, comfortably inside the engine's
 *  argument limit. */
const BASE64_CHUNK_SIZE = 0x8000

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // Appending one character at a time builds a rope node per byte — tens
  // of millions of them for a large attachment, which stalls the webview
  // and thrashes GC. Encoding in chunks does the same work in a few
  // thousand calls.
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)))
  }
  return btoa(chunks.join(''))
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
