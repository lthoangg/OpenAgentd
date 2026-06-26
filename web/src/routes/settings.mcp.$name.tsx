import { useMemo, useState } from 'react'
import { AlertCircle, RotateCw, Trash2 } from 'lucide-react'

import {
  useConnectMcpOAuthMutation,
  useDeleteMcpServerMutation,
  useMcpServerQuery,
  useRestartMcpServerMutation,
  useUpdateMcpServerMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { ApiValidationError } from '@/api/client'
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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

  const handleRestart = async () => {
    try {
      await restartMut.mutateAsync(name)
      push({ tone: 'success', title: `Restarted "${name}"` })
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
      push({ tone: 'error', title: `Failed to restart "${name}"`, description: msg })
    }
  }

  const handleConnectOAuth = async () => {
    try {
      await connectOAuthMut.mutateAsync(name)
      push({ tone: 'success', title: `Connected OAuth for "${name}"` })
    } catch (err) {
      const msg = err instanceof ApiValidationError ? err.message : String(err)
      push({ tone: 'error', title: `OAuth connect failed for "${name}"`, description: msg })
    }
  }

  const server = serverQ.data

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
        onBack={onBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          {serverQ.isLoading && <p className="text-sm text-(--color-text-muted)">Loading server…</p>}
          {serverQ.isError && <p className="text-sm text-(--color-error)">Failed to load: {String(serverQ.error)}</p>}

          {server && (
            <>
              <StatusCard server={server} />

              {server.state === 'error' && server.error && (
                <Card size="sm" className="border-(--color-error)/40 bg-(--color-error-subtle)">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-(--color-error)">
                      <AlertCircle size={14} className="text-(--color-error)" />
                      Runtime error
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="font-mono text-xs text-(--color-error)">{server.error}</p>
                  </CardContent>
                </Card>
              )}

              {server.state === 'auth_required' && (
                <Card size="sm" className="border-(--accent-orange)/40 bg-(--accent-orange)/10">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-(--accent-orange)">
                      <AlertCircle size={14} className="text-(--accent-orange)" />
                      OAuth needed to connect
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="mb-3 text-xs text-(--color-text-muted)">Connect OAuth to authorize this MCP server.</p>
                    <Button variant="default" size="sm" className="min-h-11 md:min-h-0"
                      onClick={handleConnectOAuth} disabled={connectOAuthMut.isPending || !server.enabled}>
                      {connectOAuthMut.isPending ? 'Connecting…' : 'Connect OAuth'}
                    </Button>
                  </CardContent>
                </Card>
              )}

              {draft ? (
                <McpServerForm value={draft} onChange={setDraft} isNew={false} disabled={updateMut.isPending} errors={fieldErrors} />
              ) : (
                <Card size="sm">
                  <CardContent className="pt-4">
                    <p className="text-xs text-(--color-text-muted)">
                      No saved configuration found. The server may have been removed from <span className="font-mono">mcp.json</span>.
                    </p>
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center justify-between gap-2 text-xs text-(--color-text-muted)">
                <div className="flex items-center gap-2">
                  {dirty && (
                    <>
                      <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                        onClick={() => seedDraft && setDraft(seedDraft)}>Discard changes</Button>
                      <Button variant="ghost" size="xs" className="min-h-11 md:min-h-0"
                        onClick={onBack}>Leave without saving</Button>
                    </>
                  )}
                </div>
                <Button variant="danger" size="xs" className="min-h-11 md:min-h-0"
                  onClick={() => setDeleteOpen(true)} disabled={deleteMut.isPending}>
                  <Trash2 size={11} aria-hidden="true" />
                  Delete server
                </Button>
              </div>

              <RestartCard onRestart={handleRestart} pending={restartMut.isPending} enabled={server.enabled} />
            </>
          )}
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete MCP server</DialogTitle>
            <DialogDescription>Delete `{name}` from mcp.json. This cannot be undone.</DialogDescription>
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

// ── Status card ──────────────────────────────────────────────────────────────

function StatusCard({ server }: { server: NonNullable<ReturnType<typeof useMcpServerQuery>['data']> }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Runtime status</CardTitle>
        <CardDescription>Live state of the running connection.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-xs sm:grid-cols-2">
        <Stat label="State">
          <span className={
            server.state === 'ready' ? 'text-(--accent-green)'
            : server.state === 'starting' ? 'text-(--accent-orange)'
            : server.state === 'auth_required' ? 'text-(--accent-orange)'
            : server.state === 'error' ? 'text-(--color-error)'
            : 'text-(--color-text-muted)'
          }>{server.state}</span>
        </Stat>
        <Stat label="Transport"><span className="font-mono">{server.transport}</span></Stat>
        <Stat label="Enabled">{server.enabled ? 'yes' : 'no'}</Stat>
        <Stat label="Started">{server.started_at ? new Date(server.started_at).toLocaleString() : '—'}</Stat>
        {server.tool_names.length > 0 && (
          <div className="sm:col-span-2">
            <p className="mb-1.5 text-xs font-medium text-(--color-text)">Tools ({server.tool_names.length})</p>
            <div className="flex flex-wrap gap-1">
              {server.tool_names.map((tool) => (
                <span key={tool} className="rounded-md bg-(--bg-key) px-1.5 py-0.5 font-mono text-[11px] text-(--color-text-muted)">{tool}</span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-(--color-text-muted)">{label}</span>
      <span className="font-medium text-(--color-text)">{children}</span>
    </div>
  )
}

// ── Restart card ─────────────────────────────────────────────────────────────

function RestartCard({ onRestart, pending, enabled }: { onRestart: () => void; pending: boolean; enabled: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Connection</CardTitle>
        <CardDescription>Restart the server process without changing its configuration.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          <Button variant="default" size="sm" className="min-h-11 md:min-h-0"
            onClick={onRestart} disabled={pending || !enabled} aria-label={pending ? 'Restarting' : 'Restart server'}>
            <RotateCw size={12} aria-hidden="true" />
            {pending ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
        {!enabled && (
          <p className="mt-2 text-[11px] text-(--color-text-muted)">Server is disabled — enable and save first to restart.</p>
        )}
      </CardContent>
    </Card>
  )
}
