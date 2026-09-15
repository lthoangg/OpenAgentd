import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  useAgentFileQuery,
  useDeleteAgentMutation,
  useUpdateAgentMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { AgentForm } from '@/components/settings/AgentForm'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { contentEquals } from '@/components/settings/frontmatter'
import { validateAgentDraft } from '@/components/settings/schema'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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

  const handleSave = async () => {
    setSaveError(null)
    if (invalid) {
      setSaveError(firstDraftError ?? 'Form has validation errors.')
      return
    }
    try {
      const res = await updateMut.mutateAsync({ content: draft })
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
      push({ tone: 'success', title: `Deleted agent "${name}"` })
      setDeleteOpen(false)
      onBack()
    } catch (err) {
      push({ tone: 'error', title: 'Failed to delete agent', description: String(err) })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="agent"
        name={name === 'code' ? 'Coding agent' : `Member: ${name}`}
        path={data?.path}
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstDraftError}
        mode={mode}
        onModeChange={setMode}
        onSave={handleSave}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-3 sm:p-5">
          {isLoading && <p className="text-sm text-(--color-text-muted)">Loading…</p>}
          {isError && <p className="text-sm text-(--color-error)">Failed to load: {String(error)}</p>}
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
                <>
                  <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                    onClick={() => data && setDraft(data.content)}>
                    Discard changes
                  </Button>
                  <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                    onClick={onBack}>
                    Leave without saving
                  </Button>
                </>
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
                Delete profile
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete profile &ldquo;{name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This will permanently delete the agent profile from your configuration directory. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
