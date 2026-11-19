/**
 * Telling a link a reloaded page already handled from the same link opened
 * again.
 *
 * The deep-link plugin reports the last opened link for the life of the app,
 * so a page that reloads reads it again and must skip it. The link alone
 * cannot tell that apart from the same link opened again while no page was
 * listening (iOS ended it in the background): a widget's row and a QR code
 * each have one fixed link. The phone shell counts the links it has seen
 * arrive (`deep_link_sequence`, `mobile/src-tauri/src/links.rs`), and a link
 * is remembered with that count, so the later one runs. Where the shell does
 * not count (the desktop, an older phone shell) the link alone tells.
 */
import { isMobileApp } from '@/lib/mobile-app'

/** How many links the phone shell has seen arrive this app run; 0 where it does not count. */
export async function linkSequence(): Promise<number> {
  if (!isMobileApp()) return 0
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const count: unknown = await invoke('deep_link_sequence')
    return typeof count === 'number' && count > 0 ? count : 0
  } catch {
    return 0
  }
}

/** What a link is remembered under: the link, after its count where the shell keeps one (a link holds no space). */
export function deliveredKey(url: string, sequence: number): string {
  return sequence > 0 ? `${sequence} ${url}` : url
}
