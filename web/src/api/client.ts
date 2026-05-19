/**
 * OpenAgentd API client — team endpoint group: /team.
 *
 * Team flow:
 *   1. postTeamChat(message, sessionId?) → { session_id }
 *   2. teamStream(callbacks, signal) → SSE bus
 */

import { readSSE, type SSECallbacks } from './sse'
import type {
  SessionDetailResponse,
  SessionPageResponse,
  TeamHistoryResponse,
  TeamAgentsResponse,
  WorkspaceValidationResponse,
  WorkspaceBrowseResponse,
  WorkspaceGitDiffResponse,
  WorkspaceStatusResponse,
  TeamStatusResponse,
  WikiTree,
  WikiFile,
  AgentListResponse,
  AgentDetail,
  AgentDeleteResponse,
  RegistryResponse,
  SkillListResponse,
  SkillDetail,
  SkillDeleteResponse,
  CommandListResponse,
  CommandRenderResponse,
  TeamCommandResponse,
  WorkspaceFilesResponse,
  CodingWorkspaceFilesResponse,
  ScheduledTaskResponse,
  ScheduledTaskCreate,
  ScheduledTaskListResponse,
  TodosResponse,
} from './types'

const API = '/api'

// ── /team ─────────────────────────────────────────────────────────────────────

export async function postTeamChat(
  message?: string | null,
  sessionId?: string | null,
  interrupt = false,
  files?: File[],
  mode = 'normal',
  workspace?: string | null,
): Promise<{ status: string; session_id: string }> {
  const formData = new FormData()
  if (message) {
    formData.append('message', message)
  }
  if (sessionId) {
    formData.append('session_id', sessionId)
  }
  if (interrupt) {
    formData.append('interrupt', 'true')
  }
  if (mode !== 'normal') {
    formData.append('mode', mode)
  }
  if (workspace) {
    formData.append('workspace', workspace)
  }
  if (files && files.length > 0) {
    for (const file of files) {
      formData.append('files', file)
    }
  }

  const res = await fetch(`${API}/team/chat`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `POST /team/chat failed: ${res.status}`)
  }
  return res.json()
}

export async function postTeamCommand(
  command: 'continue' | 'compact' | 'undo' | 'redo',
  sessionId: string,
): Promise<TeamCommandResponse> {
  const res = await fetch(`${API}/team/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, session_id: sessionId }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `POST /team/commands failed: ${res.status}`)
  }
  return res.json()
}

export function teamStream(sessionId: string, callbacks: SSECallbacks, signal?: AbortSignal): void {
  fetch(`${API}/team/${encodeURIComponent(sessionId)}/stream`, { signal })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /team/${sessionId}/stream failed: ${res.status}`)
      readSSE(res, callbacks)
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}

export async function listTeamAgents(workspace?: string | null): Promise<TeamAgentsResponse> {
  const params = new URLSearchParams()
  if (workspace) params.set('workspace', workspace)
  const query = params.toString()
  const res = await fetch(`${API}/team/agents${query ? `?${query}` : ''}`)
  if (!res.ok) throw new Error(`listTeamAgents failed: ${res.status}`)
  return res.json()
}

export async function validateWorkspace(workspace: string): Promise<WorkspaceValidationResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${API}/team/workspace/validate?${params}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `validateWorkspace failed: ${res.status}`)
  }
  return res.json()
}

export async function browseWorkspaces(path?: string | null): Promise<WorkspaceBrowseResponse> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  const res = await fetch(`${API}/team/workspace/browse${query ? `?${query}` : ''}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `browseWorkspaces failed: ${res.status}`)
  }
  return res.json()
}

export async function listCodingWorkspaceFiles(workspace: string): Promise<CodingWorkspaceFilesResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${API}/team/workspace/files/list?${params}`)
  if (!res.ok) throw new Error(`listCodingWorkspaceFiles failed: ${res.status}`)
  return res.json()
}

export async function getCodingWorkspaceGitDiff(workspace: string): Promise<WorkspaceGitDiffResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${API}/team/workspace/git-diff/view?${params}`)
  if (!res.ok) throw new Error(`getCodingWorkspaceGitDiff failed: ${res.status}`)
  return res.json()
}

export async function getCodingWorkspaceStatus(workspace: string): Promise<WorkspaceStatusResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${API}/team/workspace/status?${params}`)
  if (!res.ok) throw new Error(`getCodingWorkspaceStatus failed: ${res.status}`)
  return res.json()
}

export async function listTeamSessions(before?: string | null, limit = 20): Promise<SessionPageResponse> {
  const params = new URLSearchParams()
  if (before) params.set('before', before)
  params.set('limit', String(limit))
  const res = await fetch(`${API}/team/sessions?${params}`)
  if (!res.ok) throw new Error(`listTeamSessions failed: ${res.status}`)
  return res.json()
}

export async function getTeamSession(id: string): Promise<SessionDetailResponse> {
  const res = await fetch(`${API}/team/sessions/${id}`)
  if (!res.ok) throw new Error(`getTeamSession failed: ${res.status}`)
  return res.json()
}

export async function deleteTeamSession(id: string): Promise<void> {
  const res = await fetch(`${API}/team/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`deleteTeamSession failed: ${res.status}`)
}

export async function teamHistory(sessionId: string, before?: string): Promise<TeamHistoryResponse> {
  const url = before
    ? `${API}/team/${encodeURIComponent(sessionId)}/history?before=${encodeURIComponent(before)}`
    : `${API}/team/${encodeURIComponent(sessionId)}/history`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`teamHistory failed: ${res.status}`)
  return res.json()
}

/**
 * List every file under the session's agent workspace (``.openagentd/team/{sid}``).
 *
 * Returns an empty list for fresh sessions where the workspace hasn't been
 * created yet (the agent hasn't written anything).  File bytes are fetched
 * via the ``/media/{path}`` proxy, not this endpoint — keep payloads small.
 */
export async function listWorkspaceFiles(sessionId: string): Promise<WorkspaceFilesResponse> {
  const res = await fetch(`${API}/team/${encodeURIComponent(sessionId)}/files`)
  if (!res.ok) throw new Error(`listWorkspaceFiles failed: ${res.status}`)
  return res.json()
}

/** Build the ``/media/{path}`` URL for a workspace file.
 *
 *  Each segment is encoded individually — ``encodeURIComponent`` on the whole
 *  path would escape the ``/`` separators that the ``{path:path}`` route
 *  pattern needs to see.
 */
export function workspaceMediaUrl(sessionId: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${API}/team/${encodeURIComponent(sessionId)}/media/${encoded}`
}

export async function getTodos(sessionId: string): Promise<TodosResponse> {
  const res = await fetch(`${API}/team/sessions/${encodeURIComponent(sessionId)}/todos`)
  if (!res.ok) throw new Error(`getTodos failed: ${res.status}`)
  return res.json()
}

// ── /health ───────────────────────────────────────────────────────────────────

export async function health(): Promise<{ status: string; version: string }> {
  const res = await fetch(`${API}/health/ready`)
  if (!res.ok) throw new Error(`health failed: ${res.status}`)
  return res.json()
}

// ── /observability ────────────────────────────────────────────────────────────

export interface ObservabilitySummary {
  window_start: string
  window_end: string
  sample_ratio: number
  totals: {
    turns: number
    llm_calls: number
    tool_calls: number
    input_tokens: number
    output_tokens: number
    errors: number
  }
  latency_ms: {
    turn_p50: number
    turn_p95: number
    llm_p50: number
    llm_p95: number
  }
  daily_turns: Array<{ day: string; turns: number; errors: number }>
  by_model: Array<{ model: string; calls: number; input_tokens: number; output_tokens: number; p95_ms: number }>
  by_tool: Array<{ tool: string; calls: number; errors: number; p95_ms: number }>
}

export async function getObservabilitySummary(days: number): Promise<ObservabilitySummary> {
  const res = await fetch(`${API}/observability/summary?days=${days}`)
  if (!res.ok) throw new Error(`GET /observability/summary failed: ${res.status}`)
  return res.json()
}

// ── /observability/traces ────────────────────────────────────────────────────

/** One turn in the traces-list view — shape mirrors backend `TraceListItem`. */
export interface TraceListItem {
  trace_id: string
  span_id: string
  run_id: string | null
  session_id: string | null
  agent_name: string | null
  model: string | null
  start_ms: number
  end_ms: number
  duration_ms: number
  input_tokens: number
  output_tokens: number
  llm_calls: number
  tool_calls: number
  error: boolean
}

export interface TracesListResponse {
  traces: TraceListItem[]
  limit: number
  offset: number
}

/** One span inside a trace — shape mirrors backend `SpanDetail`. */
export interface SpanDetail {
  span_id: string
  parent_span_id: string | null
  trace_id: string
  name: string
  kind: string
  start_ms: number
  end_ms: number
  duration_ms: number
  status: string
  attributes: Record<string, unknown>
}

export interface TraceDetailResponse {
  trace_id: string
  spans: SpanDetail[]
}

export async function listTraces(
  days: number,
  limit = 50,
  offset = 0,
): Promise<TracesListResponse> {
  const res = await fetch(
    `${API}/observability/traces?days=${days}&limit=${limit}&offset=${offset}`,
  )
  if (!res.ok) throw new Error(`GET /observability/traces failed: ${res.status}`)
  return res.json()
}

/**
 * Fetch every span for a given trace id.  Returns `null` when the trace
 * was not found (404 — expired by retention or typo).
 */
export async function getTraceDetail(
  traceId: string,
  days = 30,
): Promise<TraceDetailResponse | null> {
  const res = await fetch(
    `${API}/observability/traces/${encodeURIComponent(traceId)}?days=${days}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /observability/traces/:id failed: ${res.status}`)
  return res.json()
}

// ── Compat: team status via /team/agents ─────────────────────────────────────
// HomePage uses this to determine if team mode is available

export async function teamStatus(workspace?: string | null): Promise<TeamStatusResponse | null> {
  const params = new URLSearchParams()
  if (workspace) params.set('workspace', workspace)
  const query = params.toString()
  const res = await fetch(`${API}/team/agents${query ? `?${query}` : ''}`)
  if (res.status === 404) return null
  if (!res.ok) return null
  const data = await res.json()
  // Shape into TeamStatusResponse for compatibility with useTeamStatusQuery
  const agents = data.agents ?? []
  const lead = agents.find((a: { is_lead: boolean }) => a.is_lead) ?? agents[0]
  if (!lead) return null
  return {
    team: 'team',
    lead: { name: lead.name, model: lead.model ?? '', state: 'idle' },
    members: agents
      .filter((a: { is_lead: boolean }) => !a.is_lead)
      .map((a: { name: string; model: string | null }) => ({ name: a.name, model: a.model ?? '', state: 'idle' })),
  }
}

// ── /quote ───────────────────────────────────────────────────────────────────

export async function getQuoteOfTheDay(): Promise<{ quote: string; author: string }> {
  const res = await fetch(`${API}/quote`)
  if (!res.ok) throw new Error(`getQuoteOfTheDay failed: ${res.status}`)
  return res.json()
}

// ── /wiki ─────────────────────────────────────────────────────────────────────

export async function getWikiTree(unprocessedOnly = false): Promise<WikiTree> {
  const url = unprocessedOnly ? `${API}/wiki/tree?unprocessed_only=true` : `${API}/wiki/tree`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET /wiki/tree failed: ${res.status}`)
  return res.json()
}

export async function getWikiFile(path: string): Promise<WikiFile> {
  const res = await fetch(`${API}/wiki/file?path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(`GET /wiki/file failed: ${res.status}`)
  return res.json()
}

export async function putWikiFile(path: string, content: string): Promise<WikiFile> {
  const res = await fetch(`${API}/wiki/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`PUT /wiki/file failed: ${res.status} ${detail}`)
  }
  return res.json()
}

export async function deleteWikiFile(path: string): Promise<void> {
  const res = await fetch(`${API}/wiki/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE /wiki/file failed: ${res.status}`)
}

// ── /dream ────────────────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean
  model: string
  schedule: string
}

export async function getDreamConfig(): Promise<DreamConfig> {
  const res = await fetch(`${API}/dream/config`)
  if (!res.ok) throw new Error(`GET /dream/config failed: ${res.status}`)
  return res.json()
}

export async function putDreamConfig(config: DreamConfig): Promise<DreamConfig> {
  const res = await fetch(`${API}/dream/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`PUT /dream/config failed: ${res.status} ${detail}`)
  }
  return res.json()
}

export async function triggerDreamRun(): Promise<{
  sessions_processed: number
  notes_processed: number
  remaining: number
  failed: number
  skipped?: string
}> {
  const res = await fetch(`${API}/dream/run`, { method: 'POST' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`POST /dream/run failed: ${res.status} ${detail}`)
  }
  return res.json()
}

// ── Agent management errors ──────────────────────────────────────────────────

/**
 * Thrown when a 4xx response carries a FastAPI `detail` string. Callers show
 * `.message` as the inline form error. Keeps type discrimination from
 * generic network errors.
 */
export class ApiValidationError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiValidationError'
  }
}

async function parseDetailOrThrow(res: Response, label: string): Promise<never> {
  let detail = `${label} failed: ${res.status}`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') detail = body.detail
    else if (Array.isArray(body?.detail)) detail = body.detail.map((e: { msg: string }) => e.msg).join('; ')
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new ApiValidationError(res.status, detail)
}

// ── /agents ──────────────────────────────────────────────────────────────────

export async function listAgents(): Promise<AgentListResponse> {
  const res = await fetch(`${API}/agents`)
  if (!res.ok) throw new Error(`listAgents failed: ${res.status}`)
  return res.json()
}

export async function getAgent(name: string): Promise<AgentDetail> {
  const res = await fetch(`${API}/agents/${encodeURIComponent(name)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /agents/${name}`)
  return res.json()
}

export async function createAgent(name: string, content: string): Promise<AgentDetail> {
  const res = await fetch(`${API}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /agents')
  return res.json()
}

export async function updateAgent(name: string, content: string): Promise<AgentDetail> {
  const res = await fetch(`${API}/agents/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /agents/${name}`)
  return res.json()
}

export async function deleteAgent(name: string): Promise<AgentDeleteResponse> {
  const res = await fetch(`${API}/agents/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /agents/${name}`)
  return res.json()
}

export async function getRegistry(): Promise<RegistryResponse> {
  const res = await fetch(`${API}/agents/registry`)
  if (!res.ok) throw new Error(`getRegistry failed: ${res.status}`)
  return res.json()
}

// ── /skills ──────────────────────────────────────────────────────────────────

export async function listSkillFiles(): Promise<SkillListResponse> {
  const res = await fetch(`${API}/skills`)
  if (!res.ok) throw new Error(`listSkills failed: ${res.status}`)
  return res.json()
}

export async function getSkill(name: string): Promise<SkillDetail> {
  const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /skills/${name}`)
  return res.json()
}

export async function createSkill(name: string, content: string): Promise<SkillDetail> {
  const res = await fetch(`${API}/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /skills')
  return res.json()
}

export async function updateSkill(name: string, content: string): Promise<SkillDetail> {
  const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /skills/${name}`)
  return res.json()
}

export async function deleteSkill(name: string): Promise<SkillDeleteResponse> {
  const res = await fetch(`${API}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /skills/${name}`)
  return res.json()
}

// ── /commands ────────────────────────────────────────────────────────────────

export async function listCommands(): Promise<CommandListResponse> {
  const res = await fetch(`${API}/commands`)
  if (!res.ok) throw new Error(`listCommands failed: ${res.status}`)
  return res.json()
}

export async function renderCommand(
  name: string,
  arguments_: string,
): Promise<CommandRenderResponse> {
  // ``name`` may include slashes (nested folders); the segments are
  // already valid URL path chars, so we encode the whole id minus the
  // separator so e.g. ``git/commit`` survives intact.
  const encoded = name.split('/').map(encodeURIComponent).join('/')
  const res = await fetch(`${API}/commands/${encoded}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: arguments_ }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /commands/${name}/render`)
  return res.json()
}

// ── /scheduler/tasks ─────────────────────────────────────────────────────────

export async function listScheduledTasks(): Promise<ScheduledTaskListResponse> {
  const res = await fetch(`${API}/scheduler/tasks`)
  if (!res.ok) throw new Error(`listScheduledTasks failed: ${res.status}`)
  return res.json()
}

export async function createScheduledTask(body: ScheduledTaskCreate): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${API}/scheduler/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /scheduler/tasks')
  return res.json()
}

export async function getScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /scheduler/tasks/${id}`)
  return res.json()
}

export async function updateScheduledTask(id: string, body: Partial<ScheduledTaskCreate>): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /scheduler/tasks/${id}`)
  return res.json()
}

export async function deleteScheduledTask(id: string): Promise<void> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /scheduler/tasks/${id}`)
}

export async function pauseScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/pause`)
  return res.json()
}

export async function resumeScheduledTask(id: string): Promise<ScheduledTaskResponse> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/resume`)
  return res.json()
}

export async function triggerScheduledTask(id: string): Promise<{ status: string }> {
  const res = await fetch(`${API}/scheduler/tasks/${encodeURIComponent(id)}/trigger`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /scheduler/tasks/${id}/trigger`)
  return res.json()
}

// ── /mcp ──────────────────────────────────────────────────────────────────────

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

export async function listMcpServers(): Promise<{ servers: ServerStatus[] }> {
  const res = await fetch(`${API}/mcp/servers`)
  if (!res.ok) throw new Error(`listMcpServers failed: ${res.status}`)
  return res.json()
}

export async function getMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${API}/mcp/servers/${encodeURIComponent(name)}`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /mcp/servers/${name}`)
  return res.json()
}

export async function createMcpServer(name: string, server: ServerBody): Promise<ServerStatus> {
  const res = await fetch(`${API}/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, server }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /mcp/servers')
  return res.json()
}

export async function updateMcpServer(name: string, server: ServerBody): Promise<ServerStatus> {
  const res = await fetch(`${API}/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /mcp/servers/${name}`)
  return res.json()
}

export async function deleteMcpServer(name: string): Promise<ServerDeleteResponse> {
  const res = await fetch(`${API}/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, `DELETE /mcp/servers/${name}`)
  return res.json()
}

export async function restartMcpServer(name: string): Promise<ServerStatus> {
  const res = await fetch(`${API}/mcp/servers/${encodeURIComponent(name)}/restart`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/restart`)
  return res.json()
}

export async function connectMcpOAuth(name: string): Promise<ServerStatus> {
  const res = await fetch(`${API}/mcp/servers/${encodeURIComponent(name)}/oauth/connect`, { method: 'POST' })
  if (!res.ok) await parseDetailOrThrow(res, `POST /mcp/servers/${name}/oauth/connect`)
  return res.json()
}

// ── /settings/sandbox ────────────────────────────────────────────────────────

export type SandboxSettings = { denied_patterns: string[] }

export async function getSandboxSettings(): Promise<SandboxSettings> {
  const res = await fetch(`${API}/settings/sandbox`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/sandbox')
  return res.json()
}

export async function updateSandboxSettings(
  body: SandboxSettings,
): Promise<SandboxSettings> {
  const res = await fetch(`${API}/settings/sandbox`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/sandbox')
  return res.json()
}

export type TitleGenerationSettings = {
  enabled: boolean
  model: string
  wait_timeout_seconds: number
}

export async function getTitleGenerationSettings(): Promise<TitleGenerationSettings> {
  const res = await fetch(`${API}/settings/title-generation`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/title-generation')
  return res.json()
}

export async function updateTitleGenerationSettings(
  body: TitleGenerationSettings,
): Promise<TitleGenerationSettings> {
  const res = await fetch(`${API}/settings/title-generation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/title-generation')
  return res.json()
}

export type MultimodalSectionSettings = {
  model: string
  [key: string]: string | number | boolean | null
}

export type MultimodalSettings = {
  image: MultimodalSectionSettings
  video: MultimodalSectionSettings
}

export async function getMultimodalSettings(): Promise<MultimodalSettings> {
  const res = await fetch(`${API}/settings/multimodal`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/multimodal')
  return res.json()
}

export async function updateMultimodalSettings(
  body: MultimodalSettings,
): Promise<MultimodalSettings> {
  const res = await fetch(`${API}/settings/multimodal`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /settings/multimodal')
  return res.json()
}

// ── /settings/providers ──────────────────────────────────────────────────────

export type ProviderInfo = {
  id: string
  label: string
  description: string
  kind: 'api_key' | 'oauth' | 'local' | 'cloud_creds'
  credentials: Array<{
    name: string
    label: string
    secret: boolean
    required: boolean
    placeholder: string
  }>
  env_var: string
  env_vars: string[]
  fallback_models: string[]
  oauth_command: string
  docs_url: string
  is_configured: boolean
}

export type ProvidersListBody = {
  providers: ProviderInfo[]
  has_any_configured: boolean
}

export type ProviderSaveRequest = {
  api_key?: string
  extra?: Record<string, string>
}

export type ProviderModelsResponse = {
  provider: string
  models: string[]
  source: 'provider' | 'fallback'
}

export type ProviderSaveResponse = {
  saved: boolean
  is_first_provider: boolean
}

export type ProviderTestResponse = {
  ok: boolean
  latency_ms?: number | null
  error?: string | null
}

export type SeedInstallResponse = {
  agents_written: string[]
  skills_written: string[]
  configs_written: string[]
  source: string
}

export type OAuthLoginEvent = {
  event: string
  message?: string
  verification_uri?: string
  user_code?: string
  expires_in?: number
  elapsed_s?: number
  suggested_model?: string
  reason?: string
}

export async function listProviders(): Promise<ProvidersListBody> {
  const res = await fetch(`${API}/settings/providers`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /settings/providers')
  return res.json()
}

export async function saveProvider(
  providerId: string,
  body: ProviderSaveRequest,
): Promise<ProviderSaveResponse> {
  const res = await fetch(`${API}/settings/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `PUT /settings/providers/${providerId}`)
  return res.json()
}

export async function testProvider(
  providerId: string,
  body: { api_key?: string; model: string; extra?: Record<string, string> },
): Promise<ProviderTestResponse> {
  const res = await fetch(`${API}/settings/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/test`)
  return res.json()
}

export async function listProviderModels(
  providerId: string,
  body: { api_key?: string; extra?: Record<string, string> },
): Promise<ProviderModelsResponse> {
  const res = await fetch(`${API}/settings/providers/${encodeURIComponent(providerId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/models`)
  return res.json()
}

export async function installSeed(providerModel: string): Promise<SeedInstallResponse> {
  const res = await fetch(`${API}/settings/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_model: providerModel }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /settings/seed')
  return res.json()
}

export function oauthLoginStream(
  providerId: string,
  callbacks: SSECallbacks & { onOAuthEvent?: (event: OAuthLoginEvent) => void },
  signal?: AbortSignal,
  mode?: 'browser',
): void {
  const query = mode ? `?mode=${encodeURIComponent(mode)}` : ''
  fetch(`${API}/auth/${encodeURIComponent(providerId)}/login${query}`, { signal })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /auth/${providerId}/login failed: ${res.status}`)
      readSSE(res, {
        ...callbacks,
        onEvent: (type, data) => {
          const payload = data as Omit<OAuthLoginEvent, 'event'>
          callbacks.onOAuthEvent?.({ event: type, ...payload })
          callbacks.onEvent(type, data)
        },
      })
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}

export async function submitOAuthCallback(providerId: string, code: string): Promise<{ ok: boolean; suggested_model?: string }> {
  const res = await fetch(`${API}/auth/${encodeURIComponent(providerId)}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /auth/${providerId}/callback`)
  return res.json()
}

// ── /speech ──────────────────────────────────────────────────────────────────

export type SpeechConfig = {
  enabled: boolean
  model: string
  language: string
  max_file_mb: number
}

export async function getSpeechConfig(): Promise<SpeechConfig> {
  const res = await fetch(`${API}/speech/config`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /speech/config')
  return res.json()
}

export async function putSpeechConfig(body: SpeechConfig): Promise<SpeechConfig> {
  const res = await fetch(`${API}/speech/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /speech/config')
  return res.json()
}

export async function postTranscribe(audioBlob: Blob): Promise<{ text: string }> {
  const formData = new FormData()
  formData.append('file', audioBlob, 'recording.webm')
  const res = await fetch(`${API}/speech/transcribe`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /speech/transcribe')
  return res.json()
}
