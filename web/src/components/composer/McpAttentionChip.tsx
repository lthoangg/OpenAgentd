/**
 * McpAttentionChip — on the run deck only while one of the agent's MCP
 * servers needs the user (sign in, or it failed). A click opens the "+" menu
 * at its MCP section. Servers that work stay out of sight.
 */
import { Plug } from 'lucide-react'

import { useMcpServersQuery } from '@/queries/useMcpQuery'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { useUIStore } from '@/stores/useUIStore'

export function McpAttentionChip({ workspace }: { workspace: string | null }) {
  const agents = useAgentsQuery(workspace, Boolean(workspace))
  const declared = agents.data?.agents?.[0]?.mcp_servers ?? []
  const servers = useMcpServersQuery()
  const needing = (servers.data?.servers ?? []).filter((s) => (
    declared.includes(s.name) && s.enabled && (s.state === 'auth_required' || s.state === 'error')
  ))
  if (needing.length === 0) return null
  const signIn = needing.some((s) => s.state === 'auth_required')
  const text = needing.length > 1 ? `${needing.length} MCP servers` : `${needing[0].name}: ${signIn ? 'Sign in' : 'Error'}`
  return (
    <button
      type="button"
      onClick={() => useUIStore.getState().openPlusMenu('mcp')}
      aria-label={`${text}. Open MCP servers`}
      data-mcp-attention=""
      className="flex h-6 min-w-0 shrink items-center gap-1 rounded-sm bg-(--accent-orange-soft) px-1.5 text-meta font-medium text-(--accent-orange-text) transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9"
    >
      <Plug size={11} aria-hidden="true" className="shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  )
}
