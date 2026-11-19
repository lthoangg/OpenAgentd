import { useMemo, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatFullDateTime } from '@/utils/format'

import { cancelMcpSignIn, type ServerStatus } from '@/api/client'
import {
  useApproveMcpServerMutation,
  useConnectMcpOAuthMutation,
  useSignOutMcpServerMutation,
  useDeleteMcpServerMutation,
  useMcpServerQuery,
  useRestartMcpServerMutation,
  useRevokeMcpServerMutation,
  useUpdateMcpServerMutation,
} from '@/queries'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useToastStore } from '@/stores/useToastStore'
import { EditorDeleteRow } from '@/components/settings/EditorDeleteRow'
import { EditorSubHeader } from '@/components/settings/EditorSubHeader'
import { ConnectorIcon } from '@/components/ConnectorIcon'
import { SaveBar } from '@/components/settings/SaveBar'
import { McpServerForm } from '@/components/settings/McpServerForm'
import { McpSignInWaiting } from '@/components/settings/McpSignInWaiting'
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
import { failureToast } from '@/lib/failure-toast'

interface McpServerDetailPageProps {
  name: string
  onBack: () => void
}

export function ConnectorDetailPage({ name, onBack }: McpServerDetailPageProps) {
  const push = useToastStore((s) => s.push)
  const serverQ = useMcpServerQuery(name)
  const updateMut = useUpdateMcpServerMutation()
  const deleteMut = useDeleteMcpServerMutation()
  const restartMut = useRestartMcpServerMutation()
  const connectOAuthMut = useConnectMcpOAuthMutation()
  const signOutMut = useSignOutMcpServerMutation()
  const approveMut = useApproveMcpServerMutation()
  const revokeMut = useRevokeMcpServerMutation()

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
      push({ tone: 'success', title: `Saved "${name}"`, description: 'Applies to your next message.' })
    } catch (err) {
      const msg = errorMessage(err)
      setSaveError(msg)
      push(failureToast(`Couldn't save "${name}"`, err))
    }
  }

  const handleDelete = async () => {
    try {
      await deleteMut.mutateAsync(name)
      push({ tone: 'success', title: `Deleted "${name}"` })
      onBack()
    } catch (err) {
      push(failureToast(`Couldn't delete "${name}"`, err))
    }
  }

  const handleRestart = async () => {
    try {
      await restartMut.mutateAsync(name)
      push({ tone: 'success', title: `Restarted "${name}"` })
    } catch (err) {
      const msg = errorMessage(err)
      push({ tone: 'error', title: `Couldn't restart "${name}"`, description: msg })
    }
  }

  const handleSignOut = async () => {
    try {
      await signOutMut.mutateAsync(name)
      push({ tone: 'success', title: `Signed out of "${name}"` })
    } catch (err) {
      push({ tone: 'error', title: `Couldn't sign out of "${name}"`, description: errorMessage(err) })
    }
  }

  const handleConnectOAuth = async () => {
    try {
      await connectOAuthMut.mutateAsync(name)
      push({ tone: 'success', title: `Signed in to "${name}"` })
    } catch (err) {
      const msg = errorMessage(err)
      push({ tone: 'error', title: `Couldn't sign in to "${name}"`, description: msg })
    }
  }

  const server = serverQ.data
  // A server a plugin bundle brings belongs to the bundle: it has no form, no
  // Save and no Delete here, only a way to restart it.
  const plugin = server?.plugin ?? null
  // A server a project ships belongs to its `.agents/mcp.json` the same way,
  // and runs once the user allows it.
  const project = server?.project ?? null
  const owned = !!plugin || !!project
  const label = project?.name ?? name

  const handleApproval = async (allow: boolean) => {
    try {
      await (allow ? approveMut : revokeMut).mutateAsync(name)
      push({ tone: 'success', title: allow ? `Allowed "${label}"` : `Revoked "${label}"` })
    } catch (err) {
      push({ tone: 'error', title: allow ? `Couldn't allow "${label}"` : `Couldn't revoke "${label}"`, description: errorMessage(err) })
    }
  }
  // Back goes through the same unsaved-changes check as closing Settings.
  const guardedBack = () => {
    if (dirty) setConfirmLeave(true)
    else onBack()
  }

  return (
    <div className="flex h-full flex-col">
      <EditorSubHeader
        kind="mcp"
        name={label}
        leading={server?.gallery ? <ConnectorIcon name={server.gallery.name} icon={server.gallery.icon} /> : undefined}
        path={owned ? undefined : '.openagentd/config/mcp.json'}
        dirty={dirty}
        invalid={invalid}
        saving={updateMut.isPending}
        error={saveError}
        validationHint={firstError}
        onBack={guardedBack}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`${EDITOR_BODY} flex flex-col gap-8`}>
          {serverQ.isLoading && <SettingsSkeleton label="Loading connector" />}
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
                <Callout tone="error" role="alert" title="It did not start">
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
                    ? 'Sign in so agents can use its tools.'
                    : plugin
                      ? 'Turn the plugin on in Plugins before you sign in.'
                      : 'Turn it on and save before you sign in.'}
                  {connectOAuthMut.isPending && <McpSignInWaiting className="mt-2" onCancel={() => void cancelMcpSignIn(name)} />}
                </Callout>
              )}

              {project ? (
                <ProjectServerConfig
                  server={server}
                  file={`${project.workspace}/.agents/mcp.json`}
                  pending={approveMut.isPending || revokeMut.isPending}
                  onApproval={(allow) => void handleApproval(allow)}
                />
              ) : plugin ? (
                <PluginServerConfig server={server} plugin={plugin} />
              ) : draft ? (
                <McpServerForm value={draft} onChange={setDraft} isNew={false} disabled={updateMut.isPending} errors={fieldErrors} />
              ) : (
                <PanelSection title="Configuration">
                  <p className="text-xs text-(--color-text-muted)">
                    No saved configuration found. It may have been removed from <span className="font-mono">mcp.json</span>.
                  </p>
                </PanelSection>
              )}

              <RestartCard
                onRestart={handleRestart}
                pending={restartMut.isPending}
                enabled={server.enabled && server.state !== 'needs_approval'}
                dirty={dirty}
                plugin={plugin}
                project={!!project}
                signOut={server.signed_in && signsInWithOAuth(server) ? { run: () => void handleSignOut(), pending: signOutMut.isPending } : null}
              />
              {!owned && (
                <EditorDeleteRow
                  thing="connector"
                  description="Removes it from mcp.json."
                  onDelete={() => setDeleteOpen(true)}
                  pending={deleteMut.isPending}
                />
              )}
            </>
          )}
        </div>
      </div>

      {!owned && (
        <SaveBar
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
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{name}&rdquo;?</DialogTitle>
            <DialogDescription>It is removed from mcp.json and its tools stop working.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={handleDelete} disabled={deleteMut.isPending}>Delete connector</Button>
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
      <PanelRow label="Connects by">
        <span className="text-xs text-(--color-text)">
          {server.transport === 'stdio' ? 'A program on this computer' : server.transport === 'sse' ? 'A web address (SSE only)' : 'A web address'}
        </span>
      </PanelRow>
      {server.plugin && (
        <PanelRow label="Source">
          <Chip>{`from ${server.plugin}`}</Chip>
        </PanelRow>
      )}
      {server.project && (
        <PanelRow label="Source">
          <Chip title={server.project.workspace}>from this project</Chip>
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
        <PanelRow label="Address" stack>
          <code className={CODE_LINE}>{config.url}</code>
        </PanelRow>
      )}
      <PanelRow label="Turn on or off" description="It goes on and off with its plugin.">
        <Button variant="default" size="sm" onClick={() => setSection('plugins')}>Open plugins</Button>
      </PanelRow>
    </PanelSection>
  )
}

// ── Manage ───────────────────────────────────────────────────────────────────

/**
 * What a project's server runs, or connects to, as text: the project's
 * `.agents/mcp.json` owns it. It runs once allowed, as its entry is now; a
 * changed entry asks again.
 */
function ProjectServerConfig({
  server, file, pending, onApproval,
}: {
  server: ServerStatus
  file: string
  pending: boolean
  onApproval: (allow: boolean) => void
}) {
  const config = server.config
  const waiting = server.state === 'needs_approval'
  return (
    <PanelSection title="Configuration" description={`Defined in ${file}. Edit that file to change it.`} flush>
      {config?.transport === 'stdio' && (
        <PanelRow label="Command" stack>
          <code className={CODE_LINE}>{commandLine(config.command, config.args)}</code>
        </PanelRow>
      )}
      {config && config.transport !== 'stdio' && (
        <PanelRow label="Address" stack>
          <code className={CODE_LINE}>{config.url}</code>
        </PanelRow>
      )}
      <PanelRow
        label="Allow it to run"
        description={waiting
          ? 'It runs in this workspace only, once you allow it as it is now.'
          : 'Allowed for this workspace. Revoking stops it; it asks again before it runs.'}
      >
        {waiting ? (
          <Button variant="default" size="sm" disabled={pending} onClick={() => onApproval(true)}>Allow</Button>
        ) : (
          <Button variant="default" size="sm" disabled={pending} onClick={() => onApproval(false)}>Revoke</Button>
        )}
      </PanelRow>
    </PanelSection>
  )
}

/** A web-address connector that signs in at its service (not one whose Authorization header carries its credentials). */
function signsInWithOAuth(server: ServerStatus): boolean {
  const c = server.config
  if (!c || c.transport === 'stdio') return false
  return !!c.oauth || !Object.keys(c.headers ?? {}).some((h) => h.toLowerCase() === 'authorization')
}

function RestartCard({
  onRestart, pending, enabled, dirty, plugin, project = false, signOut,
}: {
  onRestart: () => void
  pending: boolean
  enabled: boolean
  dirty: boolean
  /** The bundle that owns the server, if any. */
  plugin: string | null
  /** The project's `.agents/mcp.json` owns the server. */
  project?: boolean
  /** Sign out of a connector that is signed in. */
  signOut: { run: () => void; pending: boolean } | null
}) {
  return (
    <PanelSection title="Manage" flush>
      <PanelRow
        label="Restart"
        description={
          !enabled
            ? project ? 'Allow it first, or turn it on in the project\'s file.' : plugin ? 'Turn the plugin on in Plugins first.' : 'Turn it on and save first.'
            : dirty
              ? 'Restart uses the saved settings. Save first to apply your edits.'
              : 'Reconnect to pick up changes or recover from an error.'
        }
      >
        <Button
          variant="default" size="sm"
          onClick={onRestart} disabled={pending || !enabled}
          aria-label={pending ? 'Restarting' : 'Restart connector'}
        >
          <RotateCw size={12} className={cn(pending && 'animate-spin')} aria-hidden="true" />
          {pending ? 'Restarting…' : 'Restart'}
        </Button>
      </PanelRow>
      {signOut && (
        <PanelRow label="Sign out" description="Forgets this sign-in. The connector stays; sign in again to use it.">
          <Button variant="default" size="sm" onClick={signOut.run} disabled={signOut.pending}>
            {signOut.pending ? 'Signing out…' : 'Sign out'}
          </Button>
        </PanelRow>
      )}
    </PanelSection>
  )
}
