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
  | 'failed'

export type RelayState =
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'paused'; until: number | null }
  | { state: 'offline' }

export type CloudStatus =
  | { state: 'guest'; notice: CloudNotice | null }
  | { state: 'signing_in'; user_code: string; url: string; fingerprint: string; expires_in: number }
  | { state: 'joining'; fingerprint: string; code: string | null }
  /** Claimed an invitation: the phone adds it once the person compares these. */
  | { state: 'invited'; fingerprint: string; kind: string | null }
  | { state: 'connected'; fingerprint: string; signer: boolean; relay: RelayState; sessions: number }
  | { state: 'closing'; fingerprint: string; deletes_at: number | null }
  | { state: 'unavailable'; fingerprint: string }

async function cloudRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<CloudStatus> {
  const label = `${method} /cloud${path}`
  const init: RequestInit = body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const res = await fetch(`${apiBaseUrl()}/cloud${path}`, init)
  if (!res.ok) await parseDetailOrThrow(res, label)
  return res.json()
}

export const getCloudStatus = () => cloudRequest('/status', 'GET')
export const cloudLogin = () => cloudRequest('/login', 'POST')
/** Joins with the invitation link from the phone. The link works like a password. */
export const cloudJoin = (link: string) => cloudRequest('/join', 'POST', { link })
export const cloudLoginCancel = () => cloudRequest('/login/cancel', 'POST')
export const cloudLogout = () => cloudRequest('/logout', 'POST')
