// size-ceiling: 931 — move ComputersList and ServerRow into files of their own
/**
 * AppBackendPanel — choose which computer's OpenAgentd this app talks to.
 *
 * One panel, three hosts: Settings → Switch computer renders it as a page,
 * `AppBackendDialog` wraps it for the places that need it before or outside
 * Settings (the loading screen, the footer health dot, a scanned connect
 * link), and the phone's Computers screen shows it as its list. All
 * connection logic lives here; the hosts only provide chrome.
 *
 * One list, **Computers**: this computer first (the OpenAgentd inside the
 * desktop app), then the computers of your account (`accountRows`, drawn by
 * the host), then the ones added by address. There is no separate "current"
 * card: the row the app talks to carries the **In use** badge, and a
 * connected computer that is not in the list gets a row of its own.
 *
 * A row has **Use** (switch the app to it) and **Details**. Details holds
 * everything else: the name and address, Stop for this computer, and for
 * one added by address the background watch switch, Edit and Remove. Edit
 * opens the form right under the row, saved in place without switching.
 * **Add a computer by address**, at the end of the list, opens the form for
 * a new one; its one button, Connect, tests the address and key, then saves
 * it and switches to it. No form opens by itself, except for a scanned
 * connect link.
 *
 * A row carries a name and one status line, never an address: a computer
 * added by address is titled by the name you gave it, else by the name it
 * gave for itself, and by its address only when the app knows neither.
 *
 * On the phone the row in use also offers **Sessions ›** (``onOpenInUse``),
 * back up to its session list, and a tap on a row uses it; ⋯ holds the rest.
 */
import { Fragment, useEffect, useImperativeHandle, useReducer, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronRight, Info, MoreHorizontal, Pencil, Plus, ScanQrCode, Trash2 } from 'lucide-react'
import { cancelQrScan, canScanQr, scanQrCode } from '@/lib/qr-scan'
import { QrScanOverlay } from '@/components/phone/QrScanOverlay'
import { parseConnectLink } from '@/lib/connect-link'
import { pickReachableUrl } from '@/hooks/useConnectLink'

import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet'
import { Button } from '@/components/ui/button'
import { StatusChip } from '@/components/ui/chip'
import { STATUS } from '@/lib/status'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { ComputerDetailsDialog } from '@/components/ComputerDetails'
import { ServerUpdateOnRow } from '@/components/settings/ServerUpdate'
import { Callout } from '@/components/ui/callout'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { PanelSection } from '@/components/ui/panel-section'
import { SectionCard } from '@/components/ui/section-card'
import { ICON_SIZE_INLINE, ROW_PAD, TEXT } from '@/components/settings/tokens'
import { isDesktopShell } from '@/lib/desktop-shell'
import { useLongPress } from '@/hooks/use-long-press'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { mediumHapticFeedback } from '@/lib/haptics'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { cn } from '@/lib/utils'
import { NAME_NEEDS_UPDATE, renameComputerInUse, serverInUseKeepsName } from '@/lib/computer-rename'

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
  BUILT_IN_NAME_KEY,
  getAppBackendStatus,
  getServerWatchStates,
  removeAppBackendServer,
  saveAppBackendServer,
  savedServerTitle,
  setAppBackendServerEnabled,
  stopBundledAppBackend,
  type SavedAppServer,
  type AppBackendStatus,
  type ServerWatchState,
} from '@/lib/app-backend'
import { useAppStatusWithNames } from '@/lib/account-computers'
import { ServerForm } from '@/components/ServerForm'
import { FORM_CLOSED, NO_VALUES, formTargetOf, serverFormStep, type ServerFormTarget } from '@/components/server-form-state'

/** Where Rename would be, for a computer the app is not on. */
const RENAME_ON_ITSELF = 'Switch to this computer to rename it.'

const DEFAULT_SERVERS: SavedAppServer[] = [{ base_url: 'http://127.0.0.1:4082', name: 'Local server' }]

/** How often the background connection states refresh while the panel is open. */
const WATCH_POLL_MS = 3000

/**
 * The server the app is connected to when it is not in the saved list
 * (normalized), else null. An account bridge is not one: its computer has a
 * row of its own, from the account.
 */
function unlistedConnectedUrl(status: AppBackendStatus | null, servers: SavedAppServer[]): string | null {
  if (!status || !(status.mode === 'external' || status.external)) return null
  if (status.account_device) return null
  const url = normalizeServerBaseUrl(status.base_url)
  return servers.some((server) => normalizeServerBaseUrl(server.base_url) === url) ? null : url
}

/**
 * The line under a computer added by address while the desktop watches it in
 * the background; `null` when it is not watched (the row then says whether
 * it answers, like any other).
 */
function watchNote(state: ServerWatchState | undefined): { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } | null {
  switch (state) {
    case 'connected': return { text: 'Watching', tone: 'ok' }
    case 'connecting': return { text: 'Connecting…', tone: 'muted' }
    case 'reconnecting': return { text: "Reconnecting · can't reach it", tone: 'warn' }
    case 'key_rejected': return { text: 'Access key rejected · change it in Details', tone: 'error' }
    default: return null
  }
}

/** Server details from a scanned `openagentd://connect` link. */
export interface AppBackendPrefill {
  baseUrl: string
  accessKey: string
}

type Health = 'checking' | 'online' | 'offline'

/** A saved server's one status line: what its dot says. */
function healthWord(health: Health | undefined): string {
  if (health === 'online') return 'Online'
  if (health === 'offline') return "Can't reach"
  return 'Checking…'
}

interface AppBackendPanelProps {
  /** Loads status and probes servers when it turns true (dialog open, page shown). */
  active: boolean
  /** Fill the form and test it; the user still confirms with Connect. */
  prefill?: AppBackendPrefill | null
  /**
   * Include desktop network access. The dialog does; Settings → Switch computer shows
   * its own "Access from other devices" card.
   */
  showNetworkAccess?: boolean
  /**
   * The account's computers, as rows of this list (`AccountComputerRows`),
   * after this computer and before the ones added by address.
   */
  accountRows?: ReactNode
  /** The phone's Computers screen is titled by its own large title: the list has no heading there. */
  untitled?: boolean
  /** The phone's Computers screen: the row in use opens its Sessions. */
  onOpenInUse?: () => void
  /** Lets a host reload the list (the phone's pull to refresh). */
  controlRef?: Ref<AppBackendPanelControl>
  /**
   * The phone's Computers screen scans with one scanner for both kinds of
   * code (an account invitation, or a connect code it hands back as
   * `prefill`): Scan QR code calls this instead of the panel's own.
   */
  onScanQr?: () => void
}

export interface AppBackendPanelControl {
  /** Reload the servers and ping each one; settles when every ping has. */
  refresh: () => Promise<void>
}

export function AppBackendPanel({ active, prefill = null, showNetworkAccess = false, accountRows = null, untitled = false, onOpenInUse, controlRef, onScanQr }: AppBackendPanelProps) {
  const [status, setStatus] = useState<AppBackendStatus | null>(null)
  // The names the app remembers, kept current while the list is shown: one
  // read after this list loaded (a server just added) reaches its row.
  const names = useAppStatusWithNames()?.computer_names ?? status?.computer_names
  // Nothing is listed until the shell has answered once: before that a
  // phone with no server would flash the browser build's placeholder rows.
  const [loaded, setLoaded] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'stop' } | { kind: 'remove'; baseUrl: string; label: string } | null>(null)
  // The open form: adding a computer (at the end of the list, from "Add a
  // computer by address"), or editing one (right under its row, from Edit in
  // its Details). One at a time; neither opens by itself, except for a
  // scanned link. Its fields and checks live in it (``server-form-state.ts``).
  const [formState, sendForm] = useReducer(serverFormStep, FORM_CLOSED)
  const form = formTargetOf(formState)
  const { baseUrl, serverName, accessKey } = formState.kind === 'open' ? formState.values : NO_VALUES
  const original = formState.kind === 'open' ? formState.original : null
  const testedBaseUrl = formState.kind === 'open' ? formState.tested : null
  const formError = formState.kind === 'open' ? formState.error : null
  const scanned = formState.kind === 'open' && formState.scanned
  const setFormError = (error: string | null) => sendForm({ type: 'error', error })
  const closeFormNow = () => sendForm({ type: 'close' })
  // Touch: a saved server's row keeps one button; Edit and Remove move to
  // its action sheet (a long press, or ⋯).
  const touch = useTouchFirst()
  const [rowSheet, setRowSheet] = useState<{ title: string; items: ActionSheetItem[] } | null>(null)
  // Details of this computer, of a connected one that is not in the list, or
  // of one added by address (its normalized address); it stays on its
  // computer while the dialog closes.
  const [details, setDetails] = useState<'builtin' | 'unlisted' | { saved: string }>('builtin')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [serverHealth, setServerHealth] = useState<Record<string, Health>>({})
  const [pending, setPending] = useState(false)
  /** A list action that failed (Use, Start, Stop, Remove, Enabled). */
  const [listError, setListError] = useState<string | null>(null)
  // The camera viewfinder is up (Scan QR code).
  const [qrScanning, setQrScanning] = useState(false)
  const [watchStates, setWatchStates] = useState<Record<string, ServerWatchState>>({})
  const watchable = isDesktopShell() && status?.supports_bundled !== false
  // Where focus goes back to when a form closes: Add, or the row's Details.
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const detailsButtonRefs = useRef(new Map<string, HTMLButtonElement>())

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
      setLoaded(true)
      setListError(null)
      // A scanned link opens the add form, filled in and tested; otherwise no form is open.
      if (prefill) fillForm({ kind: 'add' }, prefill.baseUrl, hostnameOf(prefill.baseUrl), prefill.accessKey, { scanned: true })
      else sendForm({ type: 'close' })
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

  useImperativeHandle(controlRef, () => ({
    async refresh() {
      const next = await getAppBackendStatus()
      setStatus(next)
      setListError(null)
      const servers = next?.servers ?? DEFAULT_SERVERS
      const unlisted = unlistedConnectedUrl(next, servers)
      const toCheck = [...servers.map((server) => normalizeServerBaseUrl(server.base_url)), ...(unlisted ? [unlisted] : [])]
      setServerHealth(Object.fromEntries(toCheck.map((url) => [url, 'checking'])))
      await Promise.all(toCheck.map(async (normalized) => {
        const online = await pingServer(normalized)
        setServerHealth((prev) => ({ ...prev, [normalized]: online ? 'online' : 'offline' }))
      }))
    },
  }), [])

  function fillForm(
    target: ServerFormTarget,
    nextBaseUrl: string,
    nextName: string,
    nextKey: string,
    extra: { scanned?: boolean; original?: { baseUrl: string; accessKey: string } } = {},
  ) {
    sendForm({ type: 'open', target, values: { baseUrl: nextBaseUrl, serverName: nextName, accessKey: nextKey }, ...extra })
  }

  /** "Add a computer by address": the empty form at the end of the list. */
  function openAdd() {
    fillForm({ kind: 'add' }, '', '', '')
  }

  /** Edit, from a row's Details: its address, key and name in a form right under the row. */
  function openEdit(server: SavedAppServer, inUse: boolean) {
    const normalized = normalizeServerBaseUrl(server.base_url)
    const label = savedServerTitle(server, names)
    fillForm({ kind: 'edit', baseUrl: normalized, label, inUse }, normalized, server.name ?? '', '', { original: { baseUrl: normalized, accessKey: '' } })
    void getStoredAccessKey(normalized).then((storedKey) => {
      sendForm({ type: 'keyLoaded', baseUrl: normalized, accessKey: storedKey ?? '' })
    })
  }

  function closeForm() {
    const target = form
    closeFormNow()
    // After the render: the add form stands where its button goes back.
    requestAnimationFrame(() => {
      const opener = target?.kind === 'edit' ? detailsButtonRefs.current.get(target.baseUrl) : addButtonRef.current
      opener?.focus()
    })
  }

  /**
   * Scan QR code: the camera reads the desktop's connect code and this
   * list's own add form opens, filled in and tested. Nothing connects until
   * Connect.
   */
  async function scanConnectCode() {
    setListError(null)
    setQrScanning(true)
    const outcome = await scanQrCode().finally(() => setQrScanning(false))
    if (outcome.kind === 'denied') {
      setListError('Camera access is off. Turn it on for OpenAgentd in Settings to scan a code.')
    } else if (outcome.kind === 'scanned') {
      const link = parseConnectLink(outcome.text)
      if (!link) {
        setListError('That QR code is not an OpenAgentd connect code. Scan the one under Network access on your computer.')
        return
      }
      const url = await pickReachableUrl(link.urls)
      fillForm({ kind: 'add' }, url, hostnameOf(url), link.key, { scanned: true })
      void testConnection(url, link.key)
    }
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
      // Back on the switching screen: nothing to say, the list is as it was.
      if (!result.cancelled) onError(result.error)
      return false
    }
    setStatus(result.status)
    if (result.reload) reloadForBackendSwitch()
    return true
  }

  /** Checks the address answers and takes the key; says why in the form when it does not. */
  async function testConnection(rawBaseUrl: string = baseUrl, rawAccessKey: string = accessKey): Promise<boolean> {
    const target = normalizeServerBaseUrl(rawBaseUrl)
    const validationError = validateServerUrl(target)
    if (validationError) {
      setFormError(validationError)
      return false
    }
    setPending(true)
    setFormError(null)
    try {
      const online = await pingServer(target)
      setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' }))
      if (!online) {
        setFormError(connectionFailureMessage(target))
        return false
      }
      const keyForTest = rawAccessKey.trim() || await getStoredAccessKey(target) || ''
      const authorized = await checkServerAuth(target, keyForTest)
      if (!authorized) {
        setFormError('The access key is wrong or missing.')
        return false
      }
      if (rawAccessKey.trim()) await setStoredAccessKey(rawAccessKey, target)
      sendForm({ type: 'tested', baseUrl: target })
      return true
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      return false
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
      if (!result.cancelled) setListError(result.error)
      return
    }
    setStatus(result.status)
    if (result.reload) reloadForBackendSwitch()
  }

  async function stopBundled() {
    await runConnectionSwitch(() => stopBundledAppBackend())
  }

  /** The add form's Connect: test the address and key, then store it and switch the app to it. */
  async function saveAndConnect() {
    const target = normalizeServerBaseUrl(baseUrl)
    if (testedBaseUrl !== target && !await testConnection()) return
    if (await connectExternal(target, serverName, accessKey, setFormError)) closeFormNow()
  }

  /**
   * The edit form's Save: the entry is updated where it is, without
   * switching to it. A new address or key is tested first; a rename is
   * not. The computer in use follows its new address.
   */
  async function saveEdit() {
    if (form?.kind !== 'edit') return
    const target = normalizeServerBaseUrl(baseUrl)
    const moved = target !== form.baseUrl
    const keyChanged = accessKey.trim() !== (original?.accessKey ?? '').trim()
    if ((moved || keyChanged) && testedBaseUrl !== target && !await testConnection()) return
    if (moved && form.inUse) {
      // The app talks to it: switch to the new address, then drop the old one.
      if (!await connectExternal(target, serverName, accessKey, setFormError)) return
      await removeAppBackendServer(form.baseUrl).catch(() => undefined)
      closeFormNow()
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
      if (form?.kind === 'edit' && form.baseUrl === normalizeServerBaseUrl(baseUrl)) closeFormNow()
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

  const servers = loaded ? status?.servers ?? DEFAULT_SERVERS : []
  // Browser builds have no shell status and a relative `/api` base: show the page origin.
  const currentUrl = status?.base_url || apiBaseUrl().replace(/\/api$/, '') || window.location.origin
  const onExternal = status?.mode === 'external' || Boolean(status?.external)
  // A connected server that is not in the saved list still gets a row. Without
  // shell status (a browser) the one server is the page's own.
  const unlistedUrl = !loaded ? null : status ? unlistedConnectedUrl(status, servers) : normalizeServerBaseUrl(currentUrl)
  const onBuiltin = status !== null && !status.external
  const builtinName = names?.[BUILT_IN_NAME_KEY] ?? null
  const unlistedName = unlistedUrl ? names?.[unlistedUrl] ?? null : null
  const unlistedTitle = unlistedName ?? unlistedUrl ?? ''
  const showDetails = (which: 'builtin' | 'unlisted' | { saved: string }) => {
    setDetails(which)
    setDetailsOpen(true)
  }
  // The computer added by address that Details is on, if it is still listed.
  const detailsSaved = typeof details === 'object'
    ? servers.find((server) => normalizeServerBaseUrl(server.base_url) === details.saved) ?? null
    : null
  const detailsSavedUrl = detailsSaved ? normalizeServerBaseUrl(detailsSaved.base_url) : null
  const detailsSavedActive = detailsSavedUrl !== null && onExternal && normalizeServerBaseUrl(currentUrl) === detailsSavedUrl
  const detailsSavedLabel = detailsSaved ? savedServerTitle(detailsSaved, names) : ''
  // The name lives on the computer: only the one the app is on is renamed.
  const detailsInUse = details === 'unlisted' || (details === 'builtin' && onBuiltin)
  const tested = testedBaseUrl !== null && testedBaseUrl === normalizeServerBaseUrl(baseUrl)
  const editTarget = form?.kind === 'edit' ? form : null

  const serverForm = (target: ServerFormTarget) => (
    <ServerForm
      mode={target.kind}
      label={target.kind === 'edit' ? target.label : null}
      baseUrl={baseUrl}
      accessKey={accessKey}
      serverName={serverName}
      onBaseUrlChange={(value) => sendForm({ type: 'input', field: 'baseUrl', value })}
      onAccessKeyChange={(value) => sendForm({ type: 'input', field: 'accessKey', value })}
      onServerNameChange={(value) => sendForm({ type: 'input', field: 'serverName', value })}
      error={formError}
      tested={tested}
      pending={pending}
      onSave={() => void (target.kind === 'add' ? saveAndConnect() : saveEdit())}
      onCancel={closeForm}
    />
  )

  /** Sessions ›, on the row in use when a host can go back to its list. */
  // Touch: a tap on the row opens it (``onOpen``), so no Sessions or Use button.
  const openInUse = (label: string) => onOpenInUse && !touch ? (
    <Button type="button" variant="subtle" size="sm" aria-label={`Open sessions on ${label}`} onClick={onOpenInUse} data-open-in-use="">
      Sessions
      <ChevronRight size={ICON_SIZE_INLINE} aria-hidden="true" />
    </Button>
  ) : null

  return (
    <div className="space-y-8">
      {scanned ? (
        <Callout tone="info" role="status">
          Scanned from another device. Check the address, then connect.
        </Callout>
      ) : null}

      {/* One list: this computer, the account's, then the ones added by address. */}
      <ComputersList untitled={untitled} touch={touch}>
        {loaded && status?.supports_bundled !== false ? (
          <ServerRow
            health={status?.sidecar_running ? 'online' : undefined}
            title="This computer"
            subtitle={`Runs inside this app · ${status?.sidecar_running ? 'Running' : 'Stopped'}`}
            inUse={status !== null && !status.external}
            onOpen={touch && !pending && status?.sidecar_running ? (status.external ? () => { void connectBundled() } : onOpenInUse) : undefined}
          >
            {status !== null && !status.external ? openInUse('this computer') : null}
            {status?.sidecar_running ? (
              status?.external && !touch ? (
                <Button type="button" variant="subtle" size="sm" aria-label="Use this computer" onClick={() => { void connectBundled() }} disabled={pending}>
                  Use
                </Button>
              ) : null
            ) : (
              // Stopped: Use also starts it, and says so.
              <Button type="button" variant="subtle" size="sm" onClick={() => { void connectBundled() }} disabled={pending}>
                Start and use
              </Button>
            )}
            {onBuiltin || builtinName || status?.sidecar_running ? (
              <Button type="button" variant="ghost" size="sm" aria-label="Details of this computer" onClick={() => showDetails('builtin')}>
                Details
              </Button>
            ) : null}
          </ServerRow>
        ) : null}
        {unlistedUrl ? (
          <ServerRow
            health={status ? serverHealth[unlistedUrl] : 'online'}
            title={status ? unlistedTitle : 'This server'}
            mono={Boolean(status) && !unlistedName}
            subtitle={status ? 'Not saved in this list' : unlistedUrl}
            inUse
            onOpen={touch ? onOpenInUse : undefined}
            onMore={touch && status ? () => setRowSheet({
              title: unlistedTitle,
              items: [{ id: 'details', label: 'Details', icon: Info, afterClose: true, run: () => showDetails('unlisted') }],
            }) : undefined}
          >
            {openInUse(status ? unlistedTitle : 'This server')}
            {status && !touch ? (
              <Button type="button" variant="ghost" size="sm" aria-label={`Details of ${unlistedTitle}`} onClick={() => showDetails('unlisted')}>
                Details
              </Button>
            ) : null}
          </ServerRow>
        ) : null}
        {unlistedUrl ? <ServerUpdateOnRow /> : null}
        {accountRows}
        {servers.map((server) => {
          const normalizedServerUrl = normalizeServerBaseUrl(server.base_url)
          const active = onExternal && normalizeServerBaseUrl(currentUrl) === normalizedServerUrl
          const label = savedServerTitle(server, names)
          const note = watchable ? watchNote(watchStates[normalizedServerUrl]) : null
          const editing = editTarget?.baseUrl === normalizedServerUrl
          const health = serverHealth[normalizedServerUrl] ?? serverHealth[server.base_url]
          return (
            <Fragment key={server.base_url}>
              <ServerRow
                health={health}
                title={label}
                // One status line: the background connection where the desktop watches it.
                subtitle={note ? undefined : healthWord(health)}
                mono={label === server.base_url}
                note={note}
                origin="added by address"
                inUse={active}
                onOpen={touch && !pending ? (active ? onOpenInUse : () => { void connectExternal(normalizedServerUrl, server.name ?? '', '', setListError) }) : undefined}
                onMore={touch ? () => setRowSheet({
                  title: label,
                  // No Open or Use here: a tap on the row already does it.
                  items: [
                    { id: 'edit', label: 'Edit', icon: Pencil, disabled: pending, afterClose: true, run: () => (editing ? closeForm() : openEdit(server, active)) },
                    { id: 'remove', label: 'Remove…', icon: Trash2, danger: true, separatorBefore: true, disabled: pending, run: () => setConfirm({ kind: 'remove', baseUrl: server.base_url, label }) },
                  ],
                }) : undefined}
              >
                {active ? openInUse(label) : touch ? null : (
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
                {touch ? null : (
                  <Button
                    ref={(node) => {
                      if (node) detailsButtonRefs.current.set(normalizedServerUrl, node)
                      else detailsButtonRefs.current.delete(normalizedServerUrl)
                    }}
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Details of ${label}`}
                    onClick={() => showDetails({ saved: normalizedServerUrl })}
                  >
                    Details
                  </Button>
                )}
              </ServerRow>
              {active ? <ServerUpdateOnRow /> : null}
              {editing && editTarget ? serverForm(editTarget) : null}
            </Fragment>
          )
        })}
        {form?.kind === 'add' ? serverForm(form) : (
          <div className={cn(ROW_PAD, 'flex flex-wrap items-center gap-1')}>
            <Button ref={addButtonRef} type="button" variant="ghost" size="sm" onClick={openAdd} disabled={pending}>
              <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
              Add a computer by address
            </Button>
            {canScanQr() && (
              <Button type="button" variant="ghost" size="sm" onClick={() => { if (onScanQr) onScanQr(); else void scanConnectCode() }} disabled={pending}>
                <ScanQrCode size={ICON_SIZE_INLINE} aria-hidden="true" />
                Scan QR code
              </Button>
            )}
          </div>
        )}
      </ComputersList>

      {listError ? (
        <Callout tone="error" role="alert">{listError}</Callout>
      ) : null}

      {qrScanning && <QrScanOverlay onCancel={() => { void cancelQrScan() }} />}

      <ActionSheet
        open={rowSheet !== null}
        onClose={() => setRowSheet(null)}
        title={rowSheet?.title ?? 'Computer'}
        items={rowSheet?.items ?? []}
      />

      <ComputerDetailsDialog
        open={detailsOpen && (typeof details !== 'object' || detailsSaved !== null)}
        onOpenChange={setDetailsOpen}
        title={details === 'builtin' ? 'This computer' : details === 'unlisted' ? unlistedTitle : detailsSavedLabel}
        name={details === 'builtin' ? builtinName : details === 'unlisted' ? unlistedName : detailsSavedUrl ? names?.[detailsSavedUrl] ?? detailsSaved?.name ?? null : null}
        facts={detailsSavedUrl
          ? [{ label: 'Address', value: detailsSavedUrl, mono: true }]
          : detailsInUse ? [{ label: 'Address', value: normalizeServerBaseUrl(currentUrl), mono: true }] : []}
        rename={detailsInUse && serverInUseKeepsName() ? {
          name: (details === 'builtin' ? builtinName : unlistedName) ?? '',
          save: async (name) => {
            const next = await renameComputerInUse(status, name)
            if (next) setStatus(next)
          },
        } : null}
        renameHint={detailsSaved ? undefined : detailsInUse ? NAME_NEEDS_UPDATE : RENAME_ON_ITSELF}
      >
        {details === 'builtin' && status?.sidecar_running ? (
          <div className="flex justify-end">
            <Button type="button" variant="danger-subtle" size="sm" onClick={() => { setDetailsOpen(false); setConfirm({ kind: 'stop' }) }} disabled={pending}>
              Stop…
            </Button>
          </div>
        ) : null}
        {detailsSaved && detailsSavedUrl ? (
          <>
            {watchable ? (
              <label className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className={cn('block', TEXT.label)}>Watch in the background</span>
                  <span className={cn('block', TEXT.hint)}>The notch follows its agents while you use another computer.</span>
                </span>
                <Switch
                  checked={detailsSaved.enabled === true}
                  onCheckedChange={(next) => { void toggleEnabled(detailsSaved, next) }}
                  disabled={pending}
                  aria-label={`Watch ${detailsSavedLabel} in the background`}
                />
              </label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="danger-subtle"
                size="sm"
                onClick={() => { setDetailsOpen(false); setConfirm({ kind: 'remove', baseUrl: detailsSaved.base_url, label: detailsSavedLabel }) }}
                disabled={pending}
              >
                Remove…
              </Button>
              <Button type="button" variant="subtle" size="sm" onClick={() => { setDetailsOpen(false); openEdit(detailsSaved, detailsSavedActive) }} disabled={pending}>
                <Pencil size={ICON_SIZE_INLINE} aria-hidden="true" />
                Edit
              </Button>
            </div>
          </>
        ) : null}
      </ComputerDetailsDialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open) setConfirm(null) }}
        title={confirm?.kind === 'stop' ? 'Stop OpenAgentd on this computer?' : `Remove ${confirm?.kind === 'remove' ? confirm.label : 'it'}?`}
        description={confirm?.kind === 'stop'
          ? 'Running agents stop, and this app disconnects until you start it again or use another computer.'
          : 'It leaves this list. The computer itself keeps running.'}
        confirmLabel={confirm?.kind === 'stop' ? 'Stop' : 'Remove'}
        onConfirm={async () => {
          if (confirm?.kind === 'stop') await stopBundled()
          else if (confirm?.kind === 'remove') await removeServer(confirm.baseUrl)
        }}
      />

      {showNetworkAccess && isDesktopShell() && status?.supports_bundled !== false ? <NetworkAccessCard /> : null}
    </div>
  )
}

/** The list's card, under its "Computers" heading unless the host already shows one. */
function ComputersList({ untitled, touch, children }: { untitled: boolean; touch: boolean; children: ReactNode }) {
  if (untitled) {
    return (
      <SectionCard>
        <div className="divide-y divide-(--color-border-subtle)">{children}</div>
      </SectionCard>
    )
  }
  return (
    <PanelSection
      title="Computers"
      description={touch ? 'Tap a computer to use it.' : 'Where your agents run. Use switches this app to another one.'}
      flush
    >
      {children}
    </PanelSection>
  )
}

export function ServerRow({
  health,
  title,
  subtitle,
  mono = false,
  note = null,
  origin,
  inUse,
  onMore,
  onOpen,
  children,
}: {
  /** `null`: no status dot (an account computer has no address to ping). */
  health: Health | null | undefined
  title: string
  subtitle?: string
  /** Title is a URL. */
  mono?: boolean
  /** Background connection state, under the subtitle. */
  note?: { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } | null
  /** Where the row comes from ("added by address"), after its status line. */
  origin?: string
  /** The app talks to this computer now. */
  inUse: boolean
  /** Touch: open the row's action sheet, from a long press or its ⋯. */
  onMore?: () => void
  /** Touch: a tap on the row's name opens it (Use, or Sessions when in use). */
  onOpen?: () => void
  children: React.ReactNode
}) {
  // The click that ends a long press must not also open the row.
  const heldRef = useRef(false)
  const longPress = useLongPress(Boolean(onMore), () => {
    heldRef.current = true
    mediumHapticFeedback()
    onMore?.()
  })
  return (
    <div
      data-server-row=""
      {...(onMore ? longPress : {})}
      className={cn(
        'flex min-h-(--phone-control) flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 md:min-h-14',
        ROW_PAD,
        // The server's update (`ServerUpdateOnRow`) is part of this row: the
        // list's hairline, this row's bottom edge, goes under the update.
        'has-[+[data-server-update-on-row]]:border-b-0!',
        // Touch: one line, the button beside the name; no iOS callout on a hold.
        onMore && 'flex-row! items-center gap-3 [-webkit-touch-callout:none] select-none',
      )}
    >
      <div
        // The tap target is the row's full height: it takes over the row's
        // own vertical padding (``ROW_PAD``).
        className={cn('flex min-w-0 flex-1 items-center gap-3', onOpen && '-my-2.5 cursor-pointer self-stretch py-2.5 md:-my-3.5 md:py-3.5')}
        {...(onOpen ? {
          role: 'button',
          tabIndex: 0,
          'aria-label': `Open ${title}`,
          'data-server-open': '',
          onClick: () => {
            if (heldRef.current) { heldRef.current = false; return }
            onOpen()
          },
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() }
          },
        } : {})}
      >
        {health === null ? null : <ServerStatusDot status={health} />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate', TEXT.label, mono && 'font-mono')}>{title}</span>
            {inUse ? <StatusChip status={STATUS.inUse} /> : null}
          </span>
          {subtitle ? (
            <span className={cn('mt-0.5 block truncate', TEXT.hint, subtitle.includes('://') && 'font-mono')}>
              {subtitle}{origin ? ` · ${origin}` : ''}
            </span>
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
              {origin ? <span className="text-(--color-text-muted)">{` · ${origin}`}</span> : null}
            </span>
          ) : null}
        </span>
      </div>
      <div className={cn('flex shrink-0 flex-wrap items-center gap-1.5', onMore ? 'pl-0' : 'pl-5 sm:pl-0')}>
        {children}
        {onMore ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`More actions for ${title}`} onClick={onMore} className="text-(--color-text-muted)">
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
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
      : 'oa-breathe bg-(--color-text-muted)'
  const label = status === 'online' ? 'Online' : status === 'offline' ? "Can't reach" : 'Checking'
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={`size-2 shrink-0 rounded-full ${className}`} aria-label={label} />} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
