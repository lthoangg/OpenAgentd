import { useState } from 'react'

import { useCreateMcpServerMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { SaveBar } from '@/components/settings/SaveBar'
import { McpServerForm } from '@/components/settings/McpServerForm'
import {
  draftToServerBody,
  emptyDraft,
  nameFromAddress,
  validateDraft,
  type McpServerDraft,
} from '@/components/settings/McpServerDraft'
import { EDITOR_BODY } from '@/components/settings/tokens'
import { errorMessage } from '@/utils/errors'

/** A new connector starts as a web address that signs in: what most hosted tools need. */
const TEMPLATE: McpServerDraft = { ...emptyDraft(), transport: 'http', oauthEnabled: true }

/** Nothing typed yet. Choosing how it connects is not an edit: it only picks which fields show. */
function isPristine(draft: McpServerDraft): boolean {
  return JSON.stringify({ ...draft, transport: TEMPLATE.transport }) === JSON.stringify(TEMPLATE)
}

interface NewMcpServerPageProps {
  onBack: () => void
  onCreated: (name: string) => void
}

export function NewConnectorPage({ onBack, onCreated }: NewMcpServerPageProps) {
  const [draft, setDraft] = useState<McpServerDraft>(TEMPLATE)
  // The name follows the address until the person types one.
  const [nameTyped, setNameTyped] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const createMut = useCreateMcpServerMutation()
  const push = useToastStore((s) => s.push)

  const fieldErrors = validateDraft(draft, { isNew: true })
  const invalid = fieldErrors !== null
  const firstError = fieldErrors ? Object.values(fieldErrors)[0] : null
  const dirty = !isPristine(draft)

  const handleChange = (next: McpServerDraft) => {
    const typed = nameTyped || next.name !== draft.name
    if (typed !== nameTyped) setNameTyped(typed)
    setDraft(typed || next.transport === 'stdio' ? next : { ...next, name: nameFromAddress(next.url) })
  }

  const handleCreate = async () => {
    setSaveError(null)
    if (invalid) { setSaveError(firstError ?? 'Form has validation errors.'); return }
    const result = draftToServerBody(draft)
    if (!result.ok) { setSaveError(result.error); return }
    try {
      await createMut.mutateAsync({ name: draft.name, server: result.body })
      push({ tone: 'success', title: `Created "${draft.name}"`, description: 'Applies to your next message.' })
      onCreated(draft.name)
    } catch (err) {
      const msg = errorMessage(err)
      setSaveError(msg)
      push({ tone: 'error', title: 'Create failed', description: msg })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="mcp"
        name="New connector"
        dirty={dirty}
        invalid={invalid}
        saving={createMut.isPending}
        error={saveError}
        validationHint={dirty ? firstError : null}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={EDITOR_BODY}>
          <McpServerForm value={draft} onChange={handleChange} isNew disabled={createMut.isPending} errors={dirty ? fieldErrors : null} />
        </div>
      </div>

      <SaveBar
        saveLabel="Create connector"
        draft={{
          dirty,
          canSave: dirty && !invalid && !createMut.isPending,
          isSaving: createMut.isPending,
          save: handleCreate,
          reset: () => {
            setDraft(TEMPLATE)
            setNameTyped(false)
            setSaveError(null)
          },
        }}
        onSave={() => { void handleCreate() }}
        saveBlockedReason={invalid ? (firstError ?? 'Fix the errors above to create it.') : null}
        discardDescription="The form goes back to empty."
      />
    </div>
  )
}
