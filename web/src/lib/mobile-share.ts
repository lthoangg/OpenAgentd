import { getPlatform } from '@/hooks/use-platform'

/**
 * Share a link through the phone's own share sheet (iOS
 * ``UIActivityViewController``, Android ``ACTION_SEND`` chooser).
 *
 * Resolves ``true`` when the sheet was shown — not when the user finished
 * with it, which no platform reports reliably. Resolves ``false`` outside
 * the mobile shell, or when the native command fails, so the caller can fall
 * back to its own way of sharing (the Web Share API, copying the link).
 * It never rejects.
 *
 * ``title`` is the subject Android hands to mail-like targets and shows in
 * the chooser; iOS has no slot for it on an activity sheet and shares the
 * URL alone.
 */
export async function shareOnMobile(url: string, title?: string): Promise<boolean> {
  const { isTauri, os } = getPlatform()
  if (!isTauri || (os !== 'ios' && os !== 'android')) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    // ``title`` is left out rather than sent as ``undefined`` or an empty
    // string, so the shell sees "no title".
    await invoke('share_text', title ? { url, title } : { url })
    return true
  } catch {
    return false
  }
}
