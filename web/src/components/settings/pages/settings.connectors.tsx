/**
 * Settings → Connectors: the services you connected from the gallery first,
 * then the MCP servers you added yourself (each with what it runs), each row
 * with its status, its switch, the one action it needs and a "⋯" menu; then
 * the gallery of ready-made ones not added yet. One search box filters all.
 * The split is by address only (`gallery` on the server): `mcp.json` holds
 * both kinds alike.
 */
import { MoreHorizontal, Plus, Settings2, Trash2, Unplug } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import type { GalleryEntry, ServerStatus } from '@/api/client'
import { ConnectorIcon } from '@/components/ConnectorIcon'
import { McpStatusChip } from '@/components/McpStatusChip'
import { ConnectorGallery, galleryToAdd, matchesQuery } from '@/components/settings/ConnectorGallery'
import { ConnectorSignInsProvider, useConnectorSignIns } from '@/components/settings/connectorSignIns'
import { McpSignInWaiting } from '@/components/settings/McpSignInWaiting'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { SearchBar } from '@/components/ui/search-bar'
import { SectionCard } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { openSignInWindow } from '@/lib/mcp-sign-in'
import { cn } from '@/lib/utils'
import { useMcpServersQuery } from '@/queries'
import { useConnectorGalleryQuery, useDeleteMcpServerMutation, useUpdateMcpServerMutation } from '@/queries/useMcpQuery'
import { useAgentStore } from '@/stores/useAgentStore'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'

interface McpListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

/** What a row calls the connector: the service's name, else its name in the project or `mcp.json`. */
function titleOf(srv: ServerStatus): { title: string; mono: boolean } {
  if (srv.gallery) return { title: srv.gallery.name, mono: false }
  return { title: srv.project?.name ?? srv.name, mono: true }
}

/**
 * What an MCP server runs: its command line, or the host it talks to. Never
 * `env` or `headers`, which can hold keys.
 */
export function serverTarget(srv: ServerStatus): string | null {
  const cfg = srv.config
  if (!cfg) return null
  if (cfg.transport === 'stdio') return [cfg.command, ...cfg.args].join(' ')
  try {
    return new URL(cfg.url).host
  } catch {
    return cfg.url
  }
}

/** A row the user owns (in `mcp.json`): a plugin's or a project's is managed where it comes from. */
const ownedByUser = (srv: ServerStatus) => !!srv.config && !srv.plugin && !srv.project

/** "⋯" on a row: Open settings, and Remove (an MCP server) or Disconnect (a connector). */
function RowMenu({ title, connector, onOpen, onRemove }: { title: string; connector: boolean; onOpen: () => void; onRemove: () => void }) {
  const touch = useTouchFirst()
  const [sheetOpen, setSheetOpen] = useState(false)
  const removeLabel = connector ? 'Disconnect…' : 'Remove…'
  const label = `More actions for ${title}`
  if (touch) {
    const items: ActionSheetItem[] = [
      { id: 'open', label: 'Open settings', icon: Settings2, run: onOpen },
      // The confirm opens once the sheet has slid away, so two overlays never cross.
      { id: 'remove', label: removeLabel, icon: connector ? Unplug : Trash2, danger: true, separatorBefore: true, afterClose: true, run: onRemove },
    ]
    return (
      <>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={label} className="touch-hit relative text-(--color-text-muted)" onClick={() => setSheetOpen(true)}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
        <ActionSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={title} items={items} />
      </>
    )
  }
  return (
    <Dropdown
      aria-label={label}
      trigger={<MoreHorizontal size={14} aria-hidden="true" />}
      align="end"
      className="h-7 min-w-0 gap-1 bg-transparent px-1.5 text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
    >
      <DropdownItem onSelect={onOpen}>Open settings</DropdownItem>
      <DropdownItem className="text-(--color-error)" onSelect={onRemove}>{removeLabel}</DropdownItem>
    </Dropdown>
  )
}

function ConnectorRow({ srv, entry, active, onOpen, onRemove }: { srv: ServerStatus; entry?: GalleryEntry; active: boolean; onOpen: () => void; onRemove: () => void }) {
  const push = useToastStore((s) => s.push)
  const signIns = useConnectorSignIns()
  const toggle = useUpdateMcpServerMutation()
  const { title, mono } = titleOf(srv)
  const waiting = signIns.waiting(srv.name)
  // A plugin's or a project's connector is switched where it comes from.
  const owned = ownedByUser(srv)
  const isUrl = srv.transport !== 'stdio'
  const badge = srv.plugin ? `from ${srv.plugin}` : srv.project ? 'from this project' : null
  // A connector says what the service does; an MCP server, what it runs.
  const target = srv.gallery ? null : serverTarget(srv)
  const description = entry?.description ?? target ?? (isUrl ? 'A web address' : 'A program on this computer')

  const setOn = (on: boolean) => {
    if (!srv.config) return
    toggle.mutate(
      { name: srv.name, server: { ...srv.config, enabled: on } },
      { onError: (err) => push({ tone: 'error', title: `Couldn't turn ${on ? 'on' : 'off'} ${title}`, description: errorMessage(err) }) },
    )
  }
  const connect = () => void signIns.run(title, openSignInWindow(), async () => srv)

  return (
    <li aria-label={title} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5" data-server={srv.name}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={cn(
          '-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-sm p-1 text-left max-sm:basis-full',
          'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40',
          'focus-visible:outline-2 focus-visible:outline-(--focus-ring)',
          active && 'bg-(--bg-key)/60',
        )}
      >
        <ConnectorIcon name={title} icon={srv.gallery?.icon} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn(TEXT.label, 'truncate', mono && 'font-mono')}>{title}</span>
            {badge && <Chip>{badge}</Chip>}
          </span>
          <span className={cn(TEXT.subtle, 'block truncate', target && 'font-mono')} title={target ?? undefined}>{description}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-2 max-sm:ml-10">
        <McpStatusChip server={srv} />
        {!waiting && srv.enabled && isUrl && srv.state === 'auth_required' && (
          <Button size="xs" variant="default" onClick={connect}>Connect</Button>
        )}
        {owned && (
          <Switch
            aria-label={`${srv.enabled ? 'Turn off' : 'Turn on'} ${title}`}
            checked={srv.enabled}
            disabled={toggle.isPending}
            onCheckedChange={setOn}
          />
        )}
        {owned && <RowMenu title={title} connector={!!srv.gallery} onOpen={onOpen} onRemove={onRemove} />}
      </span>
      {waiting && <McpSignInWaiting className="basis-full pl-10" onCancel={() => signIns.cancel(srv.name)} />}
    </li>
  )
}

/** One group of rows under its heading: hidden when it has none to show. */
function RowGroup({ id, title, count, action, children }: { id: string; title: string; count: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 id={id} className={TEXT.title}>{title}</h2>
        {count > 0 && <span className={TEXT.subtle}>{count}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  )
}

function ConnectorsPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  // The open workspace's project servers (its `.agents/mcp.json`) list here too.
  const workspace = useAgentStore((s) => s._workspace)
  const { data, isLoading, isError, error, refetch } = useMcpServersQuery({ workspace })
  const gallery = useConnectorGalleryQuery()
  const remove = useDeleteMcpServerMutation()
  const push = useToastStore((s) => s.push)
  const isPhone = useIsPhone()
  const [query, setQuery] = useState('')
  const [removing, setRemoving] = useState<ServerStatus | null>(null)

  const servers = useMemo(() => data?.servers ?? [], [data])
  const entries = useMemo(() => new Map((gallery.data?.entries ?? []).map((e) => [e.id, e])), [gallery.data])
  const shown = useMemo(
    () => servers.filter((s) => matchesQuery(query, titleOf(s).title, s.name, s.plugin, entries.get(s.gallery?.id ?? '')?.description, s.gallery ? null : serverTarget(s))),
    [servers, query, entries],
  )
  const connectors = shown.filter((s) => s.gallery)
  const mcpServers = shown.filter((s) => !s.gallery)
  const mcpServerCount = servers.filter((s) => !s.gallery).length
  const galleryHits = useMemo(
    () => galleryToAdd(gallery.data?.entries ?? []).filter((e) => matchesQuery(query, e.name, e.description)).length,
    [gallery.data, query],
  )
  const searching = query.trim() !== ''

  const rows = (list: ServerStatus[]) => (
    <SectionCard>
      <ul className="divide-y divide-(--color-border-subtle)">
        {list.map((srv) => (
          <ConnectorRow
            key={srv.name}
            srv={srv}
            entry={srv.gallery ? entries.get(srv.gallery.id) : undefined}
            active={selectedName === srv.name}
            onOpen={() => onSelect(srv.name)}
            onRemove={() => setRemoving(srv)}
          />
        ))}
      </ul>
    </SectionCard>
  )

  // Removing a connector forgets its sign-in too (the server does), and the
  // gallery lists it again: it has no connector at its address any more.
  const confirmRemove = async () => {
    if (!removing) return
    const { title } = titleOf(removing)
    const connector = !!removing.gallery
    try {
      await remove.mutateAsync(removing.name)
      push({ tone: 'success', title: connector ? `Disconnected ${title}` : `Removed ${title}` })
    } catch (err) {
      push({ tone: 'error', title: connector ? `Couldn't disconnect ${title}` : `Couldn't remove ${title}`, description: errorMessage(err) })
    }
  }
  const removingTitle = removing ? titleOf(removing).title : ''
  const removingConnector = !!removing?.gallery

  return (
    <SettingsPage
      title="Connectors"
      description="Outside tools and services your agents can use, such as Notion, Slack or GitHub."
    >
      <div className="space-y-6">
        {/* A phone pins the search while the page scrolls, as Providers does. */}
        <div data-list-filter="" className={cn(isPhone && 'sticky top-0 z-10 -mx-1 bg-(--bg-page) px-1 py-1')}>
          <SearchBar placeholder="Search connectors…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        {isLoading ? (
          <SectionCard role="status" aria-label="Loading connectors">
            <div className="divide-y divide-(--color-border-subtle)">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-3">
                  <Skeleton className="size-8" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              ))}
            </div>
          </SectionCard>
        ) : isError ? (
          <Callout
            tone="error"
            role="alert"
            title="Couldn't load connectors"
            action={<Button size="xs" onClick={() => { void refetch(); void gallery.refetch() }}>Retry</Button>}
          >
            {error instanceof Error ? error.message : 'Check the server connection, then try again.'}
          </Callout>
        ) : (
          <>
            {connectors.length > 0 && (
              <RowGroup id="connectors-title" title="Connectors" count={servers.length - mcpServerCount}>
                {rows(connectors)}
              </RowGroup>
            )}
            {/* Always there, so adding a server of your own has a place, unless a search hides it. */}
            {(mcpServers.length > 0 || !searching) && (
              <RowGroup
                id="mcp-servers-title"
                title="MCP servers"
                count={mcpServerCount}
                action={mcpServers.length > 0 && (
                  <Button size="xs" onClick={onNew}>
                    <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
                    Add server
                  </Button>
                )}
              >
                {mcpServers.length > 0 ? rows(mcpServers) : (
                  <SectionCard className="border-dashed">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                      <span className={TEXT.subtle}>A program on this computer or a web address that speaks MCP.</span>
                      <Button size="xs" onClick={onNew}>
                        <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
                        Add an MCP server
                      </Button>
                    </div>
                  </SectionCard>
                )}
              </RowGroup>
            )}
          </>
        )}

        {/* One error at a time: while the list itself failed to load, its Retry reloads the gallery too. */}
        {!isError && <ConnectorGallery query={query} />}

        {searching && shown.length === 0 && galleryHits === 0 && !isLoading && (
          <p className={cn(TEXT.hint, 'py-6 text-center')}>No connectors match &ldquo;{query}&rdquo;.</p>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null) }}
        title={removingConnector ? `Disconnect ${removingTitle}?` : `Remove “${removingTitle}”?`}
        description={removingConnector
          ? `Its sign-in is forgotten and its tools stop working. ${removingTitle} goes back to “Add a connector”, where you can connect it again.`
          : 'It is removed from mcp.json and its tools stop working.'}
        confirmLabel={removingConnector ? 'Disconnect' : 'Remove'}
        onConfirm={confirmRemove}
      />
    </SettingsPage>
  )
}

export function ConnectorsListPage(props: McpListPageProps) {
  return (
    <ConnectorSignInsProvider>
      <ConnectorsPage {...props} />
    </ConnectorSignInsProvider>
  )
}
