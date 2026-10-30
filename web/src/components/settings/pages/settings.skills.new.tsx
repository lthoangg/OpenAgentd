import { useState } from 'react'

import { useCreateSkillMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { validateSkillDraft } from '@/components/settings/schema'
import { PanelSection } from '@/components/ui/panel-section'
import { Textarea } from '@/components/ui/textarea'
import { EDITOR_BODY } from '@/components/settings/tokens'
import { errorMessage } from '@/utils/errors'

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
      push({ tone: 'success', title: `Created skill "${name}"`, description: 'Applies to your next message.' })
      onCreated(name)
    } catch (err) {
      const msg = errorMessage(err)
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
        saveLabel="Create skill"
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={EDITOR_BODY}>
          <PanelSection title="Skill file" description="SKILL.md, loaded by an agent when a task needs it.">
            <p className="mb-2.5 text-[11px] leading-relaxed text-(--color-text-muted)">
              The settings block at the top needs <span className="font-mono">name</span> and{' '}
              <span className="font-mono">description</span>. Name a sub-skill{' '}
              <span className="font-mono">parent/sub</span>. The text below is what the agent reads.
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
            <p className="mt-2 text-xs text-(--color-text-muted)">
              Saved as <span className="font-mono text-(--color-text)">{name}</span>, from the <span className="font-mono">name</span> line.
            </p>
          </PanelSection>
        </div>
      </div>
    </div>
  )
}
