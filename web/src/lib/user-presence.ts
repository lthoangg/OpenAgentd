import { getPlatform } from '@/hooks/use-platform'

/**
 * Asks the person at this computer to confirm before it adds a device to
 * the account: Touch ID or the login password in the desktop app on a Mac
 * that has one (`desktop/src-tauri/src/presence.rs`). In a browser, or a
 * shell without the command, the click that got here is the confirmation:
 * the server's account routes answer only this computer anyway.
 */
export async function confirmUserPresence(reason: string): Promise<boolean> {
  const { isTauri, os } = getPlatform()
  if (!isTauri || os === 'ios' || os === 'android') return true
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<boolean>('confirm_user_presence', { reason })
}
