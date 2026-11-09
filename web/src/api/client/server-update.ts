/**
 * The server's self-update API (v3; `capabilities` includes
 * "api.server_update"). Only a server `agentd server start` launched can
 * update itself; any other reports why not in `reason`.
 */
import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export type ServerUpdateBlocker = 'desktop_sidecar' | 'foreground' | 'unsupported_platform'

/** The last update a server started, as the helper recorded it. */
export interface ServerUpdateRun {
  state: 'running' | 'finished'
  ok?: boolean
  from?: string
  to?: string | null
  message?: string
  started_at?: string
  finished_at?: string
}

export interface ServerUpdateStatus {
  current: string
  /** Null when the release feed could not be read (`check_error`). */
  latest: string | null
  available: boolean
  can_upgrade: boolean
  method: 'release' | 'brew' | null
  reason: ServerUpdateBlocker | null
  check_error: string | null
  in_progress: boolean
  release_url: string | null
  /** The update log's path on the server. */
  log: string
  last: ServerUpdateRun | null
}

export interface ServerUpdateStarted {
  status: 'started'
  from: string
  target: string
  started_at: string
}

export async function getServerUpdate(refresh = false, signal?: AbortSignal): Promise<ServerUpdateStatus> {
  const res = await fetch(`${apiBaseUrl()}/server/update${refresh ? '?refresh=true' : ''}`, { signal })
  if (!res.ok) await parseDetailOrThrow(res, 'GET /server/update')
  return res.json()
}

export async function startServerUpdate(): Promise<ServerUpdateStarted> {
  const res = await fetch(`${apiBaseUrl()}/server/update`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /server/update')
  return res.json()
}
