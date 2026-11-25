// Agents, their profiles, status and the registry catalogue.

// API Response Types
export interface AgentToolInfo {
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
  /** The agent file's thinking level; v2 backends omit it. */
  thinking_level?: string | null
  summary_trigger_tokens?: number
  tools: AgentToolInfo[]
  /** MCP server names this agent was configured with. Includes servers that
   *  exist but contribute no tools (e.g. not yet ready). */
  mcp_servers?: string[]
  capabilities?: AgentCapabilities
}

export interface AgentRegistryResponse {
  agents: AgentInfo[]
  mode?: string
  workspace?: string | null
}

export interface AgentStatusAgent {
  name: string
  model: string
  state: string
}

export interface MemberProfile {
  name: string
  description?: string | null
  tools: string[]
  model?: string | null
}

export interface AgentSummary {
  name: string
  role: string
  description?: string | null
  model?: string | null
  tools?: string[]
  valid: boolean
  error?: string | null
}

export interface AgentListResponse {
  agents: AgentSummary[]
}

export interface LiveSubagent {
  member_id: string
  profile: string
  title?: string
  status: string
  session_id: string
  created_at?: string | null
  last_error?: string | null
  has_pending_question: boolean
}

export interface SubagentsResponse {
  available_profiles: MemberProfile[]
  live_members: LiveSubagent[]
  subagents?: LiveSubagent[]
}

/**
 * One thing a finished turn still waits for, or that it left running
 * (`GET /agent/sessions/{id}/waiting`).
 */
export interface WaitingItem {
  /**
   * A subagent of the session, a session in another workspace that owes it
   * a reply, or a background `shell` command of the session still running.
   */
  kind: 'subagent' | 'session' | 'command'
  /** A command: the session it belongs to. */
  session_id: string
  /** A command: its description, when the agent gave one. */
  title: string | null
  /** A subagent's handle (`worker#1`), the name of the workspace the session runs in, or the command. */
  label: string
  /** Empty for a subagent or a command: it runs in the session's own workspace. */
  workspace: string
  /** `needs_input`: stopped on a question or a plan review. `idle`: not running. A command is always `working`. */
  state: 'working' | 'needs_input' | 'idle'
  /** A command: its number within the session. */
  number?: number
  /** A command: whether the session waits for its result. `false` for one that only keeps running (a server). */
  waited?: boolean
  /** A command: when it started, in Unix seconds. */
  started_at?: number
}

export interface WaitingResponse {
  items: WaitingItem[]
}

export interface AgentStatusResponse {
  lead: AgentStatusAgent
  members: AgentStatusAgent[]
}

// Agent Usage Stats
export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedTokens: number
  cachedPercent?: number
  /** Estimated USD cost accumulated for this agent in the active session. */
  estimatedCostUsd?: number
  turnPromptTokens?: number
  turnCompletionTokens?: number
  turnTotalTokens?: number
  turnCachedTokens?: number
}

/** Parsed frontmatter config — matches backend AgentConfig. */
export interface AgentConfig {
  name: 'code'
  role: 'lead'
  description?: string | null
  system_prompt?: string
  tools?: string[]
  model?: string | null
  thinking_level?: string | null
}

/** Full view of one agent — raw file + parsed config. */
export interface AgentDetail {
  name: string
  path: string
  content: string
  config: AgentConfig | null
  error: string | null
}

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
  thinking_levels: string[]
  summary_trigger_tokens: number
  fast_mode: boolean
}

export interface RegistryResponse {
  tools: ToolCatalogEntry[]
  skills: SkillCatalogEntry[]
  providers: string[]
  models: ModelCatalogEntry[]
}
