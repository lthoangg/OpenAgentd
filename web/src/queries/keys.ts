export const queryKeys = {
  health: () => ['health'] as const,
  agents: () => ['agents'] as const,
  team: {
    status: () => ['team', 'status'] as const,
    sessions: {
      all: () => ['team', 'sessions'] as const,
      infinite: () => ['team', 'sessions', 'infinite'] as const,
      list: (offset: number, limit: number) =>
        ['team', 'sessions', 'list', offset, limit] as const,
      detail: (id: string) => ['team', 'sessions', id] as const,
    },
    // Workspace-files listing per session — powers the Artifacts panel.
    files: (sessionId: string) => ['team', 'files', sessionId] as const,
  },
  quote: () => ['quote'] as const,
  wiki: {
    all: () => ['wiki'] as const,
    tree: () => ['wiki', 'tree'] as const,
    file: (path: string) => ['wiki', 'file', path] as const,
  },
  dream: {
    config: () => ['dream', 'config'] as const,
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
  observability: {
    summary: (days: number) => ['observability', 'summary', days] as const,
    traces: (days: number, limit: number, offset: number) =>
      ['observability', 'traces', days, limit, offset] as const,
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
    update: () => ['settings', 'update'] as const,
  },
  speech: {
    config: () => ['speech', 'config'] as const,
  },
}
