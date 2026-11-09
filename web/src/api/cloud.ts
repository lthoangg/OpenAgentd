/**
 * OpenAgentd Cloud account: the server's optional sign-in, as this computer
 * sees it. Guest is the default; every state here is read from
 * `GET /api/cloud/status`, and the POST routes only work from the computer
 * the server runs on (anyone else gets 403).
 */
import { apiBaseUrl } from './base-url'
import { parseDetailOrThrow } from './client/_shared'

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
  | 'failed'

export type RelayState =
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'paused'; until: number | null }
  | { state: 'offline' }
  /** Not used as a server: this computer runs no connector. */
  | { state: 'off' }

export type CloudStatus =
  | { state: 'guest'; notice: CloudNotice | null }
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

async function cloudCall<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const label = `${method} /cloud${path}`
  const init: RequestInit = body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(`${apiBaseUrl()}/cloud${path}`, init)
  if (!res.ok) await parseDetailOrThrow(res, label)
  return res.json()
}

const cloudRequest = (path: string, method: 'GET' | 'POST', body?: unknown) => cloudCall<CloudStatus>(path, method, body)

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
export const cloudApproveConfirm = (enrollmentId: string, approver: boolean, roles: Roles) =>
  cloudRequest('/approve/confirm', 'POST', { enrollment_id: enrollmentId, signer: approver, ...roles })
export const cloudApproveReject = (enrollmentId: string) =>
  cloudRequest('/approve/reject', 'POST', { enrollment_id: enrollmentId })
export const cloudRemoveDevice = (deviceId: string) => cloudRequest('/devices/remove', 'POST', { device_id: deviceId })
export const cloudLoginCancel = () => cloudRequest('/login/cancel', 'POST')
export const cloudLogout = () => cloudRequest('/logout', 'POST')
