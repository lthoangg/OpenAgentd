import { useState } from 'react'

import { useCreateAgentMutation } from '@/queries'
import { Button } from '@/components/ui/button'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { AgentForm } from '@/components/settings/AgentForm'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { validateAgentDraft } from '@/components/settings/schema'

type AgentMode = 'normal' | 'coding'

const TEMPLATE = `---
name: new_agent
role: member
description: A helpful team member.
model: googlegenai:gemini-3.1-flash-lite-preview
temperature: 0.2
tools:
  - date
  - read
  - write
---

You are "new_agent" — a helpful team member.

## Style
- Be concise.
- Ask clarifying questions when requirements are ambiguous.
`

interface NewAgentPageProps {
  initialMode?: AgentMode
  onBack: () => void
  onCreated: (name: string) => void
}

export function NewAgentPage({ initialMode = 'normal', onBack, onCreated }: NewAgentPageProps) {
  const [draft, setDraft] = useState(TEMPLATE)
  const [name, setName] = useState('new_agent')
  const [agentMode, setAgentMode] = useState<AgentMode>(initialMode)
  const createMut = useCreateAgentMutation()
  const push = useToastStore((s) => s.push)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<'form' | 'raw'>('form')

  const handleDraftChange = (raw: string) => {
    setDraft(raw)
    const match = /^\s*---[\s\S]*?name:\s*([A-Za-z0-9._-]+)/m.exec(raw)
    if (match) setName(match[1])
  }

  const draftErrors = validateAgentDraft(draft)
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null

  const handleCreate = async () => {
    setSaveError(null)
    if (invalid) {
      setSaveError(firstDraftError ?? 'Form has validation errors.')
      return
    }
    try {
      const agentName = agentMode === 'coding' ? `coding/${name}` : name
      await createMut.mutateAsync({ name: agentName, content: draft })
      push({ tone: 'success', title: `Created "${agentName}"`, description: 'Active on next turn.' })
      onCreated(agentName)
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
      setSaveError(msg)
      push({ tone: 'error', title: 'Create failed', description: msg })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="agent"
        name="New agent"
        dirty={draft !== TEMPLATE}
        invalid={invalid}
        saving={createMut.isPending}
        error={saveError}
        validationHint={firstDraftError}
        mode={mode}
        onModeChange={setMode}
        onSave={handleCreate}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-3 sm:p-5">
          <div className="mb-4 rounded-lg border border-(--color-border) bg-(--bg-card) px-4 py-3">
            <p className="text-xs font-medium text-(--color-text)">Create in</p>
            <div className="mt-2 flex gap-2">
              <Button type="button" size="xs" className="min-h-11 md:min-h-0"
                variant={agentMode === 'normal' ? 'default' : 'subtle'}
                onClick={() => setAgentMode('normal')}>
                Normal
              </Button>
              <Button type="button" size="xs" className="min-h-11 md:min-h-0"
                variant={agentMode === 'coding' ? 'default' : 'subtle'}
                onClick={() => setAgentMode('coding')}>
                Coding
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-(--color-text-muted)">
              {agentMode === 'coding'
                ? `Will create coding/${name}.md for coding sessions.`
                : `Will create ${name}.md for normal sessions.`}
            </p>
          </div>
          <AgentForm
            initial={TEMPLATE}
            onChange={handleDraftChange}
            disabled={createMut.isPending}
            isNew
            mode={mode}
            onModeChange={setMode}
          />
        </div>
      </div>
    </div>
  )
}
