/**
 * The phone's own OpenAgentd Cloud account. Unlike `api/cloud.ts` (a server's
 * account, over `/api/cloud`), this one belongs to the phone and lives in the
 * app shell: every call is a Tauri command (`mobile/src-tauri/src/cloud.rs`).
 * Guest is the default; nothing here may block a guest.
 */
import {
  phoneCloudCall as call,
  type OpenedComputer,
  type PhoneCloudStatus,
} from './phone-cloud-core'

export {
  getPhoneCloudStatus,
  isPhoneCloudShell,
  phoneCloudPushRegister,
  type OpenedComputer,
  type PhoneCloudStatus,
  type PhoneNotice,
} from './phone-cloud-core'

export interface DeviceRow {
  device_id: string
  fingerprint: string
  signer: boolean
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

export const phoneCloudSignIn = () => call<PhoneCloudStatus>('cloud_sign_in')
/** Joins with an invitation (scanned or pasted). The link works like a password. */
export const phoneCloudJoinInvite = (link: string) => call<PhoneCloudStatus>('cloud_join_invite', { link })
export const phoneCloudCancel = () => call<PhoneCloudStatus>('cloud_cancel')
export const phoneCloudConfirmRecovery = (first: string, second: string) =>
  call<PhoneCloudStatus>('cloud_confirm_recovery', { first, second })
export const getPhoneCloudDevices = () => call<DeviceRow[]>('cloud_devices')
export const getPhoneCloudPending = () => call<PendingRow[]>('cloud_pending')
/** The six digits both screens show; may take minutes while the other device reveals. */
export const phoneCloudApproveBegin = (enrollmentId: string) => call<string>('cloud_approve_begin', { enrollmentId })
/** Face ID happens natively. `approver`: the new device may approve others too. */
export const phoneCloudApproveConfirm = (enrollmentId: string, approver: boolean) =>
  call<PhoneCloudStatus>('cloud_approve_confirm', { enrollmentId, approver })
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
