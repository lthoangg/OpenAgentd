import { useMemo, useState } from 'react'
import { Users, Wrench } from 'lucide-react'
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
import { AgentEditorPage } from './settings.agents.$name'

export function AgentsListPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const { data, isLoading, isError } = useAgentFilesListQuery()
  const createMut = useCreateAgentMutation()
  const push = useToastStore((s) => s.push)

  const rows = useMemo<ListViewRow[]>(() => {
    const agents = data?.agents ?? []
    return agents.map((a) => {
      const isLead = a.name === 'code' || a.role === 'lead'
      return {
        key: a.name,
        active: selectedAgent === a.name,
        title: a.name === 'code' ? 'code (Coding Lead)' : a.name,
        badge: isLead ? 'lead' : 'member',
        description: [
          a.description || (isLead ? 'Primary interactive agent' : 'Subagent team member'),
          a.model || null,
        ]
          .filter(Boolean)
          .join(' · '),
        invalidReason: !a.valid ? (a.error ?? 'Invalid configuration') : undefined,
        onClick: () => setSelectedAgent(a.name),
        icon: isLead ? <Wrench size={13} /> : <Users size={13} />,
      }
    })
  }, [data?.agents, selectedAgent])

  if (selectedAgent) {
    return <AgentEditorPage name={selectedAgent} onBack={() => setSelectedAgent(null)} />
  }

  const handleOpenCreate = () => {
    setNewProfileName('')
    setCreateError(null)
    setCreateOpen(true)
  }

  const submitCreate = async () => {
    const raw = newProfileName.trim()
    if (!raw) {
      setCreateError('Profile name cannot be empty.')
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
description: Specialized subagent team member.
tools:
  - read
  - glob
  - grep
---

You are **${cleanName}**, a specialized member agent.
`
    try {
      await createMut.mutateAsync({ name: cleanName, content: template })
      push({ tone: 'success', title: `Created agent "${cleanName}"` })
      setCreateOpen(false)
      setSelectedAgent(cleanName)
    } catch (err) {
      setCreateError(String(err))
    }
  }

  return (
    <>
    <SettingsListView
      title="Agents"
      description="Agent profiles define system prompts, models, and allowed tools for the coding lead and subagent team members. Live in ~/.config/openagentd/agents/."
      newLabel="New member profile"
      onNew={handleOpenCreate}
      filterPlaceholder="Filter agents…"
      rows={rows}
      isLoading={isLoading}
      isError={isError}
      emptyTitle="No agents found"
      emptyBody="Agent profiles live in ~/.config/openagentd/agents/."
    />

    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New member profile</DialogTitle>
          <DialogDescription>
            Create a specialized subagent profile that the lead agent can delegate tasks to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label htmlFor="member-profile-name" className="text-xs font-medium text-(--color-text)">
              Profile name
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
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submitCreate}
            disabled={createMut.isPending || !newProfileName.trim()}
          >
            {createMut.isPending ? 'Creating…' : 'Create profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
