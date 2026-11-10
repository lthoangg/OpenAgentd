import { getPlatform } from '@/hooks/use-platform'

/** What the person is approving on this computer's account. */
export type ApprovalAction =
  | { action: 'approve'; id: string; signer: boolean; server: boolean; client: boolean }
  | { action: 'remove'; id: string }
  /** Show an invitation (`id`: `start`) or look at its candidates (its slot id); no confirmation asked. */
  | { action: 'invite'; id: string }

/**
 * Whether this window can approve: only the desktop app holds the key its
 * server checks (`desktop/src-tauri/src/approval.rs`). A plain browser,
 * even on this computer, cannot, so it shows where to approve instead.
 */
export function canApproveHere(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && os !== 'ios' && os !== 'android'
}

/**
 * Asks the person to confirm (Touch ID or the login password where the Mac
 * has one, the click that got here elsewhere), then returns the app's
 * proof for exactly this change, or `null` when they cancelled.
 */
export async function approvalProof(request: ApprovalAction, reason: string): Promise<string | null> {
  if (!canApproveHere()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  const roles = request.action === 'approve'
    ? { signer: request.signer, server: request.server, client: request.client }
    : { signer: false, server: false, client: false }
  return invoke<string | null>('cloud_approval_proof', { action: request.action, id: request.id, ...roles, reason })
}
