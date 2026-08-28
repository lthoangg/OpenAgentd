export const queryKeys = {
  health: () => ['health'] as const,
  agents: () => ['agents'] as const,
  teamAgents: (workspace?: string | null) => workspace ? ['agents', 'team', workspace] as const : ['agents', 'team'] as const,
  team: {
    // NOTE: there is no separate team-status key. The home-page "is team mode
    // available" probe projects the shared ``teamAgents`` entry with `select`
    // (see queries/useTeamStatusQuery.ts) so both surfaces share one request to
    // the agent-globbing /session/agents endpoint.
    sessions: {
      all: () => ['team', 'sessions'] as const,
      infinite: () => ['team', 'sessions', 'infinite'] as const,
      workspace: (workspace: string) => ['team', 'sessions', 'workspace', workspace] as const,
      list: (offset: number, limit: number) =>
        ['team', 'sessions', 'list', offset, limit] as const,
      detail: (id: string) => ['team', 'sessions', id] as const,
    },
    // Workspace-files listing per session — powers the Artifacts panel *and*
    // the InputComposer @-mention picker. Both go through the shared query options
    // in ``queries/workspace-files.ts``; do not add a second key for the same
    // endpoint, or the ``workspace_files`` invalidation will only reach one of
    // them and the expensive directory walk will run twice.
    files: (sessionId: string) => ['team', 'files', sessionId] as const,
  },
  // Coding-mode workspace sidebar — keyed by the absolute workspace path
  // (a single project may be shared across multiple sessions/tabs, so the
  // cache is keyed by path rather than session id). The reducer enqueues
  // ``coding_workspace`` invalidations on every file-mutating tool_end and
  // after /undo + /redo so the panel reflects disk state in real time.
  coding: {
    tree: () => ['coding-workspace-tree'] as const,
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
    deniedPaths: () => ['settings', 'denied-paths'] as const,
    sandbox: () => ['settings', 'denied-paths'] as const,
    summarization: () => ['settings', 'summarization'] as const,
    titleGeneration: () => ['settings', 'titleGeneration'] as const,
    multimodal: () => ['settings', 'multimodal'] as const,
    providers: () => ['settings', 'providers'] as const,
    providerModels: (providerId: string) => ['settings', 'providers', providerId, 'models'] as const,
    providerUsage: (providerId: string) => ['settings', 'providers', providerId, 'usage'] as const,
  },
}
