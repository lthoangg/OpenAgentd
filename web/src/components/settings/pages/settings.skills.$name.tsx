import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { useDeleteSkillMutation, useSkillFileQuery, useUpdateSkillMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { contentEquals } from '@/components/settings/frontmatter'
import { validateSkillDraft } from '@/components/settings/schema'
import { PanelSection } from '@/components/ui/panel-section'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { EDITOR_BODY } from '@/components/settings/tokens'
import { SettingsSkeleton } from '@/components/settings/SettingsPage'
import { errorMessage } from '@/utils/errors'

interface SkillEditorPageProps {
  name: string
  onBack: () => void
}

export function SkillEditorPage({ name, onBack }: SkillEditorPageProps) {
  const push = useToastStore((s) => s.push)
  const { data, isLoading, isError, error, refetch } = useSkillFileQuery(name)
  const updateMut = useUpdateSkillMutation()
  const deleteMut = useDeleteSkillMutation()
  const [draft, setDraft] = useState<string>(() => data?.content ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState<'back' | 'discard' | null>(null)

  const [seededFor, setSeededFor] = useState<string | null>(data?.content ? name : null)
  if (data?.content && seededFor !== name) {
    setSeededFor(name)
    setDraft(data.content)
    setSaveError(null)
  }

  const readOnly = data ? !data.editable : false
  const dirty = !!data && !contentEquals(draft, data.content)
  const draftErrors = dirty ? validateSkillDraft(draft) : null
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null
  const sourceLabel = data?.built_in ? 'built in' : 'outside your config folder'
  // Back goes through the same unsaved-changes check as closing Settings.
  const guardedBack = () => {
    if (dirty) setConfirmLeave('back')
    else onBack()
  }

  const handleSave = async () => {
    setSaveError(null)
    if (readOnly) { setSaveError(`This skill is ${sourceLabel}, so it is read-only.`); return }
    if (invalid) { setSaveError(firstDraftError ?? 'Form has validation errors.'); return }
    try {
      const res = await updateMut.mutateAsync({ name, content: draft })
      push({ tone: 'success', title: `Saved "${name}"`, description: 'Applies to your next message.' })
      setDraft(res.content)
      refetch()
    } catch (err) {
      const msg = errorMessage(err)
      setSaveError(msg)
      push({ tone: 'error', title: 'Save failed', description: msg })
    }
  }

  const handleDelete = async () => {
    try {
      await deleteMut.mutateAsync(name)
      push({ tone: 'success', title: `Deleted "${name}"` })
      onBack()
    } catch (err) {
      const msg = errorMessage(err)
      push({ tone: 'error', title: 'Delete failed', description: msg })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="skill"
        name={name}
        path={data?.path}
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstDraftError}
        saveDisabledReason={readOnly ? `Read-only: this skill is ${sourceLabel}` : null}
        onSave={handleSave}
        onBack={guardedBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={EDITOR_BODY}>
          {isLoading && <SettingsSkeleton label="Loading skill" />}
          {isError && (
            <Callout
              tone="error"
              role="alert"
              title={`Couldn't load ${name}`}
              action={<Button size="sm" onClick={() => { void refetch() }}>Retry</Button>}
            >
              {errorMessage(error)}
            </Callout>
          )}
          {data && readOnly && (
            <Callout className="mb-4" title={data.built_in ? 'Built-in skills are read-only' : 'This skill is read-only'}>
              {data.built_in
                ? 'It ships with OpenAgentd. To change it, create a skill with the same name in your config folder.'
                : 'It lives outside your config folder, so edit it where it lives.'}
            </Callout>
          )}
          {data && (
            <PanelSection title="Skill file" description="SKILL.md, loaded by an agent when a task needs it.">
              <p className="mb-2.5 text-[11px] leading-relaxed text-(--color-text-muted)">
                The settings block at the top needs <span className="font-mono">name</span> and{' '}
                <span className="font-mono">description</span>. Name a sub-skill{' '}
                <span className="font-mono">parent/sub</span>. The text below is what the agent reads.
              </p>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={updateMut.isPending}
                readOnly={readOnly}
                rows={28}
                spellCheck={false}
                aria-invalid={invalid || undefined}
                className="min-h-96 font-mono text-[13px] leading-relaxed"
              />
            </PanelSection>
          )}
          <div className="mt-4 flex items-center justify-between gap-2 text-xs text-(--color-text-muted)">
            <div className="flex items-center gap-2">
              {dirty && (
                <Button variant="ghost" size="xs" className="min-h-9 md:min-h-0"
                  onClick={() => setConfirmLeave('discard')}>Discard changes…</Button>
              )}
            </div>
            {data && data.editable && !data.built_in && (
              <Button variant="danger" size="xs" className="min-h-9 md:min-h-0"
                onClick={() => setDeleteOpen(true)} disabled={deleteMut.isPending}>
                <Trash2 size={11} aria-hidden="true" />
                Delete skill…
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{name}&rdquo;?</DialogTitle>
            <DialogDescription>Its folder is removed from your skills folder. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>Delete skill</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmLeave !== null}
        onOpenChange={(open) => { if (!open) setConfirmLeave(null) }}
        title={confirmLeave === 'back' ? 'Leave without saving?' : 'Discard your changes?'}
        description={`Your edits to ${name} go back to the last saved version.`}
        confirmLabel={confirmLeave === 'back' ? 'Leave without saving' : 'Discard changes'}
        onConfirm={() => {
          if (data) setDraft(data.content)
          if (confirmLeave === 'back') onBack()
        }}
      />
    </div>
  )
}
