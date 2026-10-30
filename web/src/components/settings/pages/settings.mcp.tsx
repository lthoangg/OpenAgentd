import { Plug } from 'lucide-react'
import { useMemo } from 'react'

import { McpStatusChip } from '@/components/McpStatusChip'
import { Chip } from '@/components/ui/chip'
import { TERMS } from '@/components/ui/term'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useMcpServersQuery } from '@/queries'

interface McpListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

export function McpListPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  const { data, isLoading, isError, error, refetch } = useMcpServersQuery()

  const rows = useMemo<ListViewRow[]>(
    () =>
      (data?.servers ?? []).map((srv): ListViewRow => ({
        key: srv.name,
        active: selectedName === srv.name,
        title: srv.name,
        titleMono: true,
        description: srv.transport === 'stdio' ? 'Runs a local process' : 'Connects to a URL',
        onClick: () => onSelect(srv.name),
        trailing: (
          <span className="flex items-center gap-1.5">
            <Chip mono variant="outline" title={srv.transport === 'stdio' ? TERMS.stdio : TERMS.http}>{srv.transport}</Chip>
            <McpStatusChip server={srv} />
          </span>
        ),
      })),
    [data?.servers, selectedName, onSelect],
  )

  return (
    <SettingsListView
      title="MCP servers"
      description="Tools from local processes or remote servers, over the Model Context Protocol."
      newLabel="New server"
      onNew={onNew}
      filterPlaceholder="Filter servers…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      emptyTitle="No MCP servers yet"
      emptyBody="MCP servers expose tools and resources to your agents over stdio or HTTP."
      emptyIcon={Plug}
    />
  )
}
