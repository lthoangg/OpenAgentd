import { useState } from 'react'

import { useCreateAgentMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { AgentForm } from '@/components/settings/AgentForm'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { validateAgentDraft } from '@/components/settings/schema'

const TEMPLATE = `---
name: new_agent
role: member
description: A helpful team member.
model: googlegenai:gemini-3.1-flash-lite-preview
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
  onBack: () => void
  onCreated: (name: string) => void
}

export function NewAgentPage({ onBack, onCreated }: NewAgentPageProps) {
  const [draft, setDraft] = useState(TEMPLATE)
  const [name, setName] = useState('new_agent')
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
      const agentName = `coding/${name}`
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
          <p className="mb-4 text-[11px] text-(--color-text-muted)">
            Will create coding/{name}.md for coding sessions.
          </p>
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
