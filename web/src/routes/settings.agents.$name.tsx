import { useState } from 'react'
import { Trash2 } from 'lucide-react'

import {
  useAgentFileQuery,
  useAgentFilesQuery,
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
  name: string
  onBack: () => void
}

export function AgentEditorPage({ name, onBack }: AgentEditorPageProps) {
  const push = useToastStore((s) => s.push)
  const { data, isLoading, isError, error, refetch } = useAgentFileQuery(name)
  const { data: agentsData } = useAgentFilesQuery()
  const updateMut = useUpdateAgentMutation()
  const deleteMut = useDeleteAgentMutation()

  const [draft, setDraft] = useState<string>(() => data?.content ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const [seeded, setSeeded] = useState(!!data?.content)
  if (!seeded && data?.content) {
    setSeeded(true)
    setDraft(data.content)
  }

  const dirty = !!data && !contentEquals(draft, data.content)
  const draftErrors = dirty ? validateAgentDraft(draft) : null
  const invalid = draftErrors !== null
  const firstDraftError = draftErrors ? Object.values(draftErrors)[0] : null
  const currentSummary = agentsData?.agents.find((agent) => agent.name === name)
  const isBuiltIn = currentSummary ? isBuiltInAgent(currentSummary.name, currentSummary.role) : false

  const handleSave = async () => {
    setSaveError(null)
    if (invalid) {
      setSaveError(firstDraftError ?? 'Form has validation errors.')
      return
    }
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
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          {isLoading && <p className="text-sm text-(--color-text-muted)">Loading…</p>}
          {isError && <p className="text-sm text-(--color-error)">Failed to load: {String(error)}</p>}
          {data && (
            <AgentForm
              initial={data.content}
              agentPath={name}
              onChange={setDraft}
              disabled={updateMut.isPending}
              isNew={false}
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
            {data && !isBuiltIn && (
              <Button variant="danger" size="xs" className="min-h-11 md:min-h-0"
                onClick={() => setDeleteOpen(true)} disabled={deleteMut.isPending}>
                <Trash2 size={11} aria-hidden="true" />
                Delete agent
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              Delete `{name}.md` from the agents config directory. This cannot be undone.
            </DialogDescription>
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

const NORMAL_BUILT_INS = new Set(['openagentd', 'explorer', 'executor'])
const CODING_BUILT_INS = new Set(['openagentd', 'coder', 'explorer'])

function isBuiltInAgent(name: string, role: string): boolean {
  const isCoding = name.startsWith('coding/')
  const basename = name.split('/').pop() ?? name
  if (role === 'lead') return basename === 'openagentd'
  return isCoding ? CODING_BUILT_INS.has(basename) : NORMAL_BUILT_INS.has(basename)
}
