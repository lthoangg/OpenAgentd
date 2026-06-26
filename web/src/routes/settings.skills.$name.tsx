import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import { useDeleteSkillMutation, useSkillFileQuery, useUpdateSkillMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { contentEquals } from '@/components/settings/frontmatter'
import { validateSkillDraft } from '@/components/settings/schema'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

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
  const [seeded, setSeeded] = useState(!!data?.content)
  if (!seeded && data?.content) {
    setSeeded(true)
    setDraft(data.content)
  }

  const readOnly = data ? !data.editable : false
  const dirty = !!data && !contentEquals(draft, data.content)
  const draftErrors = dirty ? validateSkillDraft(draft) : null
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null

  const handleSave = async () => {
    setSaveError(null)
    if (readOnly) { setSaveError(`Read-only skill from ${data?.source ?? 'external source'}.`); return }
    if (invalid) { setSaveError(firstDraftError ?? 'Form has validation errors.'); return }
    try {
      const res = await updateMut.mutateAsync({ name, content: draft })
      push({ tone: 'success', title: `Saved "${name}"`, description: 'Active on next turn.' })
      setDraft(res.content)
      refetch()
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
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
      const msg = err instanceof ApiValidationError ? err.message : String(err)
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
        saveDisabledReason={readOnly ? `Read-only skill from ${data?.source ?? 'external source'}` : null}
        onSave={handleSave}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          {isLoading && <p className="text-sm text-(--color-text-muted)">Loading…</p>}
          {isError && <p className="text-sm text-(--color-error)">Failed to load: {String(error)}</p>}
          {data && (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Skill source</CardTitle>
                <CardDescription>
                  Frontmatter (<span className="font-mono">name</span>,{' '}
                  <span className="font-mono">description</span>) is required;
                  use <span className="font-mono">parent/sub</span> for a one-level sub-skill.
                  The body is the instruction the agent loads on demand.
                </CardDescription>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
          )}
          <div className="mt-4 flex items-center justify-between gap-2 text-xs text-(--color-text-muted)">
            <div className="flex items-center gap-2">
              {dirty && (
                <>
                  <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                    onClick={() => data && setDraft(data.content)}>Discard changes</Button>
                  <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                    onClick={onBack}>Leave without saving</Button>
                </>
              )}
            </div>
            {data && data.editable && !data.built_in && (
              <Button variant="danger" size="xs" className="min-h-11 md:min-h-0"
                onClick={() => setDeleteOpen(true)} disabled={deleteMut.isPending}>
                <Trash2 size={11} aria-hidden="true" />
                Delete skill
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete skill</DialogTitle>
            <DialogDescription>Delete `{name}` from the skills config directory. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="p-3">
            <Button type="button" variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
