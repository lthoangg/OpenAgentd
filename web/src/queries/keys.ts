export const queryKeys = {
  health: () => ['health'] as const,
  agents: () => ['agents'] as const,
  teamAgents: (workspace?: string | null) => workspace ? ['agents', 'team', workspace] as const : ['agents', 'team'] as const,
  team: {
    status: () => ['team', 'status'] as const,
    sessions: {
      all: () => ['team', 'sessions'] as const,
      infinite: () => ['team', 'sessions', 'infinite'] as const,
      workspace: (workspace: string) => ['team', 'sessions', 'workspace', workspace] as const,
      list: (offset: number, limit: number) =>
        ['team', 'sessions', 'list', offset, limit] as const,
      detail: (id: string) => ['team', 'sessions', id] as const,
    },
    // Workspace-files listing per session — powers the Artifacts panel.
    files: (sessionId: string) => ['team', 'files', sessionId] as const,
  },
  // Coding-mode workspace sidebar — keyed by the absolute workspace path
  // (a single project may be shared across multiple sessions/tabs, so the
  // cache is keyed by path rather than session id). The reducer enqueues
  // ``coding_workspace`` invalidations on every file-mutating tool_end and
  // after /undo + /redo so the panel reflects disk state in real time.
  coding: {
    all: (workspace: string) => ['coding-workspace', workspace] as const,
    files: (workspace: string) =>
      ['coding-workspace-files', workspace] as const,
    diff: (workspace: string) =>
      ['coding-workspace-diff', workspace] as const,
    status: (workspace: string) =>
      ['coding-workspace-status', workspace] as const,
    history: (workspace: string, limit: number, allBranches: boolean) =>
      ['coding-workspace-history', workspace, limit, allBranches] as const,
    commitDiff: (workspace: string, sha: string) =>
      ['coding-workspace-commit-diff', workspace, sha] as const,
  },
  // File references for the input bar's @-mention picker. Keyed by the
  // workspace path (coding mode) or session id (normal mode) so the two
  // origins don't share a cache entry.
  fileRefs: {
    coding: (workspace: string) => ['file-refs', 'coding', workspace] as const,
    session: (sessionId: string) => ['file-refs', 'session', sessionId] as const,
  },
  quote: () => ['quote'] as const,
  agentFiles: {
    all: () => ['agentFiles'] as const,
    list: () => ['agentFiles', 'list'] as const,
    detail: (name: string) => ['agentFiles', 'detail', name] as const,
    registry: () => ['agentFiles', 'registry'] as const,
  },
  skillFiles: {
    all: () => ['skillFiles'] as const,
    list: () => ['skillFiles', 'list'] as const,
    detail: (name: string) => ['skillFiles', 'detail', name] as const,
  },
  commands: {
    list: (workspace?: string | null) => ['commands', 'list', workspace ?? null] as const,
  },
  snippets: {
    list: (workspace: string) => ['snippets', 'list', workspace] as const,
  },
  observability: {
    summary: (days: number) => ['observability', 'summary', days] as const,
    traces: (days: number, limit: number, offset: number) =>
      ['observability', 'traces', days, limit, offset] as const,
    infiniteTraces: (days: number, limit: number) =>
      ['observability', 'traces', 'infinite', days, limit] as const,
    trace: (traceId: string) => ['observability', 'trace', traceId] as const,
  },
  scheduler: {
    all: () => ['scheduler'] as const,
    list: () => ['scheduler', 'list'] as const,
  },
  todos: (sessionId: string) => ['todos', sessionId] as const,
  mcp: {
    all: () => ['mcp'] as const,
    list: () => ['mcp', 'list'] as const,
    detail: (name: string) => ['mcp', 'detail', name] as const,
  },
  settings: {
    sandbox: () => ['settings', 'sandbox'] as const,
    summarization: () => ['settings', 'summarization'] as const,
    titleGeneration: () => ['settings', 'titleGeneration'] as const,
    multimodal: () => ['settings', 'multimodal'] as const,
    providers: () => ['settings', 'providers'] as const,
    providerModels: (providerId: string) => ['settings', 'providers', providerId, 'models'] as const,
    providerUsage: (providerId: string) => ['settings', 'providers', providerId, 'usage'] as const,
  },
}
