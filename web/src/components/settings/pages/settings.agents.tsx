import { Crown, Plus, Wrench } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useAgentFilesQuery } from '@/queries'

interface AgentsListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: () => void
}

export function AgentsListPage({ selectedName, onSelect, onNew }: AgentsListPageProps) {
  const { data, isLoading, isError } = useAgentFilesQuery()

  const rows: ListViewRow[] = (() => {
    const agents = data?.agents ?? []
    const byLeadFirst = (a: (typeof agents)[number], b: (typeof agents)[number]) => {
      if (a.role === b.role) return a.name.localeCompare(b.name)
      return a.role === 'lead' ? -1 : 1
    }
    const coding = agents.filter((a) => a.name.startsWith('coding/')).sort(byLeadFirst)

    const mapAgent = (a: (typeof agents)[number]): ListViewRow => {
      const isLead = a.role === 'lead'
      // Short model name: strip provider prefix (e.g. "anthropic:claude-opus-4-5" → "claude-opus-4-5")
      const shortModel = a.model
        ? a.model.split(':').at(-1)?.split('/').at(-1) ?? a.model
        : null
      const metaParts: string[] = []
      if (shortModel) metaParts.push(shortModel)
      const toolCount = (a.tools?.length ?? 0) + (a.mcp?.length ?? 0)
      if (toolCount > 0) metaParts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`)

      return {
        key: a.name,
        active: selectedName === a.name,
        title: a.name.replace(/^coding\//, ''),
        badge: isLead ? 'lead' : undefined,
        description: a.description || undefined,
        meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
        icon: isLead ? <Crown size={13} /> : <Wrench size={13} />,
        invalidReason: !a.valid ? (a.error ?? 'Invalid configuration') : undefined,
        onClick: () => onSelect(a.name),
      }
    }

    return coding.map(mapAgent)
  })()

  return (
    <>
      <SettingsListView
        title="Agents"
        description="Markdown files with YAML frontmatter for coding sessions."
        newLabel="New agent"
        onNew={onNew}
        newAction={
          <Button size="sm" className="min-h-11 md:min-h-0" onClick={onNew}>
            <Plus size={13} aria-hidden="true" />
            New agent
          </Button>
        }
        filterPlaceholder="Filter agents…"
        rows={rows}
        isLoading={isLoading}
        isError={isError}
        emptyTitle="No agents yet"
        emptyBody="Define a team member with a model, tools, and a system prompt."
      />
    </>
  )
}
