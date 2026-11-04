import { useMemo, useState } from 'react'
import { RotateCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatFullDateTime } from '@/utils/format'

import type { ServerStatus } from '@/api/client'
import {
  useConnectMcpOAuthMutation,
  useDeleteMcpServerMutation,
  useMcpServerQuery,
  useRestartMcpServerMutation,
  useUpdateMcpServerMutation,
} from '@/queries'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useToastStore } from '@/stores/useToastStore'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { SaveBar } from '@/components/settings/SaveBar'
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
import { commandLine } from '@/utils/command-line'
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
  const [confirmLeave, setConfirmLeave] = useState(false)
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
  // A server a plugin bundle brings belongs to the bundle: it has no form, no
  // Save and no Delete here, only a way to restart it.
  const plugin = server?.plugin ?? null
  // Back goes through the same unsaved-changes check as closing Settings.
  const guardedBack = () => {
    if (dirty) setConfirmLeave(true)
    else onBack()
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="mcp"
        name={name}
        path={plugin ? undefined : '.openagentd/config/mcp.json'}
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstError}
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
                    : plugin
                      ? 'Turn the plugin on in Plugins before you sign in.'
                      : 'Turn the server on and save before you sign in.'}
                </Callout>
              )}

              {plugin ? (
                <PluginServerConfig server={server} plugin={plugin} />
              ) : draft ? (
                <McpServerForm value={draft} onChange={setDraft} isNew={false} disabled={updateMut.isPending} errors={fieldErrors} />
              ) : (
                <PanelSection title="Configuration">
                  <p className="text-xs text-(--color-text-muted)">
                    No saved configuration found. The server may have been removed from <span className="font-mono">mcp.json</span>.
                  </p>
                </PanelSection>
              )}

              <RestartCard
                onRestart={handleRestart}
                pending={restartMut.isPending}
                enabled={server.enabled}
                dirty={dirty}
                plugin={plugin}
                onDelete={plugin ? undefined : () => setDeleteOpen(true)}
                deletePending={deleteMut.isPending}
              />
            </>
          )}
        </div>
      </div>

      {!plugin && (
        <SaveBar
          shortcut
          draft={{
            dirty,
            canSave: dirty && !invalid && !updateMut.isPending,
            isSaving: updateMut.isPending,
            save: handleSave,
            reset: () => {
              if (seedDraft) setDraft(seedDraft)
              setSaveError(null)
            },
          }}
          onSave={() => { void handleSave() }}
          saveBlockedReason={invalid ? (firstError ?? 'Fix the errors above to save.') : null}
          discardDescription={`Your edits to ${name} go back to the last saved version.`}
        />
      )}

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
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Leave without saving?"
        description={`Your edits to ${name} go back to the last saved version.`}
        confirmLabel="Leave without saving"
        onConfirm={onBack}
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
        <Chip mono title={server.transport === 'stdio' ? TERMS.stdio : TERMS.http}>{server.transport}</Chip>
      </PanelRow>
      {server.plugin && (
        <PanelRow label="Source">
          <Chip>{`from ${server.plugin}`}</Chip>
        </PanelRow>
      )}
      <PanelRow label="Started">
        <span className="text-xs text-(--color-text)">{server.started_at ? formatFullDateTime(new Date(server.started_at)) : 'Not running'}</span>
      </PanelRow>
      {server.tool_names.length > 0 && (
        <PanelRow label={`Tools · ${server.tool_names.length}`} stack>
          <div className="flex flex-wrap gap-1.5">
            {server.tool_names.map((tool) => (
              <Chip key={tool} mono>{tool}</Chip>
            ))}
          </div>
        </PanelRow>
      )}
    </PanelSection>
  )
}

// ── Plugin servers ───────────────────────────────────────────────────────────

const CODE_LINE = 'rounded-xs bg-(--bg-key) px-1.5 py-0.5 font-mono text-meta text-(--color-text) [overflow-wrap:anywhere]'

/**
 * What a plugin's server runs, or connects to, as text. The bundle owns it, so
 * it is not a form: the server goes on and off with the bundle, in Plugins.
 */
function PluginServerConfig({ server, plugin }: { server: ServerStatus; plugin: string }) {
  const setSection = useSettingsStore((s) => s.setSection)
  const config = server.config
  return (
    <PanelSection title="Configuration" description={`Defined by the plugin ${plugin}. It can't be edited here.`} flush>
      {config?.transport === 'stdio' && (
        <PanelRow label="Command" stack>
          <code className={CODE_LINE}>{commandLine(config.command, config.args)}</code>
        </PanelRow>
      )}
      {config && config.transport !== 'stdio' && (
        <PanelRow label="URL" stack>
          <code className={CODE_LINE}>{config.url}</code>
        </PanelRow>
      )}
      <PanelRow label="Turn on or off" description="The server goes on and off with its plugin.">
        <Button variant="default" size="sm" onClick={() => setSection('plugins')}>Open Plugins</Button>
      </PanelRow>
    </PanelSection>
  )
}

// ── Manage ───────────────────────────────────────────────────────────────────

function RestartCard({
  onRestart, pending, enabled, dirty, plugin, onDelete, deletePending,
}: {
  onRestart: () => void
  pending: boolean
  enabled: boolean
  dirty: boolean
  /** The bundle that owns the server, if any. */
  plugin: string | null
  /** Omitted for a plugin's server: it is not removed here. */
  onDelete?: () => void
  deletePending: boolean
}) {
  return (
    <PanelSection title="Manage" flush>
      <PanelRow
        label="Restart server"
        description={
          !enabled
            ? plugin ? 'Turn the plugin on in Plugins first.' : 'Turn the server on and save first.'
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
      {onDelete && (
        <PanelRow label="Delete server" description="Removes it from mcp.json. This can't be undone.">
          <Button variant="danger-subtle" size="sm" onClick={onDelete} disabled={deletePending}>
            <Trash2 size={12} aria-hidden="true" />
            {deletePending ? 'Deleting…' : 'Delete server…'}
          </Button>
        </PanelRow>
      )}
    </PanelSection>
  )
}
