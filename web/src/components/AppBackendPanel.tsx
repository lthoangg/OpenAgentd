/**
 * AppBackendPanel — choose which OpenAgentd server this app talks to.
 *
 * One panel, two hosts: Settings → Server renders it as a page, and
 * `AppBackendDialog` wraps it for the places that need it before or outside
 * Settings (the loading screen, the footer health dot, a scanned connect
 * link). All connection logic lives here; the hosts only provide chrome.
 *
 * Top to bottom: the servers (the built-in server first, then the saved
 * ones) and, in the desktop shell, network access for other devices. There
 * is no separate "current server" card: the connected server's row carries
 * the **In use** badge, and a connected server that is not saved gets a row
 * of its own.
 *
 * A row's **Use** switches the app to it and **In use** marks the one the
 * app talks to now. **Edit** opens that server's form right under its row,
 * saved in place without switching; **Add a server**, at the end of the
 * list, opens the form for a new one (test, then save and use). No form
 * opens by itself, except for a scanned connect link.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { PanelSection } from '@/components/ui/panel-section'
import { ICON_SIZE_INLINE, ROW_PAD, TEXT } from '@/components/settings/tokens'
import { isDesktopShell } from '@/lib/desktop-shell'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { cn } from '@/lib/utils'

import { apiBaseUrl, setApiBaseUrl } from '@/api/base-url'
import { getStoredAccessKey, setStoredAccessKey } from '@/api/auth'
import {
  connectBundledBackend,
  connectExternalBackend,
  connectionFailureMessage,
  currentBackendOrigin,
  normalizeServerBaseUrl,
  refreshBackendQueries,
  reloadForBackendSwitch,
  validateServerUrl,
} from '@/lib/backend-switch'
import {
  getAppBackendStatus,
  getServerWatchStates,
  removeAppBackendServer,
  saveAppBackendServer,
  setAppBackendServerEnabled,
  stopBundledAppBackend,
  type SavedAppServer,
  type AppBackendStatus,
  type ServerWatchState,
} from '@/lib/app-backend'

const DEFAULT_SERVERS: SavedAppServer[] = [{ base_url: 'http://127.0.0.1:4082', name: 'Local server' }]

/** How often the background connection states refresh while the panel is open. */
const WATCH_POLL_MS = 3000

/** The server the app is connected to when it is not in the saved list (normalized), else null. */
function unlistedConnectedUrl(status: AppBackendStatus | null, servers: SavedAppServer[]): string | null {
  if (!status || !(status.mode === 'external' || status.external)) return null
  const url = normalizeServerBaseUrl(status.base_url)
  return servers.some((server) => normalizeServerBaseUrl(server.base_url) === url) ? null : url
}

/** The line under a saved server: its background connection, or that it is not watched. */
function watchNote(state: ServerWatchState | undefined, enabled: boolean): { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } | null {
  switch (state) {
    case 'connected': return { text: 'Watching', tone: 'ok' }
    case 'connecting': return { text: 'Connecting…', tone: 'muted' }
    case 'reconnecting': return { text: 'Reconnecting · server not reachable', tone: 'warn' }
    case 'key_rejected': return { text: 'Access key rejected · update it with Edit', tone: 'error' }
    default: return enabled ? null : { text: 'Disabled · not watched', tone: 'muted' }
  }
}

/** Server details from a scanned `openagentd://connect` link. */
export interface AppBackendPrefill {
  baseUrl: string
  accessKey: string
}

type Health = 'checking' | 'online' | 'offline'

interface AppBackendPanelProps {
  /** Loads status and probes servers when it turns true (dialog open, page shown). */
  active: boolean
  /** Fill the form and test it; the user still confirms with Save and use. */
  prefill?: AppBackendPrefill | null
  /**
   * Include desktop network access. The dialog does; Settings → Server shows
   * its own "Access from other devices" card.
   */
  showNetworkAccess?: boolean
}

/**
 * The open server form: adding one (at the end of the list, from "Add a
 * server"), or editing a saved one (right under its row, from its Edit).
 * One at a time; neither opens by itself, except for a scanned link.
 */
type ServerFormTarget =
  | { kind: 'add' }
  | { kind: 'edit'; baseUrl: string; label: string; inUse: boolean }

export function AppBackendPanel({ active, prefill = null, showNetworkAccess = false }: AppBackendPanelProps) {
  const [status, setStatus] = useState<AppBackendStatus | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'stop' } | { kind: 'remove'; baseUrl: string; label: string } | null>(null)
  const [form, setForm] = useState<ServerFormTarget | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [accessKey, setAccessKeyInput] = useState('')
  /** What the edited server had, so a rename saves without a new test. */
  const [original, setOriginal] = useState<{ baseUrl: string; accessKey: string } | null>(null)
  const [testedBaseUrl, setTestedBaseUrl] = useState<string | null>(null)
  const [serverHealth, setServerHealth] = useState<Record<string, Health>>({})
  const [pending, setPending] = useState(false)
  /** A list action that failed (Use, Start, Stop, Remove, Enabled). */
  const [listError, setListError] = useState<string | null>(null)
  /** Test or Save in the open form failed. */
  const [formError, setFormError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  const [watchStates, setWatchStates] = useState<Record<string, ServerWatchState>>({})
  const watchable = isDesktopShell() && status?.supports_bundled !== false
  // Where focus goes back to when a form closes.
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  // The desktop shell watches enabled servers in the background; show how that goes.
  useEffect(() => {
    if (!active || !watchable) return
    let cancelled = false
    const load = () => {
      void getServerWatchStates().then((next) => {
        if (!cancelled) setWatchStates(next)
      })
    }
    load()
    const timer = setInterval(load, WATCH_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, watchable])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void getAppBackendStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      setListError(null)
      setScanned(Boolean(prefill))
      // A scanned link opens the add form, filled in and tested; otherwise no form is open.
      if (prefill) fillForm({ kind: 'add' }, prefill.baseUrl, hostnameOf(prefill.baseUrl), prefill.accessKey)
      else setForm(null)
      const servers = next?.servers ?? DEFAULT_SERVERS
      // The connected server is checked too, saved or not.
      const unlisted = unlistedConnectedUrl(next, servers)
      const toCheck = [...servers.map((server) => normalizeServerBaseUrl(server.base_url)), ...(unlisted ? [unlisted] : [])]
      setServerHealth(Object.fromEntries(toCheck.map((url) => [url, 'checking'])))
      for (const normalized of toCheck) {
        void pingServer(normalized).then((online) => {
          if (cancelled) return
          setServerHealth((prev) => ({ ...prev, [normalized]: online ? 'online' : 'offline' }))
        })
      }
      if (prefill) void testConnection(prefill.baseUrl, prefill.accessKey)
    })
    return () => { cancelled = true }
  }, [active, prefill])

  function fillForm(target: ServerFormTarget, nextBaseUrl: string, nextName: string, nextKey: string) {
    setForm(target)
    setBaseUrl(nextBaseUrl)
    setServerName(nextName)
    setAccessKeyInput(nextKey)
    setTestedBaseUrl(null)
    setFormError(null)
  }

  /** "Add a server": the empty form at the end of the list. */
  function openAdd() {
    setOriginal(null)
    fillForm({ kind: 'add' }, '', '', '')
  }

  /** A row's Edit: the server's details in a form right under it. */
  function openEdit(server: SavedAppServer, inUse: boolean) {
    const normalized = normalizeServerBaseUrl(server.base_url)
    const label = server.name || server.base_url
    setOriginal({ baseUrl: normalized, accessKey: '' })
    fillForm({ kind: 'edit', baseUrl: normalized, label, inUse }, normalized, server.name ?? '', '')
    void getStoredAccessKey(normalized).then((storedKey) => {
      setAccessKeyInput(storedKey ?? '')
      setOriginal({ baseUrl: normalized, accessKey: storedKey ?? '' })
    })
  }

  function closeForm() {
    const target = form
    setForm(null)
    setFormError(null)
    setScanned(false)
    // After the render: the add form stands where its button goes back.
    requestAnimationFrame(() => {
      const opener = target?.kind === 'edit' ? editButtonRefs.current.get(target.baseUrl) : addButtonRef.current
      opener?.focus()
    })
  }

  async function connectExternal(nextBaseUrl: string, nextName: string, typedKey: string, onError: (error: string) => void) {
    setPending(true)
    setListError(null)
    setFormError(null)
    const result = await connectExternalBackend({
      baseUrl: nextBaseUrl,
      name: nextName,
      persist: true,
      accessKey: typedKey,
      currentBaseUrl: currentBackendOrigin(status),
      onHealth: (target, online) => setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' })),
    })
    setPending(false)
    if (!result.ok) {
      onError(result.error)
      return false
    }
    setStatus(result.status)
    if (result.reload) reloadForBackendSwitch()
    return true
  }

  async function testConnection(rawBaseUrl: string = baseUrl, rawAccessKey: string = accessKey) {
    const target = normalizeServerBaseUrl(rawBaseUrl)
    const validationError = validateServerUrl(target)
    if (validationError) {
      setFormError(validationError)
      return
    }
    setPending(true)
    setFormError(null)
    try {
      const online = await pingServer(target)
      setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' }))
      if (!online) {
        setFormError(connectionFailureMessage(target))
        return
      }
      const keyForTest = rawAccessKey.trim() || await getStoredAccessKey(target) || ''
      const authorized = await checkServerAuth(target, keyForTest)
      if (!authorized) {
        setFormError('Server is reachable, but the access key is invalid or missing.')
        return
      }
      if (rawAccessKey.trim()) await setStoredAccessKey(rawAccessKey, target)
      setTestedBaseUrl(target)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function connectBundled() {
    setPending(true)
    setListError(null)
    const result = await connectBundledBackend(currentBackendOrigin(status))
    setPending(false)
    if (!result.ok) {
      setListError(result.error)
      return
    }
    setStatus(result.status)
    if (result.reload) reloadForBackendSwitch()
  }

  async function stopBundled() {
    await runConnectionSwitch(() => stopBundledAppBackend())
  }

  /** The add form's Save and use: a tested server is stored and the app switches to it. */
  async function saveAndConnect() {
    const target = normalizeServerBaseUrl(baseUrl)
    if (testedBaseUrl !== target) {
      setFormError('Test the current server URL and access key before saving.')
      return
    }
    if (await connectExternal(target, serverName, accessKey, setFormError)) setForm(null)
  }

  /**
   * The edit form's Save: the server is updated where it is, without
   * switching to it. A new address or key needs a passing Test first; a
   * rename does not. The server in use follows its new address.
   */
  async function saveEdit() {
    if (form?.kind !== 'edit') return
    const target = normalizeServerBaseUrl(baseUrl)
    const moved = target !== form.baseUrl
    const keyChanged = accessKey.trim() !== (original?.accessKey ?? '').trim()
    if ((moved || keyChanged) && testedBaseUrl !== target) {
      setFormError('Test the new address or access key before saving.')
      return
    }
    if (moved && form.inUse) {
      // The app talks to it: switch to the new address, then drop the old one.
      if (!await connectExternal(target, serverName, accessKey, setFormError)) return
      await removeAppBackendServer(form.baseUrl).catch(() => undefined)
      setForm(null)
      return
    }
    setPending(true)
    setFormError(null)
    try {
      let next = await saveAppBackendServer(target, serverName)
      if (moved) next = await removeAppBackendServer(form.baseUrl)
      setStatus(next)
      closeForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function toggleEnabled(server: SavedAppServer, enabled: boolean) {
    setListError(null)
    try {
      setStatus(await setAppBackendServerEnabled(normalizeServerBaseUrl(server.base_url), enabled))
      setWatchStates(await getServerWatchStates())
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeServer(baseUrl: string) {
    setPending(true)
    setListError(null)
    try {
      const next = await removeAppBackendServer(baseUrl)
      if (next.base_url) setApiBaseUrl(next.base_url)
      await refreshBackendQueries()
      setStatus(next)
      setServerHealth((prev) => {
        const { [baseUrl]: _removed, ...rest } = prev
        return rest
      })
      if (form?.kind === 'edit' && form.baseUrl === normalizeServerBaseUrl(baseUrl)) setForm(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function runConnectionSwitch(
    action: () => Promise<void>,
  ): Promise<AppBackendStatus | null> {
    setPending(true)
    setListError(null)
    try {
      await action()
      const next = await getAppBackendStatus()
      if (next?.base_url) setApiBaseUrl(next.base_url)
      await refreshBackendQueries()
      setStatus(next)
      return next
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPending(false)
    }
  }

  const servers = status?.servers ?? DEFAULT_SERVERS
  // Browser builds have no shell status and a relative `/api` base: show the page origin.
  const currentUrl = status?.base_url || apiBaseUrl().replace(/\/api$/, '') || window.location.origin
  const onExternal = status?.mode === 'external' || Boolean(status?.external)
  // A connected server that is not in the saved list still gets a row. Without
  // shell status (a browser) the one server is the page's own.
  const unlistedUrl = status ? unlistedConnectedUrl(status, servers) : normalizeServerBaseUrl(currentUrl)
  const tested = testedBaseUrl !== null && testedBaseUrl === normalizeServerBaseUrl(baseUrl)
  const editTarget = form?.kind === 'edit' ? form : null
  // A rename saves at once; a new address or key waits for Test.
  const editNeedsTest = editTarget !== null && (
    normalizeServerBaseUrl(baseUrl) !== editTarget.baseUrl
    || accessKey.trim() !== (original?.accessKey ?? '').trim()
  )

  const serverForm = (target: ServerFormTarget) => (
    <ServerForm
      mode={target.kind}
      label={target.kind === 'edit' ? target.label : null}
      baseUrl={baseUrl}
      accessKey={accessKey}
      serverName={serverName}
      onBaseUrlChange={(value) => { setBaseUrl(value); setTestedBaseUrl(null) }}
      onAccessKeyChange={(value) => { setAccessKeyInput(value); setTestedBaseUrl(null) }}
      onServerNameChange={setServerName}
      error={formError}
      tested={tested}
      needsTest={target.kind === 'add' || editNeedsTest}
      pending={pending}
      onTest={() => void testConnection()}
      onSave={() => void (target.kind === 'add' ? saveAndConnect() : saveEdit())}
      onCancel={closeForm}
    />
  )

  return (
    <div className="space-y-8">
      {scanned ? (
        <Callout tone="info" role="status">
          Scanned from another device. Check the server, then save and use it.
        </Callout>
      ) : null}

      {/* Servers: each row's Edit opens its form under it; Add a server opens one at the end. */}
      <PanelSection
        title="Servers"
        description="Use switches the app to a server. Edit changes its address, key or name."
        flush
      >
        {status?.supports_bundled !== false ? (
          <ServerRow
            health={status?.sidecar_running ? 'online' : undefined}
            title="Built-in server"
            subtitle={`Runs inside this app · ${status?.sidecar_running ? 'Running' : 'Stopped'}`}
            address={status && !status.external ? currentUrl : undefined}
            inUse={status !== null && !status.external}
          >
            {status?.sidecar_running ? (
              <>
                {status?.external ? (
                  <Button type="button" variant="subtle" size="sm" aria-label="Use built-in server" onClick={() => { void connectBundled() }} disabled={pending}>
                    Use
                  </Button>
                ) : null}
                <Button type="button" variant="danger-subtle" size="sm" onClick={() => setConfirm({ kind: 'stop' })} disabled={pending}>
                  Stop…
                </Button>
              </>
            ) : (
              // Stopped: Use also starts it, and says so.
              <Button type="button" variant="subtle" size="sm" onClick={() => { void connectBundled() }} disabled={pending}>
                Start and use
              </Button>
            )}
          </ServerRow>
        ) : null}
        {unlistedUrl ? (
          <ServerRow
            health={status ? serverHealth[unlistedUrl] : 'online'}
            title={status ? unlistedUrl : 'This server'}
            mono={Boolean(status)}
            subtitle={status ? 'Not in your saved servers' : unlistedUrl}
            inUse
          >
            {null}
          </ServerRow>
        ) : null}
        {servers.map((server) => {
          const normalizedServerUrl = normalizeServerBaseUrl(server.base_url)
          const active = onExternal && normalizeServerBaseUrl(currentUrl) === normalizedServerUrl
          const label = server.name || server.base_url
          const enabled = server.enabled === true
          const note = watchable ? watchNote(watchStates[normalizedServerUrl], enabled) : null
          const editing = editTarget?.baseUrl === normalizedServerUrl
          return (
            <Fragment key={server.base_url}>
              <ServerRow
                health={serverHealth[normalizedServerUrl] ?? serverHealth[server.base_url]}
                title={label}
                subtitle={server.name ? server.base_url : undefined}
                mono={!server.name}
                note={note}
                inUse={active}
              >
                {watchable ? (
                  <label className={cn('mr-1 flex items-center gap-2', TEXT.hint)}>
                    Enabled
                    <Switch
                      checked={enabled}
                      onCheckedChange={(next) => { void toggleEnabled(server, next) }}
                      disabled={pending}
                      aria-label={`Enable ${label}`}
                    />
                  </label>
                ) : null}
                {active ? null : (
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    aria-label={`Use ${label}`}
                    onClick={() => { void connectExternal(normalizedServerUrl, server.name ?? '', '', setListError) }}
                    disabled={pending}
                  >
                    Use
                  </Button>
                )}
                <Button
                  ref={(node) => {
                    if (node) editButtonRefs.current.set(normalizedServerUrl, node)
                    else editButtonRefs.current.delete(normalizedServerUrl)
                  }}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${label}`}
                  aria-expanded={editing}
                  onClick={() => (editing ? closeForm() : openEdit(server, active))}
                  disabled={pending}
                >
                  <Pencil size={ICON_SIZE_INLINE} aria-hidden="true" />
                  Edit
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-(--color-text-muted) hover:text-(--color-error)"
                        onClick={() => setConfirm({ kind: 'remove', baseUrl: server.base_url, label })}
                        disabled={pending}
                        aria-label={`Remove ${label}…`}
                      >
                        <Trash2 size={ICON_SIZE_INLINE} aria-hidden="true" />
                      </Button>
                    }
                  />
                  <TooltipContent>Remove server…</TooltipContent>
                </Tooltip>
              </ServerRow>
              {editing && editTarget ? serverForm(editTarget) : null}
            </Fragment>
          )
        })}
        {form?.kind === 'add' ? serverForm(form) : (
          <div className={ROW_PAD}>
            <Button ref={addButtonRef} type="button" variant="ghost" size="sm" onClick={openAdd} disabled={pending}>
              <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
              Add a server
            </Button>
          </div>
        )}
      </PanelSection>

      {listError ? (
        <Callout tone="error" role="alert">{listError}</Callout>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm?.kind === 'stop' ? 'Stop the built-in server?' : `Remove ${confirm?.kind === 'remove' ? confirm.label : 'server'}?`}
        description={confirm?.kind === 'stop'
          ? 'Running agents stop and this app disconnects until you start it again or connect to another server.'
          : 'The server is removed from this list. The server itself keeps running.'}
        confirmLabel={confirm?.kind === 'stop' ? 'Stop server' : 'Remove server'}
        onConfirm={async () => {
          if (confirm?.kind === 'stop') await stopBundled()
          else if (confirm?.kind === 'remove') await removeServer(confirm.baseUrl)
        }}
      />

      {showNetworkAccess && isDesktopShell() && status?.supports_bundled !== false ? <NetworkAccessCard /> : null}
    </div>
  )
}

/**
 * The fields and actions of one server form, drawn where it was opened:
 * under the row being edited, or at the end of the list for a new one.
 * Escape cancels it (and only it, not the dialog around it).
 */
function ServerForm({
  mode,
  label,
  baseUrl,
  accessKey,
  serverName,
  onBaseUrlChange,
  onAccessKeyChange,
  onServerNameChange,
  error,
  tested,
  needsTest,
  pending,
  onTest,
  onSave,
  onCancel,
}: {
  mode: 'add' | 'edit'
  /** The edited server's name; `null` for a new one. */
  label: string | null
  baseUrl: string
  accessKey: string
  serverName: string
  onBaseUrlChange: (value: string) => void
  onAccessKeyChange: (value: string) => void
  onServerNameChange: (value: string) => void
  error: string | null
  tested: boolean
  /** Save waits for a passing Test (a new server, or a new address or key). */
  needsTest: boolean
  pending: boolean
  onTest: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const urlRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    urlRef.current?.focus({ preventScroll: true })
    urlRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])
  const title = mode === 'edit' ? `Edit ${label}` : 'Add a server'
  return (
    <div
      role="group"
      aria-label={title}
      data-server-form={mode}
      className="bg-(--bg-key)/20"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <p className={cn('px-4 pt-4', TEXT.title)}>{title}</p>
      <div className="grid gap-y-5 px-4 py-4">
        <Field label="Server URL" htmlFor="app-backend-url">
          <Input
            ref={urlRef}
            id="app-backend-url"
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="http://<server-host>:4082"
            autoComplete="off"
            spellCheck={false}
            className="h-9 font-mono"
          />
        </Field>
        <Field label="Access key" htmlFor="app-backend-key" hint="Needed if the server was started with an access key.">
          <Input
            id="app-backend-key"
            value={accessKey}
            onChange={(event) => onAccessKeyChange(event.target.value)}
            placeholder="Leave empty if the server has no key"
            type="password"
            autoComplete="off"
            className="h-9"
          />
        </Field>
        <Field label="Server name" htmlFor="app-backend-name" hint="Optional. Shown in the server list.">
          <Input
            id="app-backend-name"
            value={serverName}
            onChange={(event) => onServerNameChange(event.target.value)}
            placeholder="Work laptop, Home server"
            autoComplete="off"
            className="h-9"
          />
        </Field>
      </div>
      <div className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 text-xs leading-relaxed">
          {error ? (
            <p role="alert" className="text-(--color-error)">{error}</p>
          ) : tested ? (
            <p role="status" className="font-medium text-(--accent-green-text)">Connection successful.</p>
          ) : needsTest ? (
            <p className="text-(--color-text-muted)">Test the server to enable saving.</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="default" size="sm" onClick={onTest} disabled={pending}>
            {pending ? 'Testing…' : 'Test'}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onSave} disabled={pending || (needsTest && !tested)}>
            {mode === 'add' ? 'Save and use' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ServerRow({
  health,
  title,
  subtitle,
  mono = false,
  note = null,
  inUse,
  address,
  children,
}: {
  health: Health | undefined
  title: string
  subtitle?: string
  /** Title is a URL. */
  mono?: boolean
  /** Background connection state, under the subtitle. */
  note?: { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } | null
  /** The app talks to this server now. */
  inUse: boolean
  /** Where the server answers, when the title does not already say (a mono line under the subtitle). */
  address?: string
  children: React.ReactNode
}) {
  return (
    <div data-server-row="" className={cn('flex min-h-11 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 md:min-h-14', ROW_PAD)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <ServerStatusDot status={health} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate', TEXT.label, mono && 'font-mono')}>{title}</span>
            {inUse ? <Chip tone="success" dot>In use</Chip> : null}
          </span>
          {subtitle ? (
            <span className={cn('mt-0.5 block truncate', TEXT.hint, subtitle.includes('://') && 'font-mono')}>{subtitle}</span>
          ) : null}
          {address ? (
            <span className={cn('mt-0.5 block truncate font-mono', TEXT.hint)}>{address}</span>
          ) : null}
          {note ? (
            <span
              className={cn(
                'mt-0.5 block truncate',
                TEXT.hint,
                note.tone === 'ok' && 'text-(--accent-green-text)',
                note.tone === 'warn' && 'text-(--accent-orange-text)',
                note.tone === 'error' && 'text-(--color-error)',
              )}
            >
              {note.text}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-5 sm:pl-0">{children}</div>
    </div>
  )
}

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

function ServerStatusDot({ status }: { status: Health | undefined }) {
  const className = status === 'online'
    ? 'bg-(--accent-green-text)'
    : status === 'offline'
      ? 'bg-(--color-error)'
      : 'animate-pulse bg-(--color-text-muted)'
  const label = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking'
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={`size-2 shrink-0 rounded-full ${className}`} aria-label={label} />} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
