import { useMemo, useState } from 'react'
import { Wrench } from 'lucide-react'
import { SettingsListView, type ListViewRow } from '@/components/settings/SettingsListView'
import { useAgentFilesListQuery, useCreateAgentMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/utils/errors'
import { isUnconfiguredModel } from '@/lib/model-readiness'

/** What the main agent is called on screen; its file is `code`. */
export const MAIN_AGENT_LABEL = 'Main agent'

interface AgentsListPageProps {
  selectedName?: string | null
  /** Opens an agent's editor (the `agents-edit` drill-down, as skills and connectors do). */
  onSelect: (name: string) => void
}

export function AgentsListPage({ selectedName = null, onSelect }: AgentsListPageProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const { data, isLoading, isError, error, refetch } = useAgentFilesListQuery()
  const createMut = useCreateAgentMutation()
  const push = useToastStore((s) => s.push)

  const rows = useMemo<ListViewRow[]>(() => {
    const agents = data?.agents ?? []
    return agents.map((a): ListViewRow => {
      const isLead = a.name === 'code' || a.role === 'lead'
      return {
        key: a.name,
        active: selectedName === a.name,
        // The main agent by what it is, not its file name ("code").
        title: isLead ? MAIN_AGENT_LABEL : a.name,
        titleMono: !isLead,
        badge: isLead ? undefined : 'subagent',
        badgeTone: 'neutral',
        description: a.description || (isLead ? 'The agent you chat with' : 'Takes tasks from the main agent'),
        ...(a.model && !isUnconfiguredModel(a.model)
          ? { meta: a.model }
          : { metaChip: 'model not set' }),
        invalidReason: !a.valid ? (a.error ?? 'Invalid configuration') : undefined,
        onClick: () => onSelect(a.name),
      }
    })
  }, [data?.agents, selectedName, onSelect])

  const handleOpenCreate = () => {
    setNewProfileName('')
    setCreateError(null)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const raw = newProfileName.trim()
    if (!raw) {
      setCreateError('Enter a name.')
      return
    }
    const cleanName = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    if (data?.agents?.some((a) => a.name === cleanName)) {
      setCreateError(`An agent named "${cleanName}" already exists.`)
      return
    }
    const template = `---
name: ${cleanName}
role: member
description: Specialized subagent.
tools:
  - read
  - glob
  - grep
---

You are **${cleanName}**, a specialized subagent.
`
    try {
      await createMut.mutateAsync({ name: cleanName, content: template })
      push({ tone: 'success', title: `Created subagent "${cleanName}"`, description: cleanName !== raw ? `Saved as ${cleanName}` : undefined })
      setCreateOpen(false)
      onSelect(cleanName)
    } catch (err) {
      setCreateError(errorMessage(err))
    }
  }

  return (
    <>
    <SettingsListView
      title="Agents"
      description="Prompts, models and tools for the main agent and the subagents it hands tasks to."
      newLabel="New subagent"
      onNew={handleOpenCreate}
      filterPlaceholder="Filter agents…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      emptyTitle="No agents found"
      emptyBody="Agent profiles live in ~/.config/openagentd/agents/."
      emptyIcon={Wrench}
    />

    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New subagent</DialogTitle>
          <DialogDescription>
            A subagent the main agent can hand tasks to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label htmlFor="member-profile-name" className="text-xs font-medium text-(--color-text)">
              Name
            </label>
            <Input
              id="member-profile-name"
              type="text"
              autoFocus
              placeholder="e.g. reviewer, tester, auditor"
              value={newProfileName}
              onChange={(e) => {
                setNewProfileName(e.target.value)
                if (createError) setCreateError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void submitCreate()
                }
              }}
            />
            {createError && (
              <p className="text-xs text-(--color-error)">{createError}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submitCreate}
            disabled={createMut.isPending || !newProfileName.trim()}
          >
            {createMut.isPending ? 'Creating…' : 'Create subagent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
