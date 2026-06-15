/**
 * OpenAgentd API client — MCP group: /mcp servers + app tools.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'

export type StdioServerBody = {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

export type HttpServerBody = {
  transport: 'http'
  url: string
  headers: Record<string, string>
  oauth?: {
    client_id?: string | null
    client_secret?: string | null
  } | null
  enabled: boolean
}

export type ServerBody = StdioServerBody | HttpServerBody

export type ServerStatus = {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  state: 'stopped' | 'starting' | 'ready' | 'auth_required' | 'error'
  error: string | null
  tool_names: string[]
  started_at: string | null
  /** Saved config from mcp.json. Null when the server was removed mid-flight. */
  config: ServerBody | null
}

export type CreateServerRequest = { name: string; server: ServerBody }
export type UpdateServerRequest = { server: ServerBody }
export type ServerDeleteResponse = { name: string }
export type MCPAppToolCallRequest = {
  session_id: string
  tool_call_id: string
  server: string
  tool: string
  arguments: Record<string, unknown>
}
export type MCPAppToolCallResponse = { result: unknown }

export async function listMcpServers(): Promise<{ servers: ServerStatus[] }> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers`)
  if (!res.ok) await parseDetailOrThrow(res, 'listMcpServers')
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

export async function connectMcpOAuth(name: string): Promise<ServerStatus> {
  const res = await fetch(`${apiBaseUrl()}/mcp/servers/${encodeURIComponent(name)}/oauth/connect`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/oauth/connect`)
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
