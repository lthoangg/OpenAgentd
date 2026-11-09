/**
 * The small part of the phone's account (`api/phone-cloud.ts`) that the
 * startup path needs: whether this shell holds an account, its status, and
 * the quiet push registration. The rest loads with the screens that use it.
 */
import { getPlatform } from '@/hooks/use-platform'
import type { AppBackendStatus } from '@/lib/app-backend'

export type PhoneNotice =
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'deleted'
  | 'join_ended'
  | 'commit_mismatch'
  | 'confirm_mismatch'
  | 'invite_invalid'
  | 'signed_out'
  | 'failed'

export type PhoneCloudStatus =
  /** `supported: false` (Android for now): hide every account control. */
  | { state: 'guest'; notice: PhoneNotice | null; supported: boolean }
  | { state: 'signing_in'; user_code: string; url: string; fingerprint: string; expires_in: number }
  /** A new account: the code is shown once, then groups `check` (1-based) are asked back. */
  | { state: 'recovery'; code: string; check: [number, number] }
  | { state: 'joining'; fingerprint: string; code: string | null }
  /** Claimed an invitation: the other phone adds this one once the person compares these. */
  | { state: 'invited'; fingerprint: string; kind: string | null }
  | { state: 'connected'; fingerprint: string; signer: boolean }
  | { state: 'closing'; fingerprint: string; deletes_at: number | null }
  | { state: 'unavailable'; fingerprint: string }

export interface OpenedComputer {
  status: AppBackendStatus
  via: 'lan' | 'account'
}

/** The iOS and Android apps: the only shells that hold a phone account. */
export function isPhoneCloudShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

/** Tauri rejects with a bare string; callers want an `Error` with that message. */
export async function phoneCloudCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export const getPhoneCloudStatus = () => phoneCloudCall<PhoneCloudStatus>('cloud_status')
/** Silently hands the APNs token to the account; never asks for permission. */
export const phoneCloudPushRegister = () => phoneCloudCall<unknown>('cloud_push_register', { prompt: false })
