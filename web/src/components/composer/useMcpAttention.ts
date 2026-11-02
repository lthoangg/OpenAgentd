/**
 * The agent's MCP servers that need the user: one waiting for sign-in, or
 * one that failed. Servers that work stay out of sight; these mark the
 * composer's "+" (where MCP lives) with a dot.
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
  const servers = useMcpServersQuery()
  const needing = (servers.data?.servers ?? []).filter((s) => (
    declared.includes(s.name) && s.enabled && (s.state === 'auth_required' || s.state === 'error')
  ))
  if (needing.length === 0) return { names: [], summary: null }
  const signIn = needing.some((s) => s.state === 'auth_required')
  const summary = needing.length > 1
    ? `${needing.length} MCP servers need attention`
    : `${needing[0].name} ${signIn ? 'needs sign-in' : 'failed to start'}`
  return { names: needing.map((s) => s.name), summary }
}
