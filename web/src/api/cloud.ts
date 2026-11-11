/**
 * OpenAgentd Cloud account: the server's optional sign-in, as this computer
 * sees it. Guest is the default; every state here is read from
 * `GET /api/cloud/status`, and the POST routes only work from the computer
 * the server runs on (anyone else gets 403).
 */
import { apiBaseUrl } from './base-url'
import { parseDetailOrThrow } from './client/_shared'
import type { InvitePoll } from './phone-cloud'

export type CloudNotice =
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'deleted'
  | 'join_ended'
  | 'commit_mismatch'
  | 'confirm_mismatch'
  | 'invite_invalid'
  | 'signed_out'
  | 'empty_account'
  | 'roles'
  | 'rate_limited'
  | 'too_many_pending'
  | 'device_limit'
  | 'device_exists'
  | 'account_closing'
  | 'account_unavailable'
  | 'unreachable'
  | 'failed'

export type RelayState =
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'paused'; until: number | null }
  /** Another copy of this computer (the same account keys) took the relay connection over. */
  | { state: 'taken_over' }
  | { state: 'offline' }
  /** Not used as a server: this computer runs no connector. */
  | { state: 'off' }

export type CloudStatus =
  /** `retry_after`: seconds to wait, with `rate_limited`. */
  | { state: 'guest'; notice: CloudNotice | null; retry_after?: number }
  | { state: 'signing_in'; user_code: string; url: string; fingerprint: string; expires_in: number }
  /** A new account: the recovery code is shown once, then groups `check` (1-based) are asked back. */
  | { state: 'recovery'; code?: string; check?: [number, number] }
  | { state: 'joining'; fingerprint: string; code: string | null }
  /** Claimed an invitation: the phone adds it once the person compares these. */
  | { state: 'invited'; fingerprint: string; kind: string | null }
  | {
      state: 'connected'
      fingerprint: string
      signer: boolean
      /** Its roles in the account; absent from an older server. */
      server?: boolean
      client?: boolean
      relay: RelayState
      sessions: number
    }
  | { state: 'closing'; fingerprint: string; deletes_at: number | null }
  | { state: 'unavailable'; fingerprint: string }

/** What a device is used as: it serves sessions, opens them, or both. */
export interface Roles {
  server: boolean
  client: boolean
}

/** One device of the account, from this computer's verified roster. */
export interface CloudDevice {
  device_id: string
  fingerprint: string
  signer: boolean
  server: boolean
  client: boolean
  me: boolean
  kind: string | null
}

/** A device asking to join, with the roles it asked for. */
export interface CloudPending {
  enrollment_id: string
  fingerprint: string
  country: string | null
  created_at: number | null
  expires_at: number | null
  kind: string | null
  server: boolean
  client: boolean
}

/** Both codes are known: what the approval sheet compares. */
export interface ApprovalView {
  code: string
  /** The roles it asked for: the approver may turn one off, never on. */
  server: boolean
  client: boolean
}

async function cloudCall<T>(path: string, method: 'GET' | 'POST', body?: unknown, proof?: string): Promise<T> {
  const label = `${method} /cloud${path}`
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (proof) headers[APPROVAL_HEADER] = proof
  const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) }
  const res = await fetch(`${apiBaseUrl()}/cloud${path}`, init)
  if (!res.ok) await parseDetailOrThrow(res, label)
  return res.json()
}

const cloudRequest = (path: string, method: 'GET' | 'POST', body?: unknown, proof?: string) =>
  cloudCall<CloudStatus>(path, method, body, proof)

/**
 * The desktop app's proof that the person approved a roster change
 * (`desktop/src-tauri/src/approval.rs`): this server refuses to add or
 * remove a device without it, so an agent's shell cannot.
 */
export const APPROVAL_HEADER = 'X-Agentd-Approval'
/** What the server says without the proof; shown as is where there is no app to give one. */
export const APPROVE_ELSEWHERE = 'Approve in the OpenAgentd app on this computer, or run agentd cloud approve in Terminal.'
export const REMOVE_ELSEWHERE = 'Remove devices in the OpenAgentd app on this computer.'

export const getCloudStatus = () => cloudRequest('/status', 'GET')
/** Signs in asking for `roles`; on an empty account this computer creates it. */
export const cloudLogin = (roles: Roles) => cloudRequest('/login', 'POST', roles)
/** Joins with an invitation link from another device. The link works like a password. */
export const cloudJoin = (link: string, roles: Roles) => cloudRequest('/join', 'POST', { link, ...roles })
/** Two groups of the recovery code typed back: creates the account. */
export const cloudConfirmRecovery = (first: string, second: string) => cloudRequest('/recovery', 'POST', { first, second })
export const getCloudDevices = () => cloudCall<CloudDevice[]>('/devices', 'GET')
export const getCloudPending = () => cloudCall<CloudPending[]>('/pending', 'GET')
/** Waits (up to 3 minutes) until both screens can show the code. */
export const cloudApproveBegin = (enrollmentId: string) =>
  cloudCall<ApprovalView>('/approve/begin', 'POST', { enrollment_id: enrollmentId })
export const cloudApproveConfirm = (enrollmentId: string, approver: boolean, roles: Roles, proof: string) =>
  cloudRequest('/approve/confirm', 'POST', { enrollment_id: enrollmentId, signer: approver, ...roles }, proof)
export const cloudApproveReject = (enrollmentId: string) =>
  cloudRequest('/approve/reject', 'POST', { enrollment_id: enrollmentId })
export const cloudRemoveDevice = (deviceId: string, proof: string) =>
  cloudRequest('/devices/remove', 'POST', { device_id: deviceId }, proof)
export const cloudLoginCancel = () => cloudRequest('/login/cancel', 'POST')
export const cloudLogout = () => cloudRequest('/logout', 'POST')

/** An open invitation this computer shows. `link` is a bearer secret: [REDACTED] QR code's content. */
export interface CloudInviteView {
  link: string
  slot_id: string
  expires_at: number
}

/** Both need the desktop app's proof (`invite`): an agent's shell gets no link. */
export const cloudInviteStart = (proof: string) => cloudCall<CloudInviteView>('/invite/start', 'POST', undefined, proof)
export const cloudInvitePoll = (slotId: string, proof: string) =>
  cloudCall<InvitePoll>('/invite/poll', 'POST', { slot_id: slotId }, proof)
/** Adds the candidate the person checked; the same proof as `approve/confirm`. */
export const cloudInviteAdd = (enrollmentId: string, approver: boolean, roles: Roles, proof: string) =>
  cloudRequest('/invite/add', 'POST', { enrollment_id: enrollmentId, signer: approver, ...roles }, proof)
export const cloudInviteCancel = () => cloudRequest('/invite/cancel', 'POST')
/** What the server says to an invitation without the app's proof. */
export const INVITE_ELSEWHERE = 'Show invitations in the OpenAgentd app on this computer.'
