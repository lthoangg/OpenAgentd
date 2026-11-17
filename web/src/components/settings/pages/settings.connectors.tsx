import { Plug } from 'lucide-react'
import { useMemo } from 'react'

import { McpStatusChip } from '@/components/McpStatusChip'
import { ConnectorGallery } from '@/components/settings/ConnectorGallery'
import { Chip } from '@/components/ui/chip'
import { TERMS } from '@/components/ui/term'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useMcpServersQuery } from '@/queries'
import { useAgentStore } from '@/stores/useAgentStore'

interface McpListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

export function ConnectorsListPage({ selectedName, onSelect, onNew }: McpListPageProps) {
  // The open workspace's project servers (its `.agents/mcp.json`) list here too.
  const workspace = useAgentStore((s) => s._workspace)
  const { data, isLoading, isError, error, refetch } = useMcpServersQuery({ workspace })

  const rows = useMemo<ListViewRow[]>(
    () =>
      (data?.servers ?? []).map((srv): ListViewRow => ({
        key: srv.name,
        active: selectedName === srv.name,
        title: srv.project?.name ?? srv.name,
        titleMono: true,
        // A server a plugin bundle or the project brings: its detail page is read-only.
        badge: srv.plugin ? `from ${srv.plugin}` : srv.project ? 'from this project' : undefined,
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
      newLabel="Add your own"
      onNew={onNew}
      filterPlaceholder="Filter your connectors…"
      lead={<ConnectorGallery onOpen={onSelect} />}
      listTitle="Your connectors"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      emptyTitle="No connectors yet"
      emptyBody="Turn one on above, or add your own: most need only a web address and a sign-in."
      emptyIcon={Plug}
    />
  )
}
