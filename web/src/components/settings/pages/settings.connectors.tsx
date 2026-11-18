/**
 * Settings → Connectors: your connectors first, each with its status, its
 * switch and the one action it needs; then the gallery of ready-made ones
 * not added yet. One search box filters both.
 */
import { Plug, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { GalleryEntry, ServerStatus } from '@/api/client'
import { ConnectorIcon } from '@/components/ConnectorIcon'
import { McpStatusChip } from '@/components/McpStatusChip'
import { ConnectorGallery, galleryToAdd, matchesQuery } from '@/components/settings/ConnectorGallery'
import { ConnectorSignInsProvider, useConnectorSignIns } from '@/components/settings/connectorSignIns'
import { McpSignInWaiting } from '@/components/settings/McpSignInWaiting'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchBar } from '@/components/ui/search-bar'
import { SectionCard } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useIsPhone } from '@/hooks/use-is-phone'
import { openSignInWindow } from '@/lib/mcp-sign-in'
import { cn } from '@/lib/utils'
import { useMcpServersQuery } from '@/queries'
import { useConnectorGalleryQuery, useUpdateMcpServerMutation } from '@/queries/useMcpQuery'
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

function ConnectorRow({ srv, entry, active, onOpen }: { srv: ServerStatus; entry?: GalleryEntry; active: boolean; onOpen: () => void }) {
  const push = useToastStore((s) => s.push)
  const signIns = useConnectorSignIns()
  const toggle = useUpdateMcpServerMutation()
  const { title, mono } = titleOf(srv)
  const waiting = signIns.waiting(srv.name)
  // A plugin's or a project's connector is switched where it comes from.
  const switchable = !!srv.config && !srv.plugin && !srv.project
  const isUrl = srv.transport !== 'stdio'
  const badge = srv.plugin ? `from ${srv.plugin}` : srv.project ? 'from this project' : null
  const description = entry?.description ?? (isUrl ? 'A web address' : 'A program on this computer')

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
          <span className={cn(TEXT.subtle, 'block truncate')}>{description}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-2 max-sm:ml-10">
        <McpStatusChip server={srv} />
        {!waiting && srv.enabled && isUrl && srv.state === 'auth_required' && (
          <Button size="xs" variant="default" onClick={connect}>Connect</Button>
        )}
        {switchable && (
          <Switch
            aria-label={`${srv.enabled ? 'Turn off' : 'Turn on'} ${title}`}
            checked={srv.enabled}
            disabled={toggle.isPending}
            onCheckedChange={setOn}
          />
        )}
      </span>
      {waiting && <McpSignInWaiting className="basis-full pl-10" onCancel={() => signIns.cancel(srv.name)} />}
    </li>
  )
}

function ConnectorsPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  // The open workspace's project servers (its `.agents/mcp.json`) list here too.
  const workspace = useAgentStore((s) => s._workspace)
  const { data, isLoading, isError, error, refetch } = useMcpServersQuery({ workspace })
  const gallery = useConnectorGalleryQuery()
  const isPhone = useIsPhone()
  const [query, setQuery] = useState('')

  const servers = useMemo(() => data?.servers ?? [], [data])
  const entries = useMemo(() => new Map((gallery.data?.entries ?? []).map((e) => [e.id, e])), [gallery.data])
  const shown = useMemo(
    () => servers.filter((s) => matchesQuery(query, titleOf(s).title, s.name, s.plugin, entries.get(s.gallery?.id ?? '')?.description)),
    [servers, query, entries],
  )
  const galleryHits = useMemo(
    () => galleryToAdd(gallery.data?.entries ?? []).filter((e) => matchesQuery(query, e.name, e.description)).length,
    [gallery.data, query],
  )
  const galleryGone = gallery.isError || (!gallery.isLoading && galleryToAdd(gallery.data?.entries ?? []).length === 0)

  const newButton = (
    <Button size="sm" onClick={onNew}>
      <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
      Add your own
    </Button>
  )

  return (
    <SettingsPage
      title="Connectors"
      description="Outside tools and services your agents can use, such as Notion, Slack or GitHub."
      actions={newButton}
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
            action={<Button size="xs" onClick={() => void refetch()}>Retry</Button>}
          >
            {error instanceof Error ? error.message : 'Check the server connection, then try again.'}
          </Callout>
        ) : servers.length === 0 ? (
          galleryGone && (
            <SectionCard className="border-dashed">
              <EmptyState
                fill={false}
                className="px-6 py-10"
                icon={Plug}
                title="No connectors yet"
                body="Add your own: most need only a web address and a sign-in."
                action={newButton}
              />
            </SectionCard>
          )
        ) : (
          shown.length > 0 && (
            <section aria-labelledby="your-connectors-title" className="space-y-3">
              <div className="flex items-baseline gap-2">
                <h2 id="your-connectors-title" className={TEXT.title}>Your connectors</h2>
                <span className={TEXT.subtle}>{servers.length}</span>
              </div>
              <SectionCard>
                <ul className="divide-y divide-(--color-border-subtle)">
                  {shown.map((srv) => (
                    <ConnectorRow
                      key={srv.name}
                      srv={srv}
                      entry={srv.gallery ? entries.get(srv.gallery.id) : undefined}
                      active={selectedName === srv.name}
                      onOpen={() => onSelect(srv.name)}
                    />
                  ))}
                </ul>
              </SectionCard>
            </section>
          )
        )}

        <ConnectorGallery query={query} />

        {query.trim() && shown.length === 0 && galleryHits === 0 && !isLoading && (
          <p className={cn(TEXT.hint, 'py-6 text-center')}>No connectors match &ldquo;{query}&rdquo;.</p>
        )}
      </div>
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
