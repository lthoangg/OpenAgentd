/**
 * OpenAgentd API client — session group: /session chat, sessions, workspace, files.
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
  PendingQuestionEnvelope,
  QuestionResolveResult,
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
  message: string | null,
  sessionId: string | null,
  interrupt = false,
  workspace: string,
  files?: File[],
  model?: string | null,
  thinkingLevel?: string | null,
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
  formData.append('workspace', workspace)
  if (model !== undefined) {
    formData.append('model', model ?? '')
  }
  if (thinkingLevel !== undefined) {
    formData.append('thinking_level', thinkingLevel ?? '')
  }
  if (fastMode) {
    formData.append('fast_mode', 'true')
  }
  if (mentions && mentions.length > 0) {
    formData.append('mentions', JSON.stringify(mentions))
  }
  if (files && files.length > 0) {
    for (const file of files) {
      formData.append('files', file)
    }
  }

  const res = await fetch(`${apiBaseUrl()}/session/chat`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: formData,
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /session/chat')
  return res.json()
}

export async function postTeamCommand(
  command: 'continue' | 'compact' | 'undo' | 'redo' | 'redo-all' | 'redo_all',
  sessionId: string,
): Promise<TeamCommandResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, session_id: sessionId }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'POST /session/commands')
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
    `${apiBaseUrl()}/session/sessions/${encodeURIComponent(sessionId)}/queued-messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  )
  if (res.status === 404) return
  if (!res.ok) await parseDetailOrThrow(res, 'DELETE queued message')
}

export function teamStream(sessionId: string, callbacks: SSECallbacks, signal?: AbortSignal): void {
  fetch(withTokenParam(`${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/stream`), { signal })
    .then((res) => {
      if (!res.ok) throw new Error(`GET /session/${sessionId}/stream failed: ${res.status}`)
      readSSE(res, callbacks)
    })
    .catch((err) => { if (err.name !== 'AbortError') callbacks.onError?.(err) })
}

async function fetchTeamAgents(workspace: string, sessionId?: string | null): Promise<TeamAgentsResponse> {
  const params = new URLSearchParams({ workspace })
  if (sessionId) params.set('session_id', sessionId)
  const res = await fetch(`${apiBaseUrl()}/session/agents?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listTeamAgents')
  return res.json()
}

/**
 * In-flight requests per workspace, so concurrent callers share one round trip.
 *
 * `GET /session/agents` re-globs and re-parses every agent `.md` on the server for
 * each request, and it has two independent callers that fire in the same window
 * when a session opens: the team store's `loadTeamStatus()` (which cannot use
 * TanStack — the store holds no TanStack imports) and the header's
 * `useTeamAgentsQuery`. TanStack dedupes its own observers but knows nothing
 * about the store's direct call, so the coalescing has to live here.
 *
 * Entries are removed as soon as the request settles: this is request
 * coalescing, not a response cache, so it never serves stale data.
 */
const inFlightTeamAgents = new Map<string, Promise<TeamAgentsResponse>>()

export function listTeamAgents(workspace: string, sessionId?: string | null): Promise<TeamAgentsResponse> {
  const key = `${workspace}\u0000${sessionId ?? ''}`
  const existing = inFlightTeamAgents.get(key)
  if (existing) return existing

  const request = fetchTeamAgents(workspace, sessionId).finally(() => {
    inFlightTeamAgents.delete(key)
  })
  inFlightTeamAgents.set(key, request)
  return request
}

export async function validateWorkspace(workspace: string): Promise<WorkspaceValidationResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/session/workspace/validate?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'validateWorkspace')
  return res.json()
}

export async function browseWorkspaces(path?: string | null): Promise<WorkspaceBrowseResponse> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  const res = await fetch(`${apiBaseUrl()}/session/workspace/browse${query ? `?${query}` : ''}`)
  if (!res.ok) await parseDetailOrThrow(res, 'browseWorkspaces')
  return res.json()
}

export async function getCodingWorkspaceTree(): Promise<CodingWorkspaceTreeResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/workspace/tree`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceTree')
  return res.json()
}

export async function listWorktrees(sourceWorkspace: string): Promise<WorktreeInfo[]> {
  const params = new URLSearchParams({ source_workspace: sourceWorkspace })
  const res = await fetch(`${apiBaseUrl()}/session/workspace/worktrees?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listWorktrees')
  return res.json()
}

export async function removeWorktree(sourceWorkspace: string, directory: string): Promise<WorktreeRemoveResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/workspace/worktrees`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_workspace: sourceWorkspace, directory }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'removeWorktree')
  return res.json()
}

export async function renameWorktree(directory: string, name: string): Promise<WorktreeInfo> {
  const res = await fetch(`${apiBaseUrl()}/session/workspace/worktrees`, {
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
  const res = await fetch(`${apiBaseUrl()}/session/workspace/worktrees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'createWorktree')
  return res.json()
}

export async function listCodingWorkspaceFiles(workspace: string): Promise<CodingWorkspaceFilesResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/session/workspace/files/list?${params}`)
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
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git-diff/view?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceGitDiff')
  return res.json()
}

export async function getCodingWorkspaceStatus(workspace: string): Promise<WorkspaceStatusResponse> {
  const params = new URLSearchParams({ workspace })
  const res = await fetch(`${apiBaseUrl()}/session/workspace/status?${params}`)
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
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git/history?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceGitHistory')
  return res.json()
}

export async function getCodingWorkspaceCommitDiff(
  workspace: string,
  sha: string,
): Promise<WorkspaceCommitDiffResponse> {
  const params = new URLSearchParams({ workspace, sha })
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git/commit-diff?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getCodingWorkspaceCommitDiff')
  return res.json()
}

export async function discardCodingWorkspaceFile(
  workspace: string,
  path: string,
  status: 'M' | 'D' | 'A',
): Promise<DiscardWorkspaceFileResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git/discard`, {
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
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git/undo`, {
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
  const res = await fetch(`${apiBaseUrl()}/session/workspace/git/revert`, {
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
  filters?: { workspace?: string | null },
): Promise<SessionPageResponse> {
  const params = new URLSearchParams()
  if (before) params.set('before', before)
  params.set('limit', String(limit))
  if (filters?.workspace) params.set('workspace', filters.workspace)
  const res = await fetch(`${apiBaseUrl()}/session/sessions?${params}`)
  if (!res.ok) await parseDetailOrThrow(res, 'listTeamSessions')
  return res.json()
}

export async function setCodingWorkspaceVisibility(workspace: string, hidden: boolean): Promise<CodingWorkspaceVisibilityResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/workspace/visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, hidden }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'setCodingWorkspaceVisibility')
  return res.json()
}

export async function getTeamSession(id: string): Promise<SessionDetailResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/sessions/${id}`)
  if (!res.ok) await parseDetailOrThrow(res, 'getTeamSession')
  return res.json()
}

export async function resolveTeamSession(options: {
  workspace: string
  model?: string | null
  thinkingLevel?: string | null
  create?: boolean
  worktreeFrom?: string | null
  worktreeName?: string | null
  worktreeBranch?: string | null
}): Promise<TeamSessionResolveResponse> {
  const body: Record<string, string | boolean | null> = { workspace: options.workspace }
  if (options.model !== undefined) body.model = options.model
  if (options.thinkingLevel !== undefined) body.thinking_level = options.thinkingLevel
  if (options.create !== undefined) body.create = options.create
  if (options.worktreeFrom !== undefined) body.worktree_from = options.worktreeFrom
  if (options.worktreeName !== undefined) body.worktree_name = options.worktreeName
  if (options.worktreeBranch !== undefined) body.worktree_branch = options.worktreeBranch
  const res = await fetch(`${apiBaseUrl()}/session/sessions/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'resolveTeamSession')
  return res.json()
}

export async function updateTeamSessionTitle(id: string, title: string): Promise<SessionResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'updateTeamSessionTitle')
  return res.json()
}

export async function deleteTeamSession(id: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/session/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, 'deleteTeamSession')
}

export async function teamHistory(sessionId: string, before?: string): Promise<TeamHistoryResponse> {
  const url = before
    ? `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/history?before=${encodeURIComponent(before)}`
    : `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/history`
  const res = await fetch(url)
  if (!res.ok) await parseDetailOrThrow(res, 'teamHistory')
  return res.json()
}

/**
 * Rows created after the opaque uuid7 ``since`` cursor — the post-turn
 * reconciliation path.
 *
 * A full page carries up to 100 messages with complete tool output, nearly all
 * of which the client just received over SSE. ``truncated`` on the response means the caller
 * has fallen too far behind and must do a full ``teamHistory`` instead.
 */
export async function teamHistorySince(
  sessionId: string,
  since: string,
): Promise<TeamHistoryResponse> {
  const params = new URLSearchParams({ since })
  const res = await fetch(
    `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/history?${params}`,
  )
  if (!res.ok) await parseDetailOrThrow(res, 'teamHistorySince')
  return res.json()
}

// ── ask_user ────────────────────────────────────────────────────────

/**
 * Cold-load the open question for a session.
 *
 * Rarely needed: a live client gets the question from the replayed
 * ``question_asked`` SSE event, and a cold load gets it from ``teamHistory``.
 * This exists for a client that wants to re-check without reloading history.
 */
export async function getPendingQuestion(
  sessionId: string,
): Promise<PendingQuestionEnvelope> {
  const res = await fetch(
    `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/question`,
  )
  if (!res.ok) await parseDetailOrThrow(res, 'getPendingQuestion')
  return res.json()
}

/**
 * Answer a pending question and resume the suspended turn.
 *
 * ``answers`` is index-matched to the questions that were asked; an empty entry
 * skips that question. A ``resumed: false`` response means the answer was saved
 * but the turn did not restart — the caller should surface that rather than
 * assume the agent is working.
 */
export async function answerQuestion(
  sessionId: string,
  questionId: string,
  answers: string[][],
): Promise<QuestionResolveResult> {
  const res = await fetch(
    `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(questionId)}/answer`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    },
  )
  if (!res.ok) await parseDetailOrThrow(res, 'answerQuestion')
  return res.json()
}

/** Close a question without answering. Ends the lead's turn; members keep working. */
export async function dismissQuestion(
  sessionId: string,
  questionId: string,
): Promise<QuestionResolveResult> {
  const res = await fetch(
    `${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(questionId)}/dismiss`,
    { method: 'POST' },
  )
  if (!res.ok) await parseDetailOrThrow(res, 'dismissQuestion')
  return res.json()
}

/**
 * List every file under the session's agent workspace (``.openagentd/session/{sid}``).
 *
 * Returns an empty list for fresh sessions where the workspace hasn't been
 * created yet (the agent hasn't written anything).  File bytes are fetched
 * via the ``/media/{path}`` proxy, not this endpoint — keep payloads small.
 */
export async function listWorkspaceFiles(sessionId: string): Promise<WorkspaceFilesResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/${encodeURIComponent(sessionId)}/files`)
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
  const url = apiUrl(`/session/${encodeURIComponent(sessionId)}/media/${encoded}`)
  if (!options?.download) return withTokenParam(url)
  const separator = url.includes('?') ? '&' : '?'
  return withTokenParam(`${url}${separator}download=1`)
}

/** Build the URL for serving a raw file from a *coding* workspace (not a
 *  session workspace).  Hits ``GET /api/session/workspace/files/read``.
 *
 *  Each segment is encoded individually so ``/`` separators survive and
 *  path-traversal sequences (``../``) are rejected by the server.
 */
export function codingWorkspaceFileUrl(workspace: string, path: string, options?: { download?: boolean }): string {
  const params = new URLSearchParams({ workspace, path })
  if (options?.download) params.set('download', '1')
  return withTokenParam(apiUrl(`/session/workspace/files/read?${params}`))
}

export async function getTodos(sessionId: string): Promise<TodosResponse> {
  const res = await fetch(`${apiBaseUrl()}/session/sessions/${encodeURIComponent(sessionId)}/todos`)
  if (!res.ok) await parseDetailOrThrow(res, 'getTodos')
  return res.json()
}
