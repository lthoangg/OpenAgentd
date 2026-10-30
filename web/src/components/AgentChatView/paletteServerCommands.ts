/**
 * The command palette's Switch Server…: the builtin sidecar and every saved
 * server, each connecting this window on Enter.
 *
 * Pure so the list is testable from plain data; ``usePaletteServerCommands``
 * supplies the status and each server's health, and wires the handlers to the
 * same connect code Settings → Connection uses.
 */
import type { AppBackendStatus, SavedAppServer } from '@/lib/app-backend'
import { normalizeServerBaseUrl } from '@/lib/backend-switch'
import type { Command } from '../CommandPalette'

export const SERVER_COMMAND_ID = 'switch-server'

export type ServerHealth = 'checking' | 'online' | 'offline'

export interface ServerCommandsInput {
  /** ``null`` outside the desktop shell: there is nothing to switch. */
  status: AppBackendStatus | null
  /** Per server, by normalized base URL. */
  health: Record<string, ServerHealth>
}

export interface ServerCommandHandlers {
  useBundled: () => void
  useExternal: (server: SavedAppServer) => void
  /** Opens Settings → Connection to add, edit or remove servers. */
  manage: () => void
  /** The page opened: check every saved server. */
  checkHealth: () => void
}

const HEALTH_LABEL: Record<ServerHealth, string> = {
  checking: 'Checking…',
  online: 'Online',
  offline: 'Offline',
}

export function buildServerCommands(input: ServerCommandsInput, handlers: ServerCommandHandlers): Command[] {
  const { status, health } = input
  if (!status) return []
  const onExternal = status.mode === 'external' || status.external
  const currentBase = normalizeServerBaseUrl(status.base_url)

  const rows: Command[] = []
  if (status.supports_bundled !== false) {
    const current = !onExternal
    rows.push({
      id: 'server:bundled',
      label: 'Built-in Server',
      description: current
        ? 'Current · runs inside this app'
        : status.sidecar_running
          ? 'Runs inside this app'
          : 'Stopped · starts when selected',
      keywords: 'builtin bundled local sidecar',
      // Already on it: nothing to do (selecting just closes the palette).
      action: current ? () => {} : handlers.useBundled,
    })
  }
  for (const server of status.servers) {
    const base = normalizeServerBaseUrl(server.base_url)
    const current = onExternal && base === currentBase
    const state = HEALTH_LABEL[health[base] ?? 'checking']
    rows.push({
      id: `server:${base}`,
      label: server.name?.trim() || base,
      description: `${current ? 'Current · ' : ''}${server.name?.trim() ? `${base} · ` : ''}${state}`,
      keywords: `remote saved ${base}`,
      action: current ? () => {} : () => handlers.useExternal(server),
    })
  }
  rows.push({
    id: 'server:manage',
    label: 'Add or manage servers…',
    description: 'Settings → Connection',
    keywords: 'add edit remove new',
    browseOnly: true,
    action: handlers.manage,
  })

  return [{
    id: SERVER_COMMAND_ID,
    group: 'Navigation',
    label: 'Switch Server…',
    description: 'Connect to the built-in server or a saved remote server',
    keywords: 'backend remote builtin sidecar connection connect',
    page: { placeholder: 'Search servers…', commands: rows },
    onOpenPage: handlers.checkHealth,
    action: () => {},
  }]
}
