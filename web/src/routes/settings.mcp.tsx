import { Plug } from 'lucide-react'
import { useMemo } from 'react'

import { McpStatusDot } from '@/components/McpStatusDot'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useMcpServersQuery } from '@/queries'

interface McpListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
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
        icon: <Plug size={13} />,
        trailing: <McpStatusDot server={srv} />,
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
