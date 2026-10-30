import { useMemo, useState } from 'react'
import { RotateCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatFullDateTime } from '@/utils/format'

import {
  useConnectMcpOAuthMutation,
  useDeleteMcpServerMutation,
  useMcpServerQuery,
  useRestartMcpServerMutation,
  useUpdateMcpServerMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { McpServerForm } from '@/components/settings/McpServerForm'
import {
  draftEquals,
  draftFromServerBody,
  draftToServerBody,
  validateDraft,
  type McpServerDraft,
} from '@/components/settings/McpServerDraft'
import { Button } from '@/components/ui/button'
import { PanelSection } from '@/components/ui/panel-section'
import { PanelRow } from '@/components/ui/panel-row'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { TERMS } from '@/components/ui/term'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { McpStatusChip } from '@/components/McpStatusChip'
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

interface McpServerDetailPageProps {
  name: string
  onBack: () => void
}

export function McpServerDetailPage({ name, onBack }: McpServerDetailPageProps) {
  const push = useToastStore((s) => s.push)
  const serverQ = useMcpServerQuery(name)
  const updateMut = useUpdateMcpServerMutation()
  const deleteMut = useDeleteMcpServerMutation()
  const restartMut = useRestartMcpServerMutation()
  const connectOAuthMut = useConnectMcpOAuthMutation()

  const seedDraft = useMemo<McpServerDraft | null>(() => {
    if (serverQ.data?.name !== name) return null
    const cfg = serverQ.data?.config
    if (!cfg) return null
    return draftFromServerBody(name, cfg)
  }, [name, serverQ.data?.config, serverQ.data?.name])

  const [draft, setDraft] = useState<McpServerDraft | null>(seedDraft)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState<'back' | 'discard' | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const [seededFor, setSeededFor] = useState<string | null>(null)
  if (seedDraft && seededFor !== name) {
    setSeededFor(name)
    setDraft(seedDraft)
    setSaveError(null)
  }

  const dirty = !!seedDraft && !!draft && !draftEquals(draft, seedDraft)
  const fieldErrors = draft ? validateDraft(draft, { isNew: false }) : null
  const invalid = fieldErrors !== null
  const firstError = fieldErrors ? Object.values(fieldErrors)[0] : null

  const handleSave = async () => {
    if (!draft) return
    setSaveError(null)
    if (invalid) { setSaveError(firstError ?? 'Form has validation errors.'); return }
    const result = draftToServerBody(draft)
    if (!result.ok) { setSaveError(result.error); return }
    try {
      await updateMut.mutateAsync({ name, server: result.body })
      push({ tone: 'success', title: `Saved "${name}"`, description: 'Available on next turn.' })
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

  const handleRestart = async () => {
    try {
      await restartMut.mutateAsync(name)
      push({ tone: 'success', title: `Restarted "${name}"` })
    } catch (err) {
      const msg = errorMessage(err)
      push({ tone: 'error', title: `Failed to restart "${name}"`, description: msg })
    }
  }

  const handleConnectOAuth = async () => {
    try {
      await connectOAuthMut.mutateAsync(name)
      push({ tone: 'success', title: `Connected OAuth for "${name}"` })
    } catch (err) {
      const msg = errorMessage(err)
      push({ tone: 'error', title: `OAuth connect failed for "${name}"`, description: msg })
    }
  }

  const server = serverQ.data
  // Back goes through the same unsaved-changes check as closing Settings.
  const guardedBack = () => {
    if (dirty) setConfirmLeave('back')
    else onBack()
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="mcp"
        name={name}
        path=".openagentd/config/mcp.json"
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstError}
        onSave={handleSave}
        onBack={guardedBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${EDITOR_BODY} flex flex-col gap-8`}>
          {serverQ.isLoading && <SettingsSkeleton label="Loading server" />}
          {serverQ.isError && (
            <Callout
              tone="error"
              role="alert"
              title={`Couldn't load ${name}`}
              action={<Button size="sm" onClick={() => { void serverQ.refetch() }}>Retry</Button>}
            >
              {errorMessage(serverQ.error)}
            </Callout>
          )}

          {server && (
            <>
              <StatusCard server={server} />

              {server.state === 'error' && server.error && (
                <Callout tone="error" role="alert" title="Server failed to start">
                  <p className="font-mono break-words">{server.error}</p>
                </Callout>
              )}

              {server.state === 'auth_required' && (
                <Callout
                  tone="warning"
                  title="Needs sign-in"
                  action={
                    <Button variant="default" size="sm" className="min-h-9 md:min-h-0"
                      onClick={handleConnectOAuth} disabled={connectOAuthMut.isPending || !server.enabled}>
                      {connectOAuthMut.isPending ? 'Signing in…' : 'Sign in'}
                    </Button>
                  }
                >
                  {server.enabled
                    ? 'Sign in with the server (OAuth) so agents can use its tools.'
                    : 'Turn the server on and save before you sign in.'}
                </Callout>
              )}

              {draft ? (
                <McpServerForm value={draft} onChange={setDraft} isNew={false} disabled={updateMut.isPending} errors={fieldErrors} />
              ) : (
                <PanelSection title="Configuration">
                  <p className="text-xs text-(--color-text-muted)">
                    No saved configuration found. The server may have been removed from <span className="font-mono">mcp.json</span>.
                  </p>
                </PanelSection>
              )}

              {dirty && (
                <div className="flex items-center gap-2 text-xs text-(--color-text-muted)">
                  <Button variant="ghost" size="xs" className="min-h-9 md:min-h-0"
                    onClick={() => setConfirmLeave('discard')}>Discard changes…</Button>
                </div>
              )}

              <RestartCard
                onRestart={handleRestart}
                pending={restartMut.isPending}
                enabled={server.enabled}
                dirty={dirty}
                onDelete={() => setDeleteOpen(true)}
                deletePending={deleteMut.isPending}
              />
            </>
          )}
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{name}&rdquo;?</DialogTitle>
            <DialogDescription>It is removed from mcp.json and its tools stop working. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>Delete server</Button>
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
          if (seedDraft) setDraft(seedDraft)
          if (confirmLeave === 'back') onBack()
        }}
      />
    </div>
  )
}

// ── Status ───────────────────────────────────────────────────────────────────

function StatusCard({ server }: { server: NonNullable<ReturnType<typeof useMcpServerQuery>['data']> }) {
  return (
    <PanelSection title="Status" description="The running connection, not your unsaved edits." flush>
      <PanelRow label="State">
        <McpStatusChip server={server} />
      </PanelRow>
      <PanelRow label="Transport">
        <Chip mono variant="outline" title={server.transport === 'stdio' ? TERMS.stdio : TERMS.http}>{server.transport}</Chip>
      </PanelRow>
      <PanelRow label="Started">
        <span className="text-xs text-(--color-text)">{server.started_at ? formatFullDateTime(new Date(server.started_at)) : 'Not running'}</span>
      </PanelRow>
      {server.tool_names.length > 0 && (
        <PanelRow label={`Tools · ${server.tool_names.length}`} stack>
          <div className="flex flex-wrap gap-1.5">
            {server.tool_names.map((tool) => (
              <Chip key={tool} mono variant="outline">{tool}</Chip>
            ))}
          </div>
        </PanelRow>
      )}
    </PanelSection>
  )
}

// ── Manage ───────────────────────────────────────────────────────────────────

function RestartCard({
  onRestart, pending, enabled, dirty, onDelete, deletePending,
}: {
  onRestart: () => void
  pending: boolean
  enabled: boolean
  dirty: boolean
  onDelete: () => void
  deletePending: boolean
}) {
  return (
    <PanelSection title="Manage" flush>
      <PanelRow
        label="Restart server"
        description={
          !enabled
            ? 'Turn the server on and save first.'
            : dirty
              ? 'Restart uses the saved settings. Save first to apply your edits.'
              : 'Reconnect to pick up changes or recover from an error.'
        }
      >
        <Button
          variant="default" size="sm"
          onClick={onRestart} disabled={pending || !enabled}
          aria-label={pending ? 'Restarting' : 'Restart server'}
        >
          <RotateCw size={12} className={cn(pending && 'animate-spin')} aria-hidden="true" />
          {pending ? 'Restarting…' : 'Restart'}
        </Button>
      </PanelRow>
      <PanelRow label="Delete server" description="Removes it from mcp.json. This can't be undone.">
        <Button variant="danger-subtle" size="sm" onClick={onDelete} disabled={deletePending}>
          <Trash2 size={12} aria-hidden="true" />
          {deletePending ? 'Deleting…' : 'Delete server…'}
        </Button>
      </PanelRow>
    </PanelSection>
  )
}
