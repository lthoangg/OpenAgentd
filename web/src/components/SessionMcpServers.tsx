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
import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'

import type { ConnectorIconData, ServerStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import type { ChipTone } from '@/components/ui/chip'
import { ConnectorIcon } from '@/components/ConnectorIcon'
import { mcpServerStatus } from '@/components/McpStatusChip'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { PanelSection } from '@/components/ui/panel-section'
import { TEXT } from '@/components/ui/panel-tokens'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { StatusView } from '@/lib/status'
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
  // The word Settings → Connectors uses for the same thing.
  if (server.state === 'auth_required') return 'Connect'
  if (server.state === 'error' && hasOAuthBlock(server)) return 'Reconnect'
  return null
}

const STATUS_TEXT: Record<ChipTone, string> = {
  success: 'text-(--color-text-subtle)',
  neutral: 'text-(--color-text-subtle)',
  info: 'text-(--color-text-subtle)',
  warning: 'text-(--accent-orange-text)',
  error: 'text-(--color-error)',
}
const STATUS_DOT: Record<ChipTone, string> = {
  success: 'bg-(--accent-green-text)',
  neutral: 'bg-(--color-border-strong)',
  info: 'bg-(--color-border-strong)',
  warning: 'bg-(--accent-orange-text)',
  error: 'bg-(--color-error)',
}

/**
 * One connector: its logo, its name, and one quiet status line under it;
 * on the right the one control it needs. A failure is one line here, with
 * the whole message on hover: Settings has room for the rest.
 */
function RowShell({
  title,
  mono,
  icon,
  status,
  detail,
  detailTitle,
  busy,
  menu,
  children,
}: {
  title: string
  mono: boolean
  icon: ConnectorIconData | null | undefined
  status: StatusView
  /** After the status: the source, or why it failed. */
  detail?: string | null
  detailTitle?: string
  busy?: boolean
  menu: boolean
  children?: ReactNode
}) {
  return (
    <li
      aria-label={title}
      aria-busy={busy || undefined}
      className={cn('flex items-center gap-2.5', menu ? 'min-h-11 rounded-xs px-2 py-1.5 phone:min-h-(--phone-control)' : 'min-h-12 px-4 py-2.5')}
    >
      <ConnectorIcon name={title} icon={icon} size="sm" />
      <div className="min-w-0 flex-1">
        <p className={cn(TEXT.label, 'truncate', mono && 'font-mono')}>{title}</p>
        <p className="flex min-w-0 items-center gap-1.5 text-meta leading-snug">
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status.tone])} />
          <span className={cn('shrink-0', STATUS_TEXT[status.tone])}>{status.label}</span>
          {detail && (
            <>
              <span aria-hidden="true" className="text-(--color-text-subtle)">·</span>
              <span className={cn('min-w-0 truncate', status.tone === 'error' ? 'text-(--color-error)' : 'text-(--color-text-subtle)')} title={detailTitle ?? detail}>
                {detail}
              </span>
            </>
          )}
        </p>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </li>
  )
}

/** The failure worth a line: its first line, without a long JSON body. */
function shortError(server: ServerStatus): string | null {
  if (!server.error || server.state === 'auth_required' || !server.enabled) return null
  const first = server.error.split('\n')[0]
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}

function ServerRow({
  name,
  server,
  busy,
  menu,
  onToggle,
  onConnect,
}: {
  name: string
  server: ServerStatus | undefined
  busy: boolean
  menu: boolean
  onToggle: (server: ServerStatus) => void
  onConnect: (server: ServerStatus) => void
}) {
  // Declared by the agent but absent from mcp.json — surface it rather than
  // silently dropping the row, otherwise the agent looks misconfigured for no
  // visible reason.
  if (!server) {
    return (
      <RowShell
        title={name}
        mono
        icon={null}
        menu={menu}
        status={{ label: 'Not configured', tone: 'warning' }}
        detail="the agent lists it, mcp.json does not"
        detailTitle="The agent lists this connector, but mcp.json does not define it."
      />
    )
  }

  // A plugin's server is the plugin's to switch: its bundle owns the config.
  const toggleable = !!server.config && !busy && !server.plugin
  const action = rowAction(server)
  const title = server.gallery?.name ?? name
  const error = shortError(server)

  return (
    <RowShell
      title={title}
      mono={!server.gallery}
      icon={server.gallery?.icon}
      menu={menu}
      busy={busy}
      status={mcpServerStatus(server)}
      detail={error ?? (server.plugin ? `from ${server.plugin}` : null)}
      detailTitle={error ? (server.error ?? undefined) : undefined}
    >
      {action && (
        <Button type="button" variant="default" size="xs" disabled={busy} onClick={() => onConnect(server)}>
          {action}
        </Button>
      )}
      <Switch
        checked={server.enabled}
        disabled={!toggleable}
        onCheckedChange={() => onToggle(server)}
        aria-label={`${server.enabled ? 'Turn off' : 'Turn on'} ${title}`}
        title={server.plugin ? `From the plugin ${server.plugin}. Turn it on or off in Plugins.` : 'On or off for every session'}
      />
    </RowShell>
  )
}

/** A server the project ships: Allow it to run, or Revoke that. */
function ProjectServerRow({
  server,
  busy,
  menu,
  onApprove,
  onRevoke,
  onConnect,
}: {
  server: ServerStatus
  busy: boolean
  menu: boolean
  onApprove: (server: ServerStatus) => void
  onRevoke: (server: ServerStatus) => void
  onConnect: (server: ServerStatus) => void
}) {
  const name = server.project?.name ?? server.name
  const title = server.gallery?.name ?? name
  const waiting = server.state === 'needs_approval'
  const action = waiting ? null : rowAction(server)
  const error = shortError(server)
  return (
    <RowShell
      title={title}
      mono={!server.gallery}
      icon={server.gallery?.icon}
      menu={menu}
      busy={busy}
      status={mcpServerStatus(server)}
      detail={error ?? 'from this project'}
      detailTitle={error ? (server.error ?? undefined) : `From this project's .agents/mcp.json. It runs in this workspace only, once you allow it.`}
    >
      {action && (
        <Button type="button" variant="default" size="xs" disabled={busy} onClick={() => onConnect(server)}>
          {action}
        </Button>
      )}
      {waiting ? (
        <Button type="button" variant="default" size="xs" disabled={busy} onClick={() => onApprove(server)}
          title="Let it run in this workspace, as its entry is now">
          Allow
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => onRevoke(server)}
          title="Stop it; it asks again before it runs">
          Revoke
        </Button>
      )}
    </RowShell>
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
    <Button type="button" variant="ghost" size={variant === 'menu' ? 'xs' : 'sm'} onClick={() => openSettings('connectors')}>
      Manage
    </Button>
  )
  const menu = variant === 'menu'
  const count = shown.length + projectServers.length

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
        <p className={cn(menu ? 'px-2 py-1.5' : 'px-4 py-4', TEXT.body)}>
          No connectors for this agent yet. Add one, then list it in the agent's config.
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
              menu={menu}
              onToggle={toggle}
              onConnect={connect}
            />
          ))}
          {projectServers.map((server) => (
            <ProjectServerRow
              key={server.name}
              server={server}
              busy={busyServer === server.name}
              menu={menu}
              onApprove={approveServer}
              onRevoke={revokeServer}
              onConnect={connect}
            />
          ))}
        </ul>
      )}
    </>
  )

  if (menu) {
    return (
      <section aria-label="Connectors" data-mcp-servers="">
        <div className="flex items-center justify-between gap-2 py-0.5 pl-2">
          <h3 className="text-meta font-medium text-(--color-text-muted)">
            Connectors
            {count > 0 && <span className="ml-1.5 font-normal text-(--color-text-subtle)">{count}</span>}
          </h3>
          {manage}
        </div>
        {body}
        <button type="button" className={cn(MENU_ITEM_CLASS, 'text-(--color-text-muted)')} onClick={() => openSettings('connectors')}>
          <Plus size={14} aria-hidden="true" />
          Add a connector
        </button>
      </section>
    )
  }

  return (
    <PanelSection title="Connectors" flush actions={manage}>
      {body}
    </PanelSection>
  )
}
