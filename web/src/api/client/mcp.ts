/**
 * OpenAgentd API client — MCP group: /mcp servers + app tools.
 */

import { apiBaseUrl, apiUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export type StdioServerBody = {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /** Tool-call deadline in seconds (1–270); omitted = server default (210 s). */
  timeout?: number | null
}

export type HttpServerBody = {
  /** `http` is Streamable HTTP (with a legacy fallback); `sse` is the legacy HTTP+SSE transport. */
  transport: 'http' | 'sse'
  url: string
  headers: Record<string, string>
  oauth?: {
    client_id?: string | null
    client_secret?: string | null
  } | null
  enabled: boolean
  /** Tool-call deadline in seconds (1–270); omitted = server default (210 s). */
  timeout?: number | null
}

export type ServerBody = StdioServerBody | HttpServerBody

export type ServerStatus = {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  enabled: boolean
  /** `needs_approval`: a project's server the user has not approved (as its entry is now); it does not run. */
  state: 'stopped' | 'starting' | 'ready' | 'auth_required' | 'error' | 'needs_approval'
  error: string | null
  tool_names: string[]
  started_at: string | null
  /** Saved config from mcp.json. Null when the server was removed mid-flight. */
  config: ServerBody | null
  /**
   * The plugin bundle this server comes from (its name then reads
   * `<bundle>/<server>`). Absent or null for servers saved in mcp.json. A plugin
   * server is read-only here: the bundle owns its config.
   */
  plugin?: string | null
  /**
   * The project that ships this server in its `.agents/mcp.json`: its
   * workspace, and its name there (`name` is then its key,
   * `<name>@<workspace hash>`). Read-only here: the project's file owns it,
   * and it runs once approved.
   */
  project?: { workspace: string; name: string } | null
  /** It holds a sign-in from its service (what Sign out forgets). */
  signed_in?: boolean
  /** The gallery connector it is, by its address: the service's name and logo. */
  gallery?: { id: string; name: string; icon: ConnectorIconData | null } | null
}

/** A connector's logo: one SVG path, drawn in the text colour. */
export type ConnectorIconData = { path: string; view_box: string }

export type McpServerList = {
  servers: ServerStatus[]
  /** Why the workspace's `.agents/mcp.json` could not be used (with `workspace` only). */
  project_error?: string | null
}

export type ServerDeleteResponse = { name: string }
export type MCPAppToolCallRequest = {
  session_id: string
  tool_call_id: string
  server: string
  tool: string
  arguments: Record<string, unknown>
}
export type MCPAppToolCallResponse = { result: unknown }

/** The user's and plugins' servers; with `workspace`, its project's servers too. */
export async function listMcpServers(workspace?: string | null): Promise<McpServerList> {
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  const res = await fetch(`${apiBaseUrl()}/mcp/servers${query}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listMcpServers')
  return res.json()
}

/** Approve a project's server (by its key) as its entry is now, and start it. */
export async function approveMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/approve`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/approve`)
  return res.json()
}

/** Withdraw the approval of a project's server (by its key): it stops. */
export async function revokeMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/revoke`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/revoke`)
  return res.json()
}

export async function getMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /mcp/servers/${name}`)
  return res.json()
}

export async function createMcpServer(name: string, server: ServerBody): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, server }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/servers')
  return res.json()
}

export async function updateMcpServer(name: string, server: ServerBody): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /mcp/servers/${name}`)
  return res.json()
}

export async function deleteMcpServer(name: string): Promise<ServerDeleteResponse> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /mcp/servers/${name}`)
  return res.json()
}

export async function restartMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/restart`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/restart`)
  return res.json()
}

/**
 * A sign-in the client drives. `sign_in`: open `auth_url` for the user; the
 * code comes back to the server's localhost listener (`loopback`, a browser
 * on the server's machine) or through the relay page to `return_to`
 * (`relay`). `done`: the server connected without asking.
 */
export type McpSignInStart =
  | { status: 'sign_in'; auth_url: string; return: 'loopback' | 'relay' }
  | { status: 'done'; server: ServerStatus }

export type McpSignInStatus =
  | { status: 'none' | 'waiting' }
  | { status: 'done'; server: ServerStatus }
  | { status: 'failed'; error: string }

export async function startMcpSignIn(name: string, returnTo: string): Promise<McpSignInStart> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_to: returnTo }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/oauth/start`)
  return res.json()
}

export async function getMcpSignInStatus(name: string): Promise<McpSignInStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/oauth/status`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /mcp/servers/${name}/oauth/status`)
  return res.json()
}

/** The code the relay page or a pasted address brought back. */
export type McpSignInCode = { code: string; state: string; iss?: string | null } | { url: string }

export async function finishMcpSignIn(body: McpSignInCode): Promise<{ status: 'done' | 'waiting'; name: string; server?: ServerStatus }> {
  const res = await fetch(`${apiBaseUrl()}/mcp/oauth/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/oauth/finish')
  return res.json()
}

export async function cancelMcpSignIn(name: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/oauth/cancel`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/oauth/cancel`)
}

/** Forget the server's sign-in; the connector stays. */
export async function signOutMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/oauth/sign-out`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/oauth/sign-out`)
  return res.json()
}

/** How a gallery connector signs in: not at all, at the service, or with a pasted key. */
export type GalleryAuth =
  | 'none'
  | 'oauth'
  | { header: string; template: string; key_url?: string | null; key_label?: string | null }

export interface GalleryEntry {
  type: 'connector'
  id: string
  name: string
  description: string
  category: string
  url: string
  auth: GalleryAuth
  /** The service's logo; without one the app shows a monogram. */
  icon?: ConnectorIconData | null
  /** The connector already added for this address, if any. */
  server: ServerStatus | null
  /** A connector still on an old address of this one: offer the update. */
  update_for: string | null
}

export interface ConnectorGallery {
  /** `cloud`: fetched now; `cache`: an earlier fetch; `bundled`: the app's own copy. */
  source: 'cloud' | 'cache' | 'bundled'
  entries: GalleryEntry[]
}

export async function getConnectorGallery(refresh = false): Promise<ConnectorGallery> {
  const res = await fetch(`${apiBaseUrl()}/mcp/gallery${refresh ? '?refresh=1' : ''}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /mcp/gallery')
  return res.json()
}

/** Turn a gallery connector on: adds it (with `key` for a key connector) or switches the existing one on. */
export async function enableGalleryConnector(id: string, key?: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/gallery/${encodeURIComponent(id)}/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(key ? { key } : {}),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/gallery/${id}/enable`)
  return res.json()
}

/** Move the connector on an old address of `id` to its new one. */
export async function updateGalleryConnector(id: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/gallery/${encodeURIComponent(id)}/update`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/gallery/${id}/update`)
  return res.json()
}

export async function callMcpAppTool(body: MCPAppToolCallRequest): Promise<MCPAppToolCallResponse> {
  const res = await fetch(`${apiBaseUrl()}/mcp/app-tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/app-tools/call')
  return res.json()
}

/** The stored tool result an app's panel belongs to. */
export interface MCPAppBinding {
  session_id: string
  tool_call_id: string
}

/**
 * A single-use address for an app's page. The frame loads it without the
 * access key, so the address must not go through `withTokenParam`: the app
 * can read its own address. `head` is put first in the page's `<head>`.
 */
export async function issueMcpAppFrameUrl(body: MCPAppBinding & { head: string }): Promise<string> {
  const res = await fetch(`${apiBaseUrl()}/mcp/app-frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/app-frames')
  const { ticket } = (await res.json()) as { ticket: string }
  return apiUrl(`/mcp/app-frames/${encodeURIComponent(ticket)}`)
}

/** What an app's panel reports for the model; it goes with the next message. */
export async function updateMcpAppModelContext(
  body: MCPAppBinding & { content?: unknown[]; structuredContent?: Record<string, unknown> },
): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/mcp/app-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/app-context')
}

/** What an app did to its `localStorage`, applied as clear, remove, set. The
 * backend keeps it for the app's MCP server and hands it back to its pages. */
export async function updateMcpAppStorage(
  body: MCPAppBinding & { clear?: boolean; remove?: string[]; set?: Record<string, string> },
): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/mcp/app-storage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/app-storage')
}
