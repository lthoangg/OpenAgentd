import { Crown, Plus, Wrench } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useAgentFilesQuery } from '@/queries'

interface AgentsListPageProps {
  selectedName?: string | null
  onSelect: (name: string) => void
  onNew: (mode?: 'normal' | 'coding') => void
}

export function AgentsListPage({ selectedName, onSelect, onNew }: AgentsListPageProps) {
  const { data, isLoading, isError } = useAgentFilesQuery()
  const [modeDialogOpen, setModeDialogOpen] = useState(false)

  const rows: ListViewRow[] = (() => {
    const agents = data?.agents ?? []
    const byLeadFirst = (a: (typeof agents)[number], b: (typeof agents)[number]) => {
      if (a.role === b.role) return a.name.localeCompare(b.name)
      return a.role === 'lead' ? -1 : 1
    }
    const normal = agents.filter((a) => !a.name.startsWith('coding/')).sort(byLeadFirst)
    const coding = agents.filter((a) => a.name.startsWith('coding/')).sort(byLeadFirst)

    const mapAgent = (a: (typeof agents)[number]): ListViewRow => {
      const isLead = a.role === 'lead'
      return {
        key: a.name,
        active: selectedName === a.name,
        title: a.name.replace(/^coding\//, ''),
        badge: isLead ? 'lead' : undefined,
        description: a.description || a.model || 'No description',
        invalidReason: !a.valid ? (a.error ?? 'Invalid configuration') : undefined,
        onClick: () => onSelect(a.name),
        trailing: (
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)"
            aria-hidden="true"
          >
            {isLead ? <Crown size={13} /> : <Wrench size={13} />}
          </span>
        ),
      }
    }

    return [
      ...(normal.length > 0
        ? [{ key: 'group-normal', kind: 'group' as const, title: 'Normal' }, ...normal.map(mapAgent)]
        : []),
      ...(coding.length > 0
        ? [{ key: 'group-coding', kind: 'group' as const, title: 'Coding' }, ...coding.map(mapAgent)]
        : []),
    ]
  })()

  return (
    <>
      <SettingsListView
        title="Agents"
        description="Markdown files with YAML frontmatter. Normal and Coding agents are grouped below; built-in OpenAgentd profiles use additive local overrides."
        newLabel="New agent"
        onNew={() => setModeDialogOpen(true)}
        newAction={
          <Button size="sm" onClick={() => setModeDialogOpen(true)}>
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
      <Dialog open={modeDialogOpen} onOpenChange={setModeDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Create agent</DialogTitle>
            <DialogDescription>Choose which team directory receives the new agent file.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => { setModeDialogOpen(false); onNew('normal') }}>
              Normal
            </Button>
            <Button onClick={() => { setModeDialogOpen(false); onNew('coding') }}>
              Coding
            </Button>
          </div>
          <DialogFooter className="p-3">
            <Button type="button" variant="default" onClick={() => setModeDialogOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
