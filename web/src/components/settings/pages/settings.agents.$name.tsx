import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  useAgentFileQuery,
  useDeleteAgentMutation,
  useUpdateAgentMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { AgentForm } from '@/components/settings/AgentForm'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { contentEquals } from '@/components/settings/frontmatter'
import { validateAgentDraft } from '@/components/settings/schema'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EDITOR_BODY } from '@/components/settings/tokens'
import { SettingsSkeleton } from '@/components/settings/SettingsPage'
import { errorMessage } from '@/utils/errors'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useUnsavedSettings } from '@/hooks/useUnsavedSettings'

interface AgentEditorPageProps {
  name?: string
  onBack: () => void
}

export function AgentEditorPage({ name = 'code', onBack }: AgentEditorPageProps) {
  const push = useToastStore((s) => s.push)
  const { data, isLoading, isError, error, refetch } = useAgentFileQuery(name)
  const updateMut = useUpdateAgentMutation(name)
  const deleteMut = useDeleteAgentMutation()

  const [draft, setDraft] = useState<string>(() => data?.content ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState<'back' | 'discard' | null>(null)

  // Re-seed draft when navigating to a different agent or when the query
  // first resolves. Using the agent name as the sentinel means switching
  // between agents always resets the draft to the freshly loaded content.
  const [seededFor, setSeededFor] = useState<string | null>(data?.content ? name : null)
  if (data?.content && seededFor !== name) {
    setSeededFor(name)
    setDraft(data.content)
    setSaveError(null)
  }

  const dirty = !!data && !contentEquals(draft, data.content)
  const draftErrors = dirty ? validateAgentDraft(draft) : null
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null
  useUnsavedSettings(dirty || updateMut.isPending)
  // Back goes through the same unsaved-changes check as closing Settings.
  const guardedBack = () => {
    if (dirty) setConfirmLeave('back')
    else onBack()
  }

  const handleSave = async () => {
    setSaveError(null)
    if (invalid) {
      setSaveError(firstDraftError ?? 'Form has validation errors.')
      return
    }
    try {
      const res = await updateMut.mutateAsync({ content: draft })
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
      push({ tone: 'success', title: `Deleted subagent "${name}"` })
      setDeleteOpen(false)
      onBack()
    } catch (err) {
      push({ tone: 'error', title: 'Failed to delete agent', description: errorMessage(err) })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="agent"
        name={name}
        path={data?.path}
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstDraftError}
        mode={mode}
        onModeChange={setMode}
        onSave={handleSave}
        onBack={guardedBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={EDITOR_BODY}>
          {isLoading && <SettingsSkeleton label="Loading agent" />}
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
          {data && (
            <AgentForm
              initial={data.content}
              agentName={name}
              effectiveTools={data.config?.tools}
              defaultPrompt={data.config?.system_prompt}
              onChange={setDraft}
              disabled={updateMut.isPending}
              mode={mode}
              onModeChange={setMode}
            />
          )}
          <div className="mt-4 flex items-center justify-between gap-2 text-xs text-(--color-text-muted)">
            <div className="flex items-center gap-2">
              {dirty && (
                <Button variant="ghost" size="xs" className="min-h-9 md:min-h-0"
                  onClick={() => setConfirmLeave('discard')}>
                  Discard changes…
                </Button>
              )}
            </div>
            {name !== 'code' && (
              <Button
                variant="ghost"
                size="xs"
                className="text-(--color-error) hover:bg-(--color-error-subtle) hover:text-(--color-error)"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 size={12} className="mr-1" />
                Delete subagent…
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete subagent &ldquo;{name}&rdquo;?</DialogTitle>
            <DialogDescription>
              Its file is deleted from your configuration folder. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete subagent'}
            </Button>
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
