// API Response Types
export interface AgentToolInfo {
  name: string
  description: string
}

export interface AgentSkillInfo {
  name: string
  description: string
}

export interface AgentInputCapabilities {
  vision: boolean
  document_text: boolean
  audio: boolean
  video: boolean
}

export interface AgentOutputCapabilities {
  text: boolean
  image: boolean
  audio: boolean
}

export interface AgentCapabilities {
  input: AgentInputCapabilities
  output: AgentOutputCapabilities
}

export interface AgentInfo {
  name: string
  description: string
  model: string | null
  tools: AgentToolInfo[]
  /** MCP server names this agent was configured with. Includes servers that
   *  exist but contribute no tools (e.g. not yet ready). */
  mcp_servers?: string[]
  skills: AgentSkillInfo[]
  capabilities?: AgentCapabilities
}

export interface TeamAgentInfo extends AgentInfo {
  is_lead: boolean
}

export interface TeamBlueprintInfo extends AgentInfo {
  live_instances: string[]
}

export interface TeamAgentsResponse {
  agents: TeamAgentInfo[]
  blueprints: TeamBlueprintInfo[]
  mode?: string
  workspace?: string | null
}

export interface WorkspaceValidationResponse {
  workspace: string
}

export interface WorkspaceBrowseResponse {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
}

export interface WorkspaceGitDiffResponse {
  workspace: string
  is_git_repo: boolean
  diff: string
  untracked?: string[]
  truncated?: boolean
}

export interface WorkspaceStatusResponse {
  workspace: string
  name: string
  is_git_repo: boolean
  branch?: string | null
  dirty?: { staged: number; unstaged: number; untracked: number }
  head?: { sha: string; subject: string; timestamp: number } | null
}

export interface CodingWorkspaceFilesResponse {
  workspace: string
  files: WorkspaceFileInfo[]
  truncated: boolean
}

export interface MessageAttachment {
  filename?: string
  media_type?: string
  original_name?: string
  category?: 'text' | 'image' | 'document'
  url?: string        // /api/chat/files/{session_id}/{filename} or blob URL for optimistic
}

export interface MessageResponse {
  id: string
  session_id: string
  role: string
  content: string | null
  reasoning_content: string | null
  // Backend returns raw dicts; cast to ToolCall shape for UI convenience.
  tool_calls: Array<Partial<ToolCall> & { id: string; function?: Partial<ToolCall['function']> }> | null
  tool_call_id: string | null
  name: string | null
  is_summary: boolean
  is_hidden: boolean
  extra: Record<string, unknown> | null
  created_at: string | null
  file_message?: boolean
  attachments: MessageAttachment[] | null
}

export interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string  // raw JSON string from API
    thought?: string | null
    thought_signature?: string | null
  }
}

export interface SessionResponse {
  id: string
  title: string | null
  agent_name: string | null
  revert?: { message_id?: string } | null
  created_at: string | null
  updated_at: string | null
  scheduled_task_name?: string | null
  mode?: string
  workspace?: string | null
}

export interface SessionDetailResponse extends SessionResponse {
  messages: MessageResponse[]
}

export interface SessionPageResponse {
  data: SessionResponse[]
  /** ISO 8601 created_at of the last item; pass as `before` to fetch next page. */
  next_cursor: string | null
  has_more: boolean
}



export interface TeamStatusAgent {
  name: string
  model: string
  state: string
}

export interface TeamStatusResponse {
  team: string
  lead: TeamStatusAgent
  members: TeamStatusAgent[]
}

export interface TeamHistoryResponse {
  lead: SessionDetailResponse
  members: Array<{
    name: string
    session_id: string
    messages: MessageResponse[]
  }>
  has_more: boolean
  next_cursor: string | null
}

// SSE Event Types
export type SSEEventType =
  | 'session'
  | 'thinking'
  | 'message'
  | 'tool_call'
  | 'tool_start'
  | 'tool_output_delta'
  | 'tool_end'
  | 'usage'
  | 'done'
  | 'rate_limit'
  | 'error'
  | 'agent_status'
  | 'inbox'
  | 'title_update'
  | 'summarization_start'
  | 'summarization_content'
  | 'summarization_end'

export interface SSEEvent {
  type: SSEEventType
  [key: string]: unknown
}

// Content Block Types
export interface ContentBlock {
  id: string
  type: 'thinking' | 'tool' | 'text' | 'user' | 'compaction'
  content: string
  toolName?: string
  toolArgs?: string
  toolDone?: boolean
  toolCallId?: string   // for matching tool results
  toolOutput?: string   // live output streamed before tool_end
  toolResult?: string   // the role:"tool" response content
  /** Variant-specific metadata. ``user`` inbox blocks carry ``from_agent``;
   *  ``compaction`` blocks carry ``state: 'compacting' | 'compacted'`` and
   *  optional ``error: true``. Keeping this generic avoids one typed field
   *  per block variant. */
  extra?: Record<string, unknown> | null
  /** Timestamp when block was created (for team mode display) */
  timestamp?: Date
  /** File attachments (images, documents, etc.) — for user blocks */
  attachments?: MessageAttachment[]
}

// Chat Message Type
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string // For user: plain text. For assistant: ignored (use blocks)
  blocks: ContentBlock[]
  agent?: string | null
  model?: string | null
  timestamp: Date
  usage?: AgentUsage
  file_message?: boolean
  attachments?: MessageAttachment[]
}

// Agent Usage Stats
export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
}

// ── Wiki ─────────────────────────────────────────────────────────────────────

/** One row in the wiki tree — surfaced from YAML frontmatter. */
export interface WikiFileInfo {
  /** Path relative to OPENAGENTD_WIKI_DIR, e.g. 'topics/auth.md'. */
  path: string
  description: string
  updated: string | null
  tags: string[]
  /** ``high|medium|low`` from frontmatter; ``null`` when unspecified. */
  confidence?: string | null
  /** Source slugs that contributed (e.g. ``session-a1b2c3d4``). */
  sources?: string[]
}

/** Full wiki tree grouped by subdirectory.  Mirrors the Karpathy LLM-Wiki
 *  page-type split: concepts (``topics``), entities, sources, comparisons.
 */
export interface WikiTree {
  /** Root files: USER.md, INDEX.md, LOG.md, LINT.md (any that exist). */
  system: WikiFileInfo[]
  /** notes/ — session dumps written by the agent (read-only in the UI). */
  notes: WikiFileInfo[]
  /** topics/ — concept pages (abstract ideas, techniques). */
  topics: WikiFileInfo[]
  /** entities/ — concrete things (people, tools, orgs, products). */
  entities: WikiFileInfo[]
  /** sources/ — one-page summaries per ingested source. */
  sources: WikiFileInfo[]
  /** comparisons/ — X-vs-Y pages. */
  comparisons: WikiFileInfo[]
}

/** Raw contents of a single wiki file. */
export interface WikiFile {
  path: string
  content: string
  description: string
  updated: string | null
  tags: string[]
  confidence?: string | null
  sources?: string[]
}

// ── Agent management ────────────────────────────────────────────────────────

/** Lightweight row for the agents list. Invalid files have `valid=false`. */
export interface AgentSummary {
  name: string
  role: 'lead' | 'member'
  description: string | null
  model: string | null
  tools: string[]
  skills: string[]
  valid: boolean
  error: string | null
}

/** Parsed frontmatter config — matches backend AgentConfig. */
export interface AgentConfig {
  name: string
  role: 'lead' | 'member'
  description?: string | null
  system_prompt?: string
  tools?: string[]
  skills?: string[]
  model?: string | null
  fallback_model?: string | null
  temperature?: number | null
  thinking_level?: string | null
  responses_api?: boolean | null
}

/** Full view of one agent — raw file + parsed config. */
export interface AgentDetail {
  name: string
  path: string
  content: string
  config: AgentConfig | null
  error: string | null
}

export interface AgentDeleteResponse {
  name: string
}

export interface AgentListResponse {
  agents: AgentSummary[]
}

// ── Skill management ────────────────────────────────────────────────────────

export interface SkillSummary {
  name: string
  description: string
  valid: boolean
  error: string | null
}

export interface SkillDetail {
  name: string
  path: string
  content: string
  description: string
  error: string | null
}

export interface SkillDeleteResponse {
  name: string
}

export interface SkillListResponse {
  skills: SkillSummary[]
}

// ── Slash commands ──────────────────────────────────────────────────────────

export interface CommandSummary {
  name: string
  description: string
  source: string
}

export interface CommandListResponse {
  commands: CommandSummary[]
}

export interface CommandRenderResponse {
  name: string
  content: string
}

export interface TeamCommandResponse {
  status: string
  session_id: string
  command: 'continue' | 'compact' | 'undo' | 'redo'
  message?: MessageResponse
}

// ── Registry (dropdown catalog) ─────────────────────────────────────────────

export interface ToolCatalogEntry {
  name: string
  description: string
}

export interface SkillCatalogEntry {
  name: string
  description: string
}

export interface ModelCatalogEntry {
  id: string       // provider:model
  provider: string
  model: string
  vision: boolean
  output_image: boolean
  output_video: boolean
}

export interface RegistryResponse {
  tools: ToolCatalogEntry[]
  skills: SkillCatalogEntry[]
  providers: string[]
  models: ModelCatalogEntry[]
}

// ── Workspace files (artifacts panel) ────────────────────────────────────────
//
// Flat recursive listing of a session's agent workspace (``.openagentd/team/{sid}``).
// File bytes are fetched through ``/api/team/{sid}/media/{path}`` — the same
// proxy that renders inline markdown images.

export interface WorkspaceFileInfo {
  path: string   // POSIX-separated, relative to the workspace root
  name: string   // Basename
  size: number   // Bytes
  mtime: number  // Seconds since epoch
  mime: string   // MIME type (guessed)
}

export interface WorkspaceFilesResponse {
  session_id: string
  files: WorkspaceFileInfo[]
  truncated: boolean
}

// ── Scheduler ───────────────────────────────────────────────────────────────

export type ScheduledTaskMode = 'normal' | 'coding'

export interface ScheduledTaskResponse {
  id: string
  name: string
  // Routing target — every task delivers to the team lead of the matching
  // team (default lead for ``normal``, workspace lead for ``coding``).
  // See documents/docs/agent/tools.md#scheduler-builtinschedulepy.
  mode: ScheduledTaskMode
  workspace: string | null
  schedule_type: 'at' | 'every' | 'cron'
  at_datetime: string | null
  every_seconds: number | null
  cron_expression: string | null
  timezone: string
  prompt: string
  session_id: string | null
  enabled: boolean
  status: string
  run_count: number
  last_run_at: string | null
  last_error: string | null
  next_fire_at: string | null
  created_at: string
  updated_at: string
}

export interface ScheduledTaskCreate {
  name: string
  mode?: ScheduledTaskMode
  workspace?: string | null
  schedule_type: 'at' | 'every' | 'cron'
  at_datetime?: string | null
  every_seconds?: number | null
  cron_expression?: string | null
  timezone?: string
  prompt: string
  session_id?: string | null
  enabled?: boolean
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTaskResponse[]
}

export interface TodoItem {
  task_id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  dependencies?: string[]
  assigned_to?: string | null
  claimed_by?: string | null
}

export interface TodosResponse {
  todos: TodoItem[]
}
