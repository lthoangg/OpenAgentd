/**
 * SessionMcpServers — MCP servers for the current session, one row each.
 *
 * Scope is deliberately narrow: is this server connected, and turn it on or
 * off. It replaced a full tool browser (searchable list of every tool with
 * markdown descriptions) that surfaced information nobody acted on while
 * burying the two controls people actually use.
 *
 * Rows come from the current agent's declared `mcp_servers` (agent frontmatter),
 * intersected with live status from `/mcp/servers`. Declaration is config, not
 * runtime state, so disabling a server keeps its row in place and you can
 * always switch it back on. Globally configured servers the agent doesn't
 * declare aren't part of this session and aren't listed; the Settings link
 * covers them.
 */
import { Plug } from 'lucide-react'

import type { ServerStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW, TEXT } from '@/components/ui/panel-tokens'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { McpStatusDot } from './McpStatusDot'
import {
  useConnectMcpOAuthMutation,
  useMcpServersQuery,
  useUpdateMcpServerMutation,
} from '@/queries/useMcpQuery'
import { useSettingsStore } from '@/stores/useSettingsStore'

/** Human-readable status. `auth_required` is phrased as an instruction because
 *  that's the one state with an action attached. */
function statusLabel(server: ServerStatus): string {
  if (!server.enabled) return 'Disabled'
  if (server.state === 'auth_required') return 'Connect required'
  if (server.state === 'ready') return 'Ready'
  if (server.state === 'starting') return 'Starting…'
  if (server.state === 'error') return 'Error'
  return 'Stopped'
}

function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}

/**
 * OAuth connect applies to any HTTP server configured with an oauth block, not
 * just one currently reporting `auth_required`: re-authorizing a ready server
 * (expired grant, changed scopes) and retrying a failed one are both on-demand
 * actions. Gating on `auth_required` strands those cases with no way to
 * re-trigger the flow.
 */
function supportsOAuthConnect(server: ServerStatus): boolean {
  return (
    server.transport === 'http' &&
    server.config?.transport === 'http' &&
    !!server.config.oauth
  )
}

function ServerRow({
  name,
  server,
  busy,
  onToggle,
  onConnect,
}: {
  name: string
  server: ServerStatus | undefined
  busy: boolean
  onToggle: (server: ServerStatus) => void
  onConnect: (server: ServerStatus) => void
}) {
  // Declared by the agent but absent from mcp.json — surface it rather than
  // silently dropping the row, otherwise the agent looks misconfigured for no
  // visible reason.
  if (!server) {
    return (
      <li
        aria-label={name}
        className={cn(COMPACT_ROW, 'min-h-12')}
      >
        <Plug size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', TEXT.label)}>{name}</span>
        <span className={TEXT.hint}>Not configured</span>
      </li>
    )
  }

  const toggleable = !!server.config && !busy

  return (
    <li
      aria-label={name}
      aria-busy={busy || undefined}
      className={cn(COMPACT_ROW, 'min-h-12 flex-wrap')}
    >
      <McpStatusDot server={server} />
      <span className={cn('min-w-0 flex-1 truncate', TEXT.label)}>
        {name}
      </span>
      <span className={TEXT.hint}>
        {statusLabel(server)}
        {server.enabled && server.tool_names.length > 0 && (
          <> · {toolCountLabel(server.tool_names.length)}</>
        )}
      </span>
      {supportsOAuthConnect(server) && (
        <Button
          type="button"
          variant="default"
          size="sm"
          // Nothing to authorize while the server is off.
          disabled={!server.enabled || busy}
          onClick={() => onConnect(server)}
        >
          {server.state === 'auth_required' ? 'Connect' : 'Reconnect'}
        </Button>
      )}
      <Switch
        checked={server.enabled}
        disabled={!toggleable}
        onCheckedChange={() => onToggle(server)}
        aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${name}`}
      />
      {server.error && server.state !== 'auth_required' && (
        <p className="w-full text-[11px] leading-relaxed text-(--color-error)">{server.error}</p>
      )}
    </li>
  )
}

export interface SessionMcpServersProps {
  /** MCP server names the current agent declares. */
  agentServers: string[]
  /** Called after a server's tool set may have changed, so the caller can
   *  refresh the agent payload that the tool names are derived from. */
  onServersChanged?: () => void
}

export function SessionMcpServers({ agentServers, onServersChanged }: SessionMcpServersProps) {
  const openSettings = useSettingsStore((s) => s.openSettings)
  // Poll here (and only here) so a server enabled from this panel visibly
  // moves starting → ready without a reopen.
  const { data, isLoading, isError, refetch } = useMcpServersQuery({ pollWhileStarting: true })
  const updateServer = useUpdateMcpServerMutation()
  const connectOAuth = useConnectMcpOAuthMutation()

  const statuses = new Map((data?.servers ?? []).map((s) => [s.name, s]))

  // Only the row being mutated goes busy — a whole-section freeze would make
  // toggling one server feel like it broke the others.
  const busyServer = updateServer.isPending
    ? updateServer.variables.name
    : connectOAuth.isPending
      ? connectOAuth.variables
      : null

  const toggle = (server: ServerStatus) => {
    if (!server.config) return
    updateServer.mutate(
      { name: server.name, server: { ...server.config, enabled: !server.enabled } },
      { onSettled: () => onServersChanged?.() },
    )
  }

  const connect = (server: ServerStatus) => {
    connectOAuth.mutate(server.name, { onSettled: () => onServersChanged?.() })
  }

  const hasServers = agentServers.length > 0

  return (
    <PanelSection
      title="MCP servers"
      flush
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={() => openSettings('mcp')}>
          Manage
        </Button>
      }
    >
      {!hasServers ? (
        <p className={cn('px-4 py-4', TEXT.body)}>
          No MCP servers for this agent. Add one under Manage, then list it in the
          agent's config.
        </p>
      ) : isLoading ? (
        // Skeleton mirrors the real row geometry so the section doesn't resize
        // when data lands.
        <div
          role="status"
          aria-label="Loading MCP servers"
          className="space-y-2 px-4 py-3"
        >
          {agentServers.map((name) => (
            <Skeleton key={name} className="h-9 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="p-3">
          <Callout
            tone="error"
            action={
              <Button type="button" variant="default" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            }
          >
            Couldn't load MCP servers.
          </Callout>
        </div>
      ) : (
        <ul className="divide-y divide-(--color-border-subtle)">
          {agentServers.map((name) => (
            <ServerRow
              key={name}
              name={name}
              server={statuses.get(name)}
              busy={busyServer === name}
              onToggle={toggle}
              onConnect={connect}
            />
          ))}
        </ul>
      )}
    </PanelSection>
  )
}
