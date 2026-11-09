/**
 * The phone's own OpenAgentd Cloud account. Unlike `api/cloud.ts` (a server's
 * account, over `/api/cloud`), this one belongs to the phone and lives in the
 * app shell: every call is a Tauri command (`mobile/src-tauri/src/cloud.rs`).
 * Guest is the default; nothing here may block a guest.
 */
import type { ApprovalView, Roles } from '@/api/cloud'
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

export interface DeviceRow {
  device_id: string
  fingerprint: string
  signer: boolean
  /** Other devices open sessions on it (absent from an older shell: read as by kind). */
  server?: boolean
  /** It opens sessions on the account's servers. */
  client?: boolean
  me: boolean
  kind: string | null
}

export interface PendingRow {
  enrollment_id: string
  fingerprint: string
  country: string | null
  created_at: number | null
  expires_at: number | null
  /** The joining device's self-reported kind; absent from older shells. */
  kind?: string | null
  /** The roles it asked for. */
  server?: boolean
  client?: boolean
}

export interface OpenedComputer {
  status: AppBackendStatus
  via: 'lan' | 'account'
}

const KIND_LABELS: Record<string, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  ios: 'iOS',
  android: 'Android',
}

/** "macOS" for `macos`; null when the account does not say or names a kind
 *  outside the API's set (it is self-reported, so free text is never shown). */
export function deviceKindLabel(kind: string | null | undefined): string | null {
  if (!kind) return null
  return Object.hasOwn(KIND_LABELS, kind) ? KIND_LABELS[kind] : null
}

/** "macOS · 3F9A 21C4": what a device is called in lists. */
export function deviceLabel(device: Pick<DeviceRow, 'kind' | 'fingerprint'>): string {
  return [deviceKindLabel(device.kind), device.fingerprint].filter(Boolean).join(' · ')
}

/** "just now", "1 min ago", "3 h ago", "2 d ago". Cloud times may be seconds or milliseconds. */
export function ageText(at: number | null | undefined, now: number = Date.now()): string | null {
  if (at === null || at === undefined) return null
  const ms = at < 1e11 ? at * 1000 : at
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** "Linux · 9C02 E1B7 · VN · 1 min ago": a request, as the person sees it. */
export function pendingLabel(row: PendingRow, now?: number): string {
  return [deviceKindLabel(row.kind), row.fingerprint, row.country, ageText(row.created_at, now)].filter(Boolean).join(' · ')
}

/** The iOS and Android apps: the only shells that hold a phone account. */
export function isPhoneCloudShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

/** Tauri rejects with a bare string; callers want an `Error` with that message. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export const getPhoneCloudStatus = () => call<PhoneCloudStatus>('cloud_status')
export const phoneCloudSignIn = () => call<PhoneCloudStatus>('cloud_sign_in')
/** Joins with an invitation (scanned or pasted). The link works like a password. */
export const phoneCloudJoinInvite = (link: string) => call<PhoneCloudStatus>('cloud_join_invite', { link })
export const phoneCloudCancel = () => call<PhoneCloudStatus>('cloud_cancel')
export const phoneCloudConfirmRecovery = (first: string, second: string) =>
  call<PhoneCloudStatus>('cloud_confirm_recovery', { first, second })
export const getPhoneCloudDevices = () => call<DeviceRow[]>('cloud_devices')
export const getPhoneCloudPending = () => call<PendingRow[]>('cloud_pending')
/** Whether a device of the account serves sessions: its roster role, or (older shells) not a phone. */
export function isServer(device: DeviceRow): boolean {
  if (device.server !== undefined) return device.server
  return device.kind !== 'ios' && device.kind !== 'android'
}

/** The six digits both screens show, and the roles asked for; may take minutes while the other device reveals. */
export const phoneCloudApproveBegin = (enrollmentId: string) => call<ApprovalView>('cloud_approve_begin', { enrollmentId })
/** Face ID happens natively. `approver`: the new device may approve others too. `roles`: those it asked for, or fewer. */
export const phoneCloudApproveConfirm = (enrollmentId: string, approver: boolean, roles: Roles) =>
  call<PhoneCloudStatus>('cloud_approve_confirm', { enrollmentId, approver, server: roles.server, client: roles.client })
export const phoneCloudApproveReject = (enrollmentId: string) => call<void>('cloud_approve_reject', { enrollmentId })
/** An open invitation. `link` is a bearer secret: the QR code's content. */
export interface InviteView {
  link: string
  expires_at: number
}

export interface InviteCandidate {
  enrollment_id: string
  fingerprint: string
  kind: string | null
}

export type InvitePoll =
  | { state: 'waiting' }
  /** The one device whose proof checks out; added only when the person taps Add. */
  | { state: 'candidate'; candidate: InviteCandidate }
  /** Two devices proved the secret: nobody was added and the invitation was cancelled. */
  | { state: 'compromised' }
  | { state: 'ended' }

export const phoneCloudInviteStart = () => call<InviteView>('cloud_invite_start')
export const phoneCloudInvitePoll = () => call<InvitePoll>('cloud_invite_poll')
/** Face ID happens natively. */
export const phoneCloudInviteAdd = (enrollmentId: string) => call<PhoneCloudStatus>('cloud_invite_add', { enrollmentId })
export const phoneCloudInviteCancel = () => call<void>('cloud_invite_cancel')
export const phoneCloudRemoveDevice = (deviceId: string) => call<PhoneCloudStatus>('cloud_remove_device', { deviceId })
export const phoneCloudSignOut = () => call<PhoneCloudStatus>('cloud_sign_out')
export const openPhoneCloudComputer = (deviceId: string, lanBaseUrl: string | null) =>
  call<OpenedComputer>('cloud_open_computer', { deviceId, lanBaseUrl })
/** Silently hands the APNs token to the account; never asks for permission. */
export const phoneCloudPushRegister = () => call<unknown>('cloud_push_register', { prompt: false })
/** `"approval"` once after the person tapped "A device wants to join your account". */
export const phoneCloudTakeNotification = () => call<'approval' | null>('cloud_take_notification')
