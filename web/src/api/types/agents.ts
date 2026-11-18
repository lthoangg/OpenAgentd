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

/** One session a finished turn still waits for (`GET /agent/sessions/{id}/waiting`). */
export interface WaitingItem {
  /** A subagent of the session, or a session in another workspace that owes it a reply. */
  kind: 'subagent' | 'session'
  session_id: string
  title: string | null
  /** A subagent's handle (`worker#1`), or the name of the workspace the session runs in. */
  label: string
  /** Empty for a subagent: it runs in the session's own workspace. */
  workspace: string
  /** `needs_input`: stopped on a question or a plan review. `idle`: not running. */
  state: 'working' | 'needs_input' | 'idle'
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
