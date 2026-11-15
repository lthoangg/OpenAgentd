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

export function ConnectorsListPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  const { data, isLoading, isError, error, refetch } = useMcpServersQuery()

  const rows = useMemo<ListViewRow[]>(
    () =>
      (data?.servers ?? []).map((srv): ListViewRow => ({
        key: srv.name,
        active: selectedName === srv.name,
        title: srv.name,
        titleMono: true,
        // A server a plugin bundle brings: its detail page is read-only.
        badge: srv.plugin ? `from ${srv.plugin}` : undefined,
        description: srv.transport === 'stdio' ? 'A program on this computer' : 'A web address',
        onClick: () => onSelect(srv.name),
        trailing: (
          <span className="flex items-center gap-1.5">
            <Chip mono title={srv.transport === 'stdio' ? TERMS.stdio : TERMS.http}>{srv.transport}</Chip>
            <McpStatusChip server={srv} />
          </span>
        ),
      })),
    [data?.servers, selectedName, onSelect],
  )

  return (
    <SettingsListView
      title="Connectors"
      description="Outside tools and services your agents can use, such as Notion, Slack or GitHub."
      newLabel="New connector"
      onNew={onNew}
      filterPlaceholder="Filter connectors…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      emptyTitle="No connectors yet"
      emptyBody="A connector gives your agents another tool to work with. Most need only a web address and a sign-in."
      emptyIcon={Plug}
    />
  )
}
