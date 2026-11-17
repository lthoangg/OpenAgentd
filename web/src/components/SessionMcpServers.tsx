/**
 * SessionMcpServers — the current session's connectors (MCP servers), one
 * row each. The screen says "Connectors"; the code keeps the protocol's name.
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
 *
 * With a workspace, the project's own servers (its `.agents/mcp.json`) are
 * listed too, by their name in the project. They run only once the user
 * approves them (Allow), so their row offers Allow or Revoke instead of a
 * switch; one replaces the agent's server of the same name here.
 */
import type { ServerStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { McpStatusChip } from '@/components/McpStatusChip'
import { PanelSection } from '@/components/ui/panel-section'
import { COMPACT_ROW, TEXT } from '@/components/ui/panel-tokens'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import {
  useApproveMcpServerMutation,
  useConnectMcpOAuthMutation,
  useMcpServersQuery,
  useRevokeMcpServerMutation,
  useUpdateMcpServerMutation,
} from '@/queries/useMcpQuery'
import { useSettingsStore } from '@/stores/useSettingsStore'

/**
 * The one action a row offers besides its switch: sign in when the server asks
 * for it, reconnect when it failed. Sign in is for any URL server (the server
 * finds out on its own how to sign in, so no oauth block is needed, and plugin
 * servers count). Reconnect stays for URL servers with an oauth block. Only
 * while the server is on (an off server has nothing to connect).
 * Re-authorizing a server that works lives in Settings › Connectors.
 */
function isUrlServer(server: ServerStatus): boolean {
  return server.transport === 'http' || server.transport === 'sse'
}

function hasOAuthBlock(server: ServerStatus): boolean {
  const config = server.config
  return !!config && config.transport !== 'stdio' && !!config.oauth
}

function rowAction(server: ServerStatus): string | null {
  if (!server.enabled || !isUrlServer(server)) return null
  if (server.state === 'auth_required') return 'Sign in'
  if (server.state === 'error' && hasOAuthBlock(server)) return 'Reconnect'
  return null
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
        <span className={cn('min-w-0 flex-1 truncate font-mono', TEXT.label)}>{name}</span>
        <Chip tone="warning" title="The agent lists this connector, but mcp.json does not define it.">Not configured</Chip>
      </li>
    )
  }

  // A plugin's server is the plugin's to switch: its bundle owns the config.
  const toggleable = !!server.config && !busy && !server.plugin
  const action = rowAction(server)

  return (
    <li
      aria-label={name}
      aria-busy={busy || undefined}
      className={cn(COMPACT_ROW, 'min-h-12 flex-wrap')}
    >
      <span className={cn('min-w-0 flex-1 truncate font-mono', TEXT.label)}>
        {name}
      </span>
      <McpStatusChip server={server} />
      {action && (
        <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => onConnect(server)}>
          {action}
        </Button>
      )}
      <Switch
        checked={server.enabled}
        disabled={!toggleable}
        onCheckedChange={() => onToggle(server)}
        aria-label={name}
        title={server.plugin ? `From the plugin ${server.plugin}. Turn it on or off in Plugins.` : 'On or off for every session'}
      />
      {server.error && server.state !== 'auth_required' && (
        <p className="w-full text-meta leading-relaxed text-(--color-error)">{server.error}</p>
      )}
    </li>
  )
}

/** A server the project ships: Allow it to run, or Revoke that. */
function ProjectServerRow({
  server,
  busy,
  onApprove,
  onRevoke,
  onConnect,
}: {
  server: ServerStatus
  busy: boolean
  onApprove: (server: ServerStatus) => void
  onRevoke: (server: ServerStatus) => void
  onConnect: (server: ServerStatus) => void
}) {
  const name = server.project?.name ?? server.name
  const waiting = server.state === 'needs_approval'
  const action = waiting ? null : rowAction(server)
  return (
    <li aria-label={name} aria-busy={busy || undefined} className={cn(COMPACT_ROW, 'min-h-12 flex-wrap')}>
      {/* Room for the name before the chips wrap to the next line. */}
      <span className={cn('min-w-24 flex-1 truncate font-mono', TEXT.label)}>{name}</span>
      <Chip title={`From this project's .agents/mcp.json. It runs in this workspace only, once you allow it.`}>from this project</Chip>
      <McpStatusChip server={server} />
      {action && (
        <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => onConnect(server)}>
          {action}
        </Button>
      )}
      {waiting ? (
        <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => onApprove(server)}
          title="Let it run in this workspace, as its entry is now">
          Allow
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onRevoke(server)}
          title="Stop it; it asks again before it runs">
          Revoke
        </Button>
      )}
      {server.error && server.state !== 'auth_required' && (
        <p className="w-full text-meta leading-relaxed text-(--color-error)">{server.error}</p>
      )}
    </li>
  )
}

export interface SessionMcpServersProps {
  /** MCP server names the current agent declares. */
  agentServers: string[]
  /** The session's workspace: its project's servers are listed too. */
  workspace?: string | null
  /** Called after a server's tool set may have changed, so the caller can
   *  refresh the agent payload that the tool names are derived from. */
  onServersChanged?: () => void
  /**
   * ``menu`` sits inside the composer's "+" menu: a plain heading and rows,
   * no card around them (a card inside a popover would be a second frame).
   */
  variant?: 'section' | 'menu'
}

export function SessionMcpServers({ agentServers, workspace = null, onServersChanged, variant = 'section' }: SessionMcpServersProps) {
  const openSettings = useSettingsStore((s) => s.openSettings)
  // Poll here (and only here) so a server enabled from this panel visibly
  // moves starting → ready without a reopen.
  const { data, isLoading, isError, refetch } = useMcpServersQuery({ pollWhileStarting: true, workspace })
  const updateServer = useUpdateMcpServerMutation()
  const connectOAuth = useConnectMcpOAuthMutation()
  const approve = useApproveMcpServerMutation()
  const revoke = useRevokeMcpServerMutation()

  const all = data?.servers ?? []
  const projectServers = all.filter((s) => s.project)
  const statuses = new Map(all.filter((s) => !s.project).map((s) => [s.name, s]))
  // A project's server takes the place of the agent's server of its name.
  const shown = agentServers.filter((name) => !projectServers.some((s) => s.project?.name === name))

  // Only the row being mutated goes busy — a whole-section freeze would make
  // toggling one server feel like it broke the others.
  const busyServer = updateServer.isPending
    ? updateServer.variables.name
    : connectOAuth.isPending
      ? connectOAuth.variables
      : approve.isPending
        ? approve.variables
        : revoke.isPending
          ? revoke.variables
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

  const approveServer = (server: ServerStatus) => {
    approve.mutate(server.name, { onSettled: () => onServersChanged?.() })
  }

  const revokeServer = (server: ServerStatus) => {
    revoke.mutate(server.name, { onSettled: () => onServersChanged?.() })
  }

  const hasServers = shown.length > 0 || projectServers.length > 0
  // Without servers of its own the agent may still get some from the
  // project: wait for the list before saying there are none.
  const waitingForProject = !!workspace && isLoading && agentServers.length === 0
  const projectError = data?.project_error ?? null

  const manage = (
    <Button type="button" variant="ghost" size="sm" onClick={() => openSettings('connectors')}>
      Manage
    </Button>
  )

  const body = (
    <>
      {projectError && (
        <div className={variant === 'menu' ? 'px-2 py-2' : 'p-3'}>
          <Callout tone="error" title="This project's connectors can't load">
            <span className="font-mono break-words">{projectError}</span>
          </Callout>
        </div>
      )}
      {waitingForProject ? null : !hasServers ? (
        <p className={cn(variant === 'menu' ? 'px-2 py-2' : 'px-4 py-4', TEXT.body)}>
          No connectors for this agent. Add one under Manage, then list it in the
          agent's config.
        </p>
      ) : isLoading ? (
        // Skeleton mirrors the real row geometry so the section doesn't resize
        // when data lands.
        <div
          role="status"
          aria-label="Loading connectors"
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
            Couldn't load connectors.
          </Callout>
        </div>
      ) : (
        <ul className={variant === 'menu' ? '' : 'divide-y divide-(--color-border-subtle)'}>
          {shown.map((name) => (
            <ServerRow
              key={name}
              name={name}
              server={statuses.get(name)}
              busy={busyServer === name}
              onToggle={toggle}
              onConnect={connect}
            />
          ))}
          {projectServers.map((server) => (
            <ProjectServerRow
              key={server.name}
              server={server}
              busy={busyServer === server.name}
              onApprove={approveServer}
              onRevoke={revokeServer}
              onConnect={connect}
            />
          ))}
        </ul>
      )}
    </>
  )

  if (variant === 'menu') {
    return (
      <section aria-label="Connectors" data-mcp-servers="">
        <div className="flex items-center justify-between gap-2 pl-2">
          <h3 className="text-meta font-medium text-(--color-text-muted)">Connectors</h3>
          {manage}
        </div>
        {body}
      </section>
    )
  }

  return (
    <PanelSection title="Connectors" flush actions={manage}>
      {body}
    </PanelSection>
  )
}
