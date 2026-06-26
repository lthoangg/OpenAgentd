import { AlertCircle, Plug } from 'lucide-react'
import { useMemo } from 'react'

import { type ServerStatus } from '@/api/client'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { cn } from '@/lib/utils'
import { useMcpServersQuery } from '@/queries'

interface McpListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

const STATE_COLOR: Record<ServerStatus['state'], string> = {
  ready: 'bg-(--accent-green)',
  starting: 'bg-(--accent-orange)',
  auth_required: 'bg-(--accent-orange)',
  error: 'bg-(--color-error)',
  stopped: 'bg-(--color-text-muted)/40',
}

function StatusDot({ server }: { server: ServerStatus }) {
  if (server.state === 'error') {
    return (
      <span
        className="flex shrink-0 items-center text-(--color-error)"
        title={server.error ?? 'Server failed to start'}
        aria-label={`Error: ${server.error ?? 'unknown'}`}
      >
        <AlertCircle size={13} />
      </span>
    )
  }
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', STATE_COLOR[server.state])}
      title={server.state}
      aria-label={`State: ${server.state}`}
    />
  )
}

export function McpListPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  const { data, isLoading, isError } = useMcpServersQuery()

  const rows = useMemo<ListViewRow[]>(
    () =>
      (data?.servers ?? []).map((srv): ListViewRow => ({
        key: srv.name,
        active: selectedName === srv.name,
        title: srv.name,
        badge: srv.enabled ? undefined : 'disabled',
        description: `${srv.transport === 'stdio' ? 'Local stdio process' : 'HTTP server'} · ${srv.tool_names.length} ${srv.tool_names.length === 1 ? 'tool' : 'tools'}`,
        onClick: () => onSelect(srv.name),
        trailing: (
          <div className="flex items-center gap-2">
            <StatusDot server={srv} />
            <span
              className="flex h-7 w-7 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)"
              aria-hidden="true"
            >
              <Plug size={13} />
            </span>
          </div>
        ),
      })),
    [data?.servers, selectedName, onSelect],
  )

  return (
    <SettingsListView
      title="MCP servers"
      description="External tool providers via Model Context Protocol. Stdio servers run locally as a child process; HTTP servers are remote."
      newLabel="New server"
      onNew={onNew}
      filterPlaceholder="Filter servers…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      emptyTitle="No MCP servers yet"
      emptyBody="MCP servers expose tools and resources to your agents over stdio or HTTP."
    />
  )
}
