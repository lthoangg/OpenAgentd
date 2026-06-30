/**
 * OpenAgentd API client — team group: /team chat, sessions, workspace, files.
 */

import { apiBaseUrl, apiUrl } from '../base-url'
import { withTokenParam } from '../auth'
import { readSSE } from '../sse'
import type { SSECallbacks } from '../sse'
import { parseDetailOrThrow } from './_shared'
import type {
  SessionDetailResponse,
  TeamSessionResolveResponse,
  SessionPageResponse,
  SessionResponse,
  TeamHistoryResponse,
  TeamAgentsResponse,
  WorkspaceValidationResponse,
  WorktreeCreateResponse,
  WorktreeInfo,
  CodingWorkspaceTreeResponse,
  WorkspaceBrowseResponse,
  WorkspaceGitDiffResponse,
  WorkspaceStatusResponse,
  WorkspaceGitHistoryResponse,
  WorkspaceCommitDiffResponse,
  TeamCommandResponse,
  WorkspaceFilesResponse,
  CodingWorkspaceFilesResponse,
  TodosResponse,
  TeamChatResponse,
  DiscardWorkspaceFileResponse,
  CodingWorkspaceVisibilityResponse,
  WorktreeRemoveResponse,
  GitUndoResponse,
  GitRevertResponse,
} from '../types'

export async function postTeamChat(
  message?: string | null,
  sessionId?: string | null,
  interrupt = false,
  files?: File[],
  mode = 'normal',
  workspace?: string | null,
  model?: string | null,
  thinkingLevel?: string | null,
  shell = false,
  fastMode = false,
  mentions?: string[],
): Promise<TeamChatResponse> {
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
  if (model !== undefined) {
    formData.append('model', model ?? '')
  }
  if (thinkingLevel !== undefined) {
    formData.append('thinking_level', thinkingLevel ?? '')
  }
  if (fastMode) {
    formData.append('fast_mode', 'true')
  }
  if (shell) {
    formData.append('shell', 'true')
  }
  if (mentions && mentions.length > 0) {
    formData.append('mentions', JSON.stringify(mentions))
  }
  if (files && files.length > 0) {
    for (const file of files) {
      formData.append('files', file)
    }
  }

  const res = await fetch(`${apiBaseUrl()}/team/chat`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: formData,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = Array.isArray(body?.detail)
      ? body.detail.map((item: { msg?: string }) => item.msg).filter(Boolean).join('; ')
      : body?.detail
    throw new Error(detail || `POST /team/chat failed: ${res.status}`)
  }
  return res.json()
}

export async function postTeamCommand(
  command: 'continue' | 'compact' | 'undo' | 'redo',
  sessionId: string,
): Promise<TeamCommandResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/commands`, {
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

export function resolveApiUrl(url: string | undefined): string | undefined {
  if (!url) return url
  if (/^(https?:)?\/\//i.test(url)) return url
  if (url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.startsWith('/api/')) return withTokenParam(apiUrl(url.slice('/api'.length)))
  return url
}

export async function cancelQueuedTeamMessage(sessionId: string, messageId: string): Promise<void> {
  const res = await fetch(
    `${apiBaseUrl()}/team/sessions/${encodeURIComponent(sessionId)}/queued-messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  )
  if (res.status === 404) return
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `DELETE queued message failed: ${res.status}`)
  }
}

export function teamStream(sessionId: string, callbacks: SSECallbacks, signal?: AbortSignal): void {
  fetch(`${apiBaseUrl()}/team/${encodeURIComponent(sessionId)}/stream`, { signal })
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
  const res = await fetch(`${apiBaseUrl()}/team/agents${query ? `?${query}` : ''}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listTeamAgents')
  return res.json()
}

export async function validateWorkspace(workspace: string): Promise<WorkspaceValidationResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/team/workspace/validate?${params}`)
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
  const res = await fetch(`${apiBaseUrl()}/team/workspace/browse${query ? `?${query}` : ''}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `browseWorkspaces failed: ${res.status}`)
  }
  return res.json()
}

export async function getCodingWorkspaceTree(): Promise<CodingWorkspaceTreeResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/tree`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceTree')
  return res.json()
}

export async function listWorktrees(sourceWorkspace: string): Promise<WorktreeInfo[]> {
  const params = new URLSearchParams({ source_workspace: sourceWorkspace })
  const res = await fetch(`${apiBaseUrl()}/team/workspace/worktrees?${params}`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail || `listWorktrees failed: ${res.status}`)
  }
  return res.json()
}

export async function removeWorktree(sourceWorkspace: string, directory: string): Promise<WorktreeRemoveResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/worktrees`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_workspace: sourceWorkspace, directory }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'removeWorktree')
  return res.json()
}

export async function renameWorktree(directory: string, name: string): Promise<WorktreeInfo> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/worktrees`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, name }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'renameWorktree')
  return res.json()
}

export async function createWorktree(options: {
  sourceWorkspace: string
  name?: string | null
  branch?: string | null
  detached?: boolean
}): Promise<WorktreeCreateResponse> {
  const body: Record<string, string | boolean | null> = {
    source_workspace: options.sourceWorkspace,
  }
  if (options.name !== undefined) body.name = options.name
  if (options.branch !== undefined) body.branch = options.branch
  if (options.detached !== undefined) body.detached = options.detached
  const res = await fetch(`${apiBaseUrl()}/team/workspace/worktrees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'createWorktree')
  return res.json()
}

export async function listCodingWorkspaceFiles(workspace: string): Promise<CodingWorkspaceFilesResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/team/workspace/files/list?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listCodingWorkspaceFiles')
  return res.json()
}

export async function getCodingWorkspaceGitDiff(
  workspace: string,
  paths?: string[],
): Promise<WorkspaceGitDiffResponse> {
  const params = new URLSearchParams({ workspace })
  // Repeated ``paths`` params translate to FastAPI's
  // ``Query(list[str])`` — scoped diff response covering just these
  // entries, used by the SSE cache-invalidation bridge for surgical
  // splice instead of a whole-repo refresh.
  if (paths && paths.length > 0) {
    for (const p of paths) params.append('paths', p)
  }
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git-diff/view?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceGitDiff')
  return res.json()
}

export async function getCodingWorkspaceStatus(workspace: string): Promise<WorkspaceStatusResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/team/workspace/status?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceStatus')
  return res.json()
}

export async function getCodingWorkspaceGitHistory(
  workspace: string,
  limit = 50,
  cursor?: string | null,
  all = false,
): Promise<WorkspaceGitHistoryResponse> {
  const params = new URLSearchParams({ workspace, limit: String(limit), all: String(all) })
  if (cursor) {
    params.set('cursor', cursor)
  }
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git/history?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceGitHistory')
  return res.json()
}

export async function getCodingWorkspaceCommitDiff(
  workspace: string,
  sha: string,
): Promise<WorkspaceCommitDiffResponse> {
  const params = new URLSearchParams({ workspace, sha })
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git/commit-diff?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceCommitDiff')
  return res.json()
}

export async function discardCodingWorkspaceFile(
  workspace: string,
  path: string,
  status: 'M' | 'D' | 'A',
): Promise<DiscardWorkspaceFileResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, path, status }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'discardCodingWorkspaceFile')
  return res.json()
}

export async function undoCodingWorkspaceLastCommit(
  workspace: string,
): Promise<GitUndoResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'undoCodingWorkspaceLastCommit')
  return res.json()
}

export async function revertCodingWorkspaceCommit(
  workspace: string,
  sha: string,
): Promise<GitRevertResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/git/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, sha }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'revertCodingWorkspaceCommit')
  return res.json()
}

export async function listTeamSessions(
  before?: string | null,
  limit = 20,
  filters?: { mode?: 'normal' | 'coding'; workspace?: string | null },
): Promise<SessionPageResponse> {
  const params = new URLSearchParams()
  if (before) params.set('before', before)
  params.set('limit', String(limit))
  if (filters?.mode) params.set('mode', filters.mode)
  if (filters?.workspace) params.set('workspace', filters.workspace)
  const res = await fetch(`${apiBaseUrl()}/team/sessions?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listTeamSessions')
  return res.json()
}

export async function setCodingWorkspaceVisibility(workspace: string, hidden: boolean): Promise<CodingWorkspaceVisibilityResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/workspace/visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, hidden }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'setCodingWorkspaceVisibility')
  return res.json()
}

export async function getTeamSession(id: string): Promise<SessionDetailResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/sessions/${id}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getTeamSession')
  return res.json()
}

export async function resolveTeamSession(options: {
  mode?: string
  workspace?: string | null
  model?: string | null
  thinkingLevel?: string | null
  create?: boolean
  worktreeFrom?: string | null
  worktreeName?: string | null
  worktreeBranch?: string | null
}): Promise<TeamSessionResolveResponse> {
  const body: Record<string, string | boolean | null> = {
    mode: options.mode ?? 'normal',
  }
  if (options.workspace !== undefined) body.workspace = options.workspace
  if (options.model !== undefined) body.model = options.model
  if (options.thinkingLevel !== undefined) body.thinking_level = options.thinkingLevel
  if (options.create !== undefined) body.create = options.create
  if (options.worktreeFrom !== undefined) body.worktree_from = options.worktreeFrom
  if (options.worktreeName !== undefined) body.worktree_name = options.worktreeName
  if (options.worktreeBranch !== undefined) body.worktree_branch = options.worktreeBranch
  const res = await fetch(`${apiBaseUrl()}/team/sessions/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'resolveTeamSession')
  return res.json()
}

export async function updateTeamSessionTitle(id: string, title: string): Promise<SessionResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'updateTeamSessionTitle')
  return res.json()
}

export async function deleteTeamSession(id: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/team/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, 'deleteTeamSession')
}

export async function teamHistory(sessionId: string, before?: string): Promise<TeamHistoryResponse> {
  const url = before
    ? `${apiBaseUrl()}/team/${encodeURIComponent(sessionId)}/history?before=${encodeURIComponent(before)}`
    : `${apiBaseUrl()}/team/${encodeURIComponent(sessionId)}/history`
  const res = await fetch(url)
  if (!res.ok) await parseDetailOrThrow(res, 'teamHistory')
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
  const res = await fetch(`${apiBaseUrl()}/team/${encodeURIComponent(sessionId)}/files`)
  if (!res.ok) await parseDetailOrThrow(res, 'listWorkspaceFiles')
  return res.json()
}

/** Build the ``/media/{path}`` URL for a workspace file.
 *
 *  Each segment is encoded individually — ``encodeURIComponent`` on the whole
 *  path would escape the ``/`` separators that the ``{path:path}`` route
 *  pattern needs to see.
 */
export function workspaceMediaUrl(sessionId: string, path: string, options?: { download?: boolean }): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const url = apiUrl(`/team/${encodeURIComponent(sessionId)}/media/${encoded}`)
  if (!options?.download) return withTokenParam(url)
  const separator = url.includes('?') ? '&' : '?'
  return withTokenParam(`${url}${separator}download=1`)
}

/** Build the URL for serving a raw file from a *coding* workspace (not a
 *  session workspace).  Hits ``GET /api/team/workspace/files/read``.
 *
 *  Each segment is encoded individually so ``/`` separators survive and
 *  path-traversal sequences (``../``) are rejected by the server.
 */
export function codingWorkspaceFileUrl(workspace: string, path: string, options?: { download?: boolean }): string {
  const params = new URLSearchParams({ workspace, path })
  if (options?.download) params.set('download', '1')
  return withTokenParam(apiUrl(`/team/workspace/files/read?${params}`))
}

export async function getTodos(sessionId: string): Promise<TodosResponse> {
  const res = await fetch(`${apiBaseUrl()}/team/sessions/${encodeURIComponent(sessionId)}/todos`)
  if (!res.ok) await parseDetailOrThrow(res, 'getTodos')
  return res.json()
}
