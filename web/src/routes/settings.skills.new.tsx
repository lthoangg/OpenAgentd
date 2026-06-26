import { useState } from 'react'

import { useCreateSkillMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { validateSkillDraft } from '@/components/settings/schema'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { Textarea } from '@/components/ui/textarea'

const TEMPLATE = `---
name: new-skill
description: One-line description shown to agents when they see the skill list.
---

# New skill

Replace this with the instructions an agent should follow when applying
this skill. Keep it focused on a single concern.
`

interface NewSkillPageProps {
  onBack: () => void
  onCreated: (name: string) => void
}

export function NewSkillPage({ onBack, onCreated }: NewSkillPageProps) {
  const [content, setContent] = useState(TEMPLATE)
  const [name, setName] = useState('new-skill')
  const createMut = useCreateSkillMutation()
  const push = useToastStore((s) => s.push)
  const [saveError, setSaveError] = useState<string | null>(null)

  const handleContentChange = (raw: string) => {
    setContent(raw)
    const match = /^\s*---[\s\S]*?name:\s*([A-Za-z0-9._/-]+)/m.exec(raw)
    if (match) setName(match[1])
  }

  const draftErrors = validateSkillDraft(content)
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null

  const handleCreate = async () => {
    setSaveError(null)
    if (invalid) { setSaveError(firstDraftError ?? 'Form has validation errors.'); return }
    try {
      await createMut.mutateAsync({ name, content })
      push({ tone: 'success', title: `Created skill "${name}"`, description: 'Active on next turn.' })
      onCreated(name)
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
      setSaveError(msg)
      push({ tone: 'error', title: 'Create failed', description: msg })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="skill"
        name="New skill"
        dirty={content !== TEMPLATE}
        invalid={invalid}
        saving={createMut.isPending}
        error={saveError}
        validationHint={firstDraftError}
        onSave={handleCreate}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <SettingsSection title="Skill source" description="frontmatter + body loaded by agents on demand">
            <p className="mb-2.5 text-[11px] leading-relaxed text-(--color-text-muted)">
              Frontmatter (<span className="font-mono">name</span>,{' '}
              <span className="font-mono">description</span>) is required;
              use <span className="font-mono">parent/sub</span> for a one-level sub-skill.
              The body is the instruction the agent loads on demand.
            </p>
            <Textarea
              value={content}
              onChange={(e) => handleContentChange(e.target.value)}
              disabled={createMut.isPending}
              rows={28}
              spellCheck={false}
              aria-invalid={invalid || undefined}
              className="min-h-96 font-mono text-[13px] leading-relaxed"
            />
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}
