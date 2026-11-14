/**
 * What the connected server's computer is called (v3; `capabilities`
 * includes "api.server_name"): its host name until someone names it. Text a
 * computer says about itself, at most 40 characters on one line.
 */
import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export interface ServerName {
  /** The name in use; null only when the computer has no host name either. */
  name: string | null
  /** The host name it goes back to when the name is cleared. */
  default: string | null
  /** Someone named it. */
  custom: boolean
}

export async function getServerName(signal?: AbortSignal): Promise<ServerName> {
  const res = await fetch(`${apiBaseUrl()}/server/name`, { signal })
  if (!res.ok) await parseDetailOrThrow(res, 'GET /server/name')
  return res.json()
}

/** An empty name gives the computer its host name back. */
export async function setServerName(name: string): Promise<ServerName> {
  const res = await fetch(`${apiBaseUrl()}/server/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /server/name')
  return res.json()
}
