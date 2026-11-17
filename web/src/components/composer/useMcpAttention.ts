/**
 * The agent's MCP servers that need the user: one waiting for sign-in, or
 * one that failed, or one the project ships that waits for approval. Servers
 * that work stay out of sight; these mark the composer's "+" (where MCP
 * lives) with a dot.
 */
import { useMcpServersQuery } from '@/queries/useMcpQuery'
import { useAgentsQuery } from '@/queries/useAgentsQuery'

export interface McpAttention {
  /** Server names needing the user, in the registry's order. */
  names: string[]
  /** One line for the "+" button's description, or null when none needs it. */
  summary: string | null
}

export function useMcpAttention(workspace: string | null): McpAttention {
  const agents = useAgentsQuery(workspace, Boolean(workspace))
  const declared = agents.data?.agents?.[0]?.mcp_servers ?? []
  const servers = useMcpServersQuery({ workspace })
  const all = servers.data?.servers ?? []
  const shadowed = (name: string) => all.some((s) => s.project?.name === name)
  const needing = all.filter((s) => (
    s.project
      ? s.enabled && (s.state === 'needs_approval' || s.state === 'auth_required' || s.state === 'error')
      : declared.includes(s.name) && !shadowed(s.name) && s.enabled && (s.state === 'auth_required' || s.state === 'error')
  ))
  if (needing.length === 0) return { names: [], summary: null }
  const label = (s: (typeof needing)[number]) => s.project?.name ?? s.name
  const reason = (s: (typeof needing)[number]) =>
    s.state === 'needs_approval' ? 'needs approval' : s.state === 'auth_required' ? 'needs sign-in' : 'failed to start'
  const summary = needing.length > 1
    ? `${needing.length} connectors need attention`
    : `${label(needing[0])} ${reason(needing[0])}`
  return { names: needing.map(label), summary }
}
