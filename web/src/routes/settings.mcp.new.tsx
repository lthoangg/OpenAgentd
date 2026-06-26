import { useState } from 'react'

import { useCreateMcpServerMutation } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { McpServerForm } from '@/components/settings/McpServerForm'
import {
  draftToServerBody,
  emptyDraft,
  validateDraft,
  type McpServerDraft,
} from '@/components/settings/McpServerDraft'

const TEMPLATE: McpServerDraft = {
  ...emptyDraft(),
  name: 'new-server',
  command: 'npx',
  argsText: '-y\n@modelcontextprotocol/server-filesystem\n/tmp',
}

function isPristine(draft: McpServerDraft): boolean {
  return (
    draft.name === TEMPLATE.name &&
    draft.transport === TEMPLATE.transport &&
    draft.enabled === TEMPLATE.enabled &&
    draft.command === TEMPLATE.command &&
    draft.argsText === TEMPLATE.argsText &&
    draft.envPairs.length === 0 &&
    draft.url === '' &&
    draft.headerPairs.length === 0 &&
    draft.oauthEnabled === TEMPLATE.oauthEnabled &&
    draft.oauthClientIdEnv === TEMPLATE.oauthClientIdEnv &&
    draft.oauthClientSecretEnv === TEMPLATE.oauthClientSecretEnv
  )
}

interface NewMcpServerPageProps {
  onBack: () => void
  onCreated: (name: string) => void
}

export function NewMcpServerPage({ onBack, onCreated }: NewMcpServerPageProps) {
  const [draft, setDraft] = useState<McpServerDraft>(TEMPLATE)
  const [saveError, setSaveError] = useState<string | null>(null)
  const createMut = useCreateMcpServerMutation()
  const push = useToastStore((s) => s.push)

  const fieldErrors = validateDraft(draft, { isNew: true })
  const invalid = fieldErrors !== null
  const firstError = fieldErrors ? Object.values(fieldErrors)[0] : null
  const dirty = !isPristine(draft)

  const handleCreate = async () => {
    setSaveError(null)
    if (invalid) { setSaveError(firstError ?? 'Form has validation errors.'); return }
    const result = draftToServerBody(draft)
    if (!result.ok) { setSaveError(result.error); return }
    try {
      await createMut.mutateAsync({ name: draft.name, server: result.body })
      push({ tone: 'success', title: `Created MCP server "${draft.name}"`, description: 'Available on next turn.' })
      onCreated(draft.name)
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
      setSaveError(msg)
      push({ tone: 'error', title: 'Create failed', description: msg })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="mcp"
        name="New MCP server"
        dirty={dirty}
        invalid={invalid}
        saving={createMut.isPending}
        error={saveError}
        validationHint={firstError}
        onSave={handleCreate}
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <McpServerForm value={draft} onChange={setDraft} isNew disabled={createMut.isPending} errors={fieldErrors} />
        </div>
      </div>
    </div>
  )
}
