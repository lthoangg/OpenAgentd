/**
 * OpenAgentd API client — misc endpoints: health, agent status, URL helpers.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'
import { listSessionAgents } from './agent'
import type {
  AgentRegistryResponse,
  AgentStatusResponse,
} from '../types'

export interface HealthResponse {
  status: string
  version: string
  /** Optional server features (v3). Absent on v2, which has none of them. */
  capabilities?: string[]
}

export async function health(): Promise<HealthResponse> {
  const res = await fetch(`${apiBaseUrl()}/health/ready`)
  if (!res.ok) await parseDetailOrThrow(res, 'health')
  return res.json()
}

// ── Plugins (v3 only: `capabilities` includes "api.plugins") ────────────────

export interface PluginStatus {
  name: string
  file: string
  path: string
  status: 'loaded' | 'error'
  /** Provider id when the file registers a model provider. */
  provider: string | null
  /** Tool hooks the file registers (`tool.before`, `tool.after`). */
  hooks: string[]
  errors: string[]
}

export interface PluginsResponse {
  dirs: string[]
  plugins: PluginStatus[]
  /** v2 `*.py` plugins with no `*.ts`/`*.js` port — v3 does not run them. */
  unported: { name: string; file: string; path: string }[]
  /** Plugin bundles (folders with a manifest). Absent on servers that predate them: read as none. */
  bundles?: PluginBundle[]
}

/**
 * Where a bundle is in its life. `failed` and `blocked` give their reason in
 * `errors`; `disabled` is the bundle's own switch being off.
 */
export type PluginBundleState = 'running' | 'failed' | 'blocked' | 'stopped' | 'pending' | 'disabled'

export interface PluginBundleSkill {
  /** `<bundle>/<skill>`. */
  name: string
  description: string
}

export interface PluginBundleMcpServer {
  /** `<bundle>/<server>`: the name Settings → MCP lists it under. */
  name: string
  transport: 'stdio' | 'http'
  /** stdio: the program to run. Null for http. */
  command: string | null
  /** stdio: its arguments. Empty for http. */
  args: string[]
  /** http: the address. Null for stdio. */
  url: string | null
}

export interface PluginBundleTool {
  /** `<bundle>/<tool>`; the agent calls it with the `mcp` tool (server `<bundle>`, tool `<tool>`). */
  name: string
  description: string
  /** The tool only reads; it changes nothing. */
  read_only: boolean
}

/** What a bundle's code may do beyond reading its own files and writing its data folder. */
export interface PluginBundlePermissions {
  /** Hosts it may reach (`*.example.com` includes subdomains), `true` for any host, `false` for none. */
  net: string[] | boolean
  /** May open a local listening port. */
  listen: boolean
  /** More folders it may read and write. */
  fs: string[]
  /** Commands it may run, by bare name. */
  subprocess: string[]
  /** Names of the environment variables it may read. */
  env: string[]
}

/** A plugin bundle: a folder with a manifest that adds skills, MCP servers and tools. */
export interface PluginBundle {
  name: string
  version: string | null
  description: string | null
  /** The bundle's folder. */
  path: string
  enabled: boolean
  state: PluginBundleState
  /** Why it failed to load or start. */
  errors: string[]
  /** Problems that did not stop it. */
  warnings: string[]
  skills: PluginBundleSkill[]
  mcp_servers: PluginBundleMcpServer[]
  tools: PluginBundleTool[]
  /** Null when the bundle has no code. */
  permissions: PluginBundlePermissions | null
  has_code: boolean
}

export async function listPlugins(): Promise<PluginsResponse> {
  const res = await fetch(`${apiBaseUrl()}/plugins`)
  if (!res.ok) await parseDetailOrThrow(res, 'listPlugins')
  return res.json()
}

/**
 * Rescans the plugin folders and restarts the bundles that changed. Answers with
 * the list, as `listPlugins` does. Single-file plugins still load only at start.
 */
export async function reloadPlugins(): Promise<PluginsResponse> {
  const res = await fetch(`${apiBaseUrl()}/plugins/reload`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, 'reloadPlugins')
  return res.json()
}

/** Turns a bundle on or off. Answers with the bundle as it is now. */
export async function setPluginBundleEnabled(name: string, enabled: boolean): Promise<PluginBundle> {
  const res = await fetch(`${apiBaseUrl()}/plugins/bundles/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /plugins/bundles/${name}`)
  return res.json()
}

// ── Agent status derived from /agent/agents ─────────────────────────────────
//
// There is no separate status endpoint: this is a projection of
// `GET /agent/agents`. It goes through `listSessionAgents` rather than fetching
// directly so the session store's call shares one round trip with the header's
// TanStack query (see the coalescing note in `client/agent.ts`).
//
// `/agent/agents` carries no per-agent run state, so `state` is always 'idle'
// here; live working/idle transitions come from the SSE `agent_status` events.

export function shapeAgentStatus(data: AgentRegistryResponse): AgentStatusResponse | null {
  const agents = data.agents ?? []
  const agent = agents[0]
  if (!agent) return null
  return {
    lead: { name: agent.name, model: agent.model ?? '', state: 'idle' },
    members: [],
  }
}

export async function agentStatus(workspace?: string | null, sessionId?: string | null): Promise<AgentStatusResponse | null> {
  if (!workspace) return null
  try {
    return shapeAgentStatus(await listSessionAgents(workspace, sessionId))
  } catch {
    // Soft failure: callers treat null as "agent mode unavailable".
    return null
  }
}
