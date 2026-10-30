/**
 * McpStatusChip — the one mapping from MCP server state to words and a tone.
 *
 * Shared by Settings → MCP servers and the session settings MCP section, so
 * the same server reads the same everywhere. Colour is never the only
 * signal (WCAG 1.4.1): the chip always says the state, and the raw server
 * state (``auth_required``) stays in its tooltip for matching against logs.
 */
import { type ServerStatus } from '@/api/client'
import { Chip, type ChipTone } from '@/components/ui/chip'

export function mcpServerStatus(server: ServerStatus): { label: string; tone: ChipTone } {
  if (!server.enabled) return { label: 'Off', tone: 'neutral' }
  if (server.state === 'auth_required') return { label: 'Needs sign-in', tone: 'warning' }
  if (server.state === 'ready') {
    const count = server.tool_names.length
    return { label: count > 0 ? `Ready · ${count} ${count === 1 ? 'tool' : 'tools'}` : 'Ready', tone: 'success' }
  }
  if (server.state === 'starting') return { label: 'Starting…', tone: 'info' }
  if (server.state === 'error') return { label: 'Error', tone: 'error' }
  return { label: 'Stopped', tone: 'neutral' }
}

export function McpStatusChip({ server }: { server: ServerStatus }) {
  const status = mcpServerStatus(server)
  const raw = server.enabled ? `state: ${server.state}${server.state === 'error' && server.error ? ` · ${server.error}` : ''}` : undefined
  return <Chip tone={status.tone} title={raw}>{status.label}</Chip>
}
