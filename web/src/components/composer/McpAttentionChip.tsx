/**
 * McpAttentionChip — on the run deck only while one of the agent's MCP
 * servers needs the user (sign in, or it failed). A click opens the "+" menu
 * at its MCP section. Servers that work stay out of sight. On a deck under
 * 640px (a phone, or a chat beside the Review panel) it is the plug alone,
 * square, a full touch target on touch: a truncated "sla…" said nothing and
 * took the run chip's room. Its name and tooltip still say which server and
 * what it needs.
 */
import { Plug } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
    <Tooltip className="flex min-w-0 shrink @max-[640px]:shrink-0">
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => useUIStore.getState().openPlusMenu('mcp')}
            aria-label={`${text}. Open MCP servers`}
            data-mcp-attention=""
            className="flex h-6 min-w-0 shrink items-center gap-1 rounded-sm bg-(--accent-orange-soft) px-1.5 text-meta font-medium text-(--accent-orange-text) transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9 @max-[640px]:w-6 @max-[640px]:shrink-0 @max-[640px]:justify-center @max-[640px]:px-0 pointer-coarse:@max-[640px]:w-9"
          >
            <Plug size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate @max-[640px]:hidden">{text}</span>
          </button>
        }
      />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}
