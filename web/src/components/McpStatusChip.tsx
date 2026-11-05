/**
 * McpStatusChip — the one mapping from MCP server state to words and a tone.
 *
 * Shared by Settings → MCP servers and the session settings MCP section, so
 * the same server reads the same everywhere. Colour is never the only
 * signal (WCAG 1.4.1): the chip always says the state, and the raw server
 * state (``auth_required``) stays in its tooltip for matching against logs.
 */
import { type ServerStatus } from '@/api/client'
import { Chip } from '@/components/ui/chip'
import { STATUS, type StatusView } from '@/lib/status'

export function mcpServerStatus(server: ServerStatus): StatusView {
  if (!server.enabled) return STATUS.off
  if (server.state === 'auth_required') return STATUS.needsSignIn
  if (server.state === 'ready') {
    const count = server.tool_names.length
    return count > 0 ? { ...STATUS.ready, label: `Ready · ${count} ${count === 1 ? 'tool' : 'tools'}` } : STATUS.ready
  }
  if (server.state === 'starting') return STATUS.starting
  if (server.state === 'error') return STATUS.error
  return STATUS.stopped
}

export function McpStatusChip({ server }: { server: ServerStatus }) {
  const status = mcpServerStatus(server)
  const raw = server.enabled ? `state: ${server.state}${server.state === 'error' && server.error ? ` · ${server.error}` : ''}` : undefined
  return <Chip tone={status.tone} spinner={status.spinner} title={raw}>{status.label}</Chip>
}
