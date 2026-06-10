import type { ContentBlock, AgentUsage, TeamCommandResponse } from '@/api/types'

export interface PendingMessage {
  id: string
  sessionId?: string | null
  content: string
  submittedAt?: number
}

export type CacheInvalidation =
  | { kind: 'wiki' }
  | { kind: 'workspace_files'; sessionId: string }
  | { kind: 'coding_workspace'; workspace: string }
  | { kind: 'coding_workspace_paths'; workspace: string; paths: string[] }
  | { kind: 'scheduler' }
  | { kind: 'todos'; sessionId: string }
  | { kind: 'team_agents' }
  | { kind: 'team_sessions' }

export interface SetupRequiredNotice {
  agent: string
  message: string
  action: { type?: string; tab?: string }
}

export interface AgentStream {
  blocks: ContentBlock[]
  currentBlocks: ContentBlock[]
  currentText: string
  currentThinking: string
  status: 'idle' | 'working' | 'offline' | 'error'
  usage: AgentUsage
  _completionBase: number
  _completionEstimated?: number
  _turnStartedAt?: number | null
  model: string | null
  lastError: string | null
  revertedCount?: number
  revertedMessages?: Array<{ role: string; content: string }>
  _revertedSuffix?: ContentBlock[]
}

export interface ActiveLoop {
  prompt: string | null
  limit: number
  remaining: number
  used: number
  paused: boolean
}

export interface TeamStoreState {
  agentStreams: Record<string, AgentStream>
  activeAgent: string | null
  leadName: string | null
  agentNames: string[]
  liveAgentNames: string[] | null
  sidebarOpen: boolean
  sessionId: string | null
  sessionTitle: string | null
  sessionModel: string | null
  sessionThinkingLevel: string | null
  sessionFastMode: boolean
  isTeamWorking: boolean
  isContinuing: boolean
  isConnected: boolean
  error: string | null
  activeLoop: ActiveLoop | null
  setupRequired: SetupRequiredNotice | null
  _pendingMessages: PendingMessage[]
  _sessionGeneration: number
  hasMore: boolean
  nextCursor: string | null
  _leadRevertTime: number | null
  _workspace: string | null
  _loadingOlder: boolean
  _resolvedSessionReadyId: string | null
  _unloading: boolean
  cacheInvalidations: CacheInvalidation[]
}

export interface TeamStoreActions {
  sendMessage: (content: string, files?: File[], options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; shell?: boolean }) => Promise<void>
  setSessionModelSettings: (model: string | null, thinkingLevel: string | null, fastMode?: boolean) => void
  continueTeam: () => Promise<void>
  compactTeam: () => Promise<void>
  undoTeam: () => Promise<TeamCommandResponse | undefined>
  redoTeam: () => Promise<void>
  sendLoopCommand: (command: string, prompt?: string, options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean }) => Promise<void>
  stopTeam: () => Promise<void>
  connectStream: () => AbortController
  loadTeamStatus: (workspace?: string | null) => Promise<void>
  loadSession: (sessionId: string, workspace?: string | null) => Promise<void>
  beginResolvedSession: (sessionId: string | null, options?: { mode?: string; workspace?: string | null; model?: string | null; thinkingLevel?: string | null; fastMode?: boolean; skipInitialRestore?: boolean }) => void
  loadOlderMessages: () => Promise<void>
  setActiveAgent: (name: string) => void
  cycleActiveAgent: (dir: 'next' | 'prev') => void
  toggleSidebar: () => void
  dismissSetupRequired: () => void
  isEmptyIdleSession: () => boolean
  consumeResolvedSessionReady: (sessionId: string, workspace?: string | null) => boolean
  /** Reset local chat state. Retained for stale async-generation guards in tests. */
  newSession: () => void
  removePendingMessage: (id: string) => void
  _handleSSEEvent: (type: string, data: unknown) => void
  _drainCacheInvalidations: () => CacheInvalidation[]
  _abortController: AbortController | null
}

export type TeamStore = TeamStoreState & TeamStoreActions
