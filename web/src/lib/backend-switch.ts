/**
 * Switching the app's backend: the steps behind every "Connect" and "Use
 * builtin" button. Settings → Switch computer (`AppBackendPanel`) and the command
 * palette's Switch Server… both call these, so a switch checks the server and
 * its key, clears the old session state, and shows the "Switching to …"
 * screen (`BackendSwitchScreen`) the same way from either.
 */
import { apiBaseUrl, setApiBaseUrl } from '@/api/base-url'
import { getStoredAccessKey, installDesktopAuth, primeStoredAccessKey, refreshStoredAccessKey, setStoredAccessKey } from '@/api/auth'
import { queryClient } from '@/lib/query-client'
import { markPageUnloading } from '@/lib/page-unload'
import { forgetRouteForBackendSwitch } from '@/lib/route-restore'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { queryKeys } from '@/queries/keys'
import {
  backendSwitchActive,
  beginBackendSwitch,
  endBackendSwitch,
  isCurrentBackendSwitch,
  markBackendSwitchCommitting,
  noteBackendSwitchOrigin,
  type BackendSwitchOrigin,
  type BackendSwitchTarget,
} from '@/stores/useBackendSwitchStore'
import { openPhoneCloudComputer, type OpenedComputer } from '@/api/phone-cloud'
import {
  accountComputerTitle,
  getAppBackendStatus,
  startBundledAppBackend,
  switchToBundledAppBackend,
  switchToExternalAppBackend,
  type AppBackendStatus,
} from '@/lib/app-backend'

export function normalizeServerBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed
}

export function validateServerUrl(value: string): string | null {
  if (!value) return 'Enter an address first.'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Enter a full address, including http:// or https://.'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported URL scheme: ${parsed.protocol.replace(/:$/, '')}`
  }
  return null
}

export function connectionFailureMessage(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return 'Nothing answered at that address. Make sure OpenAgentd is running locally and the port is correct.'
    }
  } catch {
    // validateServerUrl already handles malformed URLs.
  }
  return 'Nothing answered at that address. Check that OpenAgentd on that computer lets other devices connect (Settings → Switch computer → Let other devices connect in the desktop app, or agentd server start --public), that this device is on the same network, and that the address is that computer’s.'
}

export async function refreshBackendQueries(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.health() })
  // ``agents()`` is a prefix of ``agentRegistry(workspace)``, so this covers the
  // shared /agent/agents entry for every workspace after a backend switch.
  await queryClient.invalidateQueries({ queryKey: queryKeys.agents() })
}

/** The origin the app talks to now. */
export function currentBackendOrigin(status: AppBackendStatus | null): string {
  return normalizeServerBaseUrl(status?.base_url || apiBaseUrl().replace(/\/api$/, ''))
}

/** Reload the window onto a new backend, forgetting the route of the old one. */
export function reloadForBackendSwitch(): void {
  forgetRouteForBackendSwitch()
  markPageUnloading()
  window.location.reload()
}

/** What the switching screen calls the builtin sidecar. */
export const BUILTIN_SWITCH_TARGET: BackendSwitchTarget = {
  name: 'this computer',
  detail: "Running sessions continue once it's up.",
}

function serverLabel(name: string, baseUrl: string): string {
  if (name.trim()) return name.trim()
  try {
    return new URL(baseUrl).host || baseUrl
  } catch {
    return baseUrl
  }
}

/**
 * A switch called back with Back (or replaced by a newer one). Callers drop
 * it without a word: no error, no reload.
 */
export interface SwitchCancelled {
  ok: false
  cancelled: true
  error?: undefined
}

/** A switch that failed: the error shows where the user started. */
export interface SwitchFailed {
  ok: false
  error: string
  cancelled?: undefined
}

const CANCELLED: SwitchCancelled = { ok: false, cancelled: true }

class SwitchCancelledError extends Error {
  constructor() {
    super('Switch cancelled')
  }
}

/** The switch in progress, as its steps see it. */
interface SwitchRun {
  generation: number
  /** Stops the switch here if Back was pressed or a newer switch began. */
  check(): void
}

function switchRun(generation: number): SwitchRun {
  return {
    generation,
    check() {
      if (!isCurrentBackendSwitch(generation)) throw new SwitchCancelledError()
    },
  }
}

/**
 * Show the switching screen while `run` switches. It stays up when the
 * caller is about to reload onto the new server (the startup screen takes
 * over from it), and goes away on a failure, so the error shows where the
 * user started.
 *
 * Back ends the screen at once (`cancelBackendSwitch`); `run` checks before
 * every step that changes anything, and whatever it answers after that,
 * success or failure, comes back as `cancelled`.
 */
async function withSwitchScreen<T extends { ok: true; reload: boolean }>(
  target: BackendSwitchTarget,
  run: (sw: SwitchRun) => Promise<T | SwitchFailed | SwitchCancelled>,
): Promise<T | SwitchFailed | SwitchCancelled> {
  const generation = beginBackendSwitch(target)
  let result: T | SwitchFailed | SwitchCancelled
  try {
    result = await run(switchRun(generation))
  } catch (err) {
    result = err instanceof SwitchCancelledError
      ? CANCELLED
      : { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!result.ok && !isCurrentBackendSwitch(generation)) result = CANCELLED
  if (!result.ok || !result.reload) endBackendSwitch(generation)
  if (!result.ok) settleShell()
  return result
}

// ── The shell's side of a switch ────────────────────────────────────────

/**
 * The shell's own switch commands (`app_use_external_backend`,
 * `app_use_bundled_backend`, `cloud_open_computer`) move this window's
 * server as they return, and none of them can be called off. They run one
 * after another, in the order the switches reached them, so a switch picked
 * after Back never lands before the one it replaced.
 */
let shellQueue: Promise<unknown> = Promise.resolve()

function inShellOrder<T>(step: () => Promise<T>): Promise<T> {
  const run = shellQueue.then(step, step)
  shellQueue = run.catch(() => undefined)
  return run
}

/**
 * Set when a switch called back still moved the shell (its command was
 * already running): where to put the shell back, so it agrees with the page
 * again. `null`: it moved, but from nowhere known (nothing to put back).
 */
let shellRestore: BackendSwitchOrigin | null | undefined

/** Where a shell status says the window is, as the startup screen's Back would return to it. */
export function backendSwitchOriginOf(status: AppBackendStatus | null): BackendSwitchOrigin | null {
  if (!status?.base_url) return null
  const device = status.account_device
  if (device) return { kind: 'computer', deviceId: device.device_id, name: accountComputerTitle(device, status.computer_names) }
  if (status.external) {
    const baseUrl = normalizeServerBaseUrl(status.base_url)
    const saved = status.servers?.find((server) => normalizeServerBaseUrl(server.base_url) === baseUrl)
    return { kind: 'server', baseUrl, name: saved?.name ?? '' }
  }
  return { kind: 'bundled' }
}

/** Point the shell at `to` again: the same command that first switched to it. */
async function restoreShell(to: BackendSwitchOrigin): Promise<void> {
  if (to.kind === 'computer') await openPhoneCloudComputer(to.deviceId, null)
  else if (to.kind === 'server') await switchToExternalAppBackend(to.baseUrl, to.name, true)
  else await switchToBundledAppBackend()
}

/** No switch is under way any more: if one called back moved the shell, put it back. */
function settleShell(): void {
  if (shellRestore === undefined || backendSwitchActive()) return
  const to = shellRestore
  shellRestore = undefined
  // Best effort: a failure leaves the shell where the late command put it.
  if (to) void inShellOrder(() => restoreShell(to)).catch(() => {})
}

/**
 * Run the shell command that moves this window to the new server, in its
 * turn (Back stays up while it waits). A `quick` command has no network wait
 * in it, so it is the commit point: Back goes before it is sent. A slow one
 * (opening an account computer through its link) keeps Back up while it
 * runs; if Back comes meanwhile, its answer is dropped and the shell is put
 * back where the page still is (`settleShell`).
 */
async function shellStep<T>(sw: SwitchRun, command: () => Promise<T>, { quick }: { quick: boolean }): Promise<T> {
  return inShellOrder(async () => {
    sw.check()
    // Where the window is now: a switch called back before may have left the shell elsewhere.
    const from = shellRestore !== undefined ? shellRestore : backendSwitchOriginOf(await getAppBackendStatus())
    sw.check()
    noteBackendSwitchOrigin(sw.generation, from)
    if (quick) markBackendSwitchCommitting(sw.generation)
    // A command that fails has not moved the shell.
    const value = await command()
    if (!isCurrentBackendSwitch(sw.generation)) {
      if (shellRestore === undefined) shellRestore = from
      throw new SwitchCancelledError()
    }
    markBackendSwitchCommitting(sw.generation)
    shellRestore = undefined
    return value
  })
}

// ── Switches ────────────────────────────────────────────────────────────

export type ExternalSwitchResult =
  | { ok: true; status: AppBackendStatus; reload: boolean }
  | SwitchFailed
  | SwitchCancelled

/**
 * Check a server (reachable, key accepted), then switch this window to it.
 * The caller reloads when `reload` is true (the origin changed).
 */
export async function connectExternalBackend(options: {
  baseUrl: string
  name: string
  persist: boolean
  /** Key typed by the user; else the one stored for the server. */
  accessKey?: string
  /** Origin the app is on now, to tell whether a reload is needed. */
  currentBaseUrl: string
  /** Told whether the ping got an answer. */
  onHealth?: (target: string, online: boolean) => void
}): Promise<ExternalSwitchResult> {
  const target = normalizeServerBaseUrl(options.baseUrl)
  const validationError = validateServerUrl(target)
  if (validationError) return { ok: false, error: validationError }
  return withSwitchScreen({ name: serverLabel(options.name, target), detail: target }, (sw) => switchExternal(sw, target, options))
}

async function switchExternal(sw: SwitchRun, target: string, options: Parameters<typeof connectExternalBackend>[0]): Promise<ExternalSwitchResult> {
  const online = await pingServer(target)
  options.onHealth?.(target, online)
  sw.check()
  if (!online) return { ok: false, error: connectionFailureMessage(target) }
  const typedKey = options.accessKey?.trim() ?? ''
  const keyForConnect = typedKey || await getStoredAccessKey(target) || ''
  if (!await checkServerAuth(target, keyForConnect)) {
    return { ok: false, error: 'The access key is wrong or missing.' }
  }
  sw.check()
  if (typedKey) await setStoredAccessKey(options.accessKey ?? '', target)
  const next = await shellStep(sw, () => switchToExternalAppBackend(target, options.name, options.persist), { quick: true })
  await primeStoredAccessKey(next.base_url)
  delete window.__OAD_TOKEN__
  setApiBaseUrl(next.base_url)
  installDesktopAuth()
  const reload = normalizeServerBaseUrl(next.base_url) !== options.currentBaseUrl
  await refreshBackendQueries()
  return { ok: true, status: next, reload }
}

export type AccountSwitchResult =
  | { ok: true; status: AppBackendStatus; via: OpenedComputer['via']; reload: boolean }
  | SwitchFailed
  | SwitchCancelled

/**
 * Open a computer of the phone's account and switch this window to it,
 * through its link: directly on the home network or through the account's
 * relay, whichever the shell's link has (and it moves between them by
 * itself, under the same origin). A saved server is never used for it: that
 * is a separate thing. The caller reloads when `reload` is true (only the
 * first time, from another server).
 *
 * Opening the link is the slow part, and the shell has no way to call it
 * off: Back stays up through it, and an answer that comes after Back is
 * dropped (`shellStep`).
 */
export async function connectAccountComputer(options: {
  deviceId: string
  /** What the switching screen calls it. */
  label: string
  currentBaseUrl: string
}): Promise<AccountSwitchResult> {
  return withSwitchScreen({ name: options.label, detail: 'Your computer' }, async (sw): Promise<AccountSwitchResult> => {
    const opened = await shellStep(sw, () => openPhoneCloudComputer(options.deviceId, null), { quick: false })
    const next = opened.status
    // The bridge's key now: it may differ from the one cached for this
    // origin (the bridge started again), or a miss may be cached for it
    // (a cold launch primed this origin before the bridge was open).
    await refreshStoredAccessKey(next.base_url)
    delete window.__OAD_TOKEN__
    setApiBaseUrl(next.base_url)
    installDesktopAuth()
    const reload = normalizeServerBaseUrl(next.base_url) !== options.currentBaseUrl
    await refreshBackendQueries()
    return { ok: true, status: next, via: opened.via, reload }
  })
}

export type BundledSwitchResult =
  | { ok: true; status: AppBackendStatus | null; reload: boolean }
  | SwitchFailed
  | SwitchCancelled

/** Switch this window to the builtin sidecar, starting it when needed. */
export async function connectBundledBackend(currentBaseUrl: string): Promise<BundledSwitchResult> {
  return withSwitchScreen(BUILTIN_SWITCH_TARGET, (sw) => switchBundled(sw, currentBaseUrl))
}

async function switchBundled(sw: SwitchRun, currentBaseUrl: string): Promise<BundledSwitchResult> {
  const now = await getAppBackendStatus()
  if (now?.supports_bundled && !now.sidecar_running && !now.backend_starting) {
    sw.check()
    // The slow part, with Back still up: it starts the built-in server
    // without moving any window, so one called back is only left running,
    // as it is on most desktops anyway.
    await startBundledAppBackend()
  }
  await shellStep(sw, () => switchToBundledAppBackend(), { quick: true })
  const next = await getAppBackendStatus()
  if (next?.base_url) {
    setApiBaseUrl(next.base_url)
    await primeStoredAccessKey(next.base_url)
    installDesktopAuth()
  }
  await refreshBackendQueries()
  const reload = Boolean(next?.base_url) && normalizeServerBaseUrl(next?.base_url ?? '') !== currentBaseUrl
  return { ok: true, status: next, reload }
}

/**
 * The startup screen's Back after a switch reloaded the window onto a server
 * that is not up: switch back to where the window was, and reload onto it.
 * `failed` when there is nothing known to go back to, or it fails too.
 */
export async function returnFromBackendSwitch(from: BackendSwitchOrigin | undefined): Promise<'switching' | 'cancelled' | 'failed'> {
  if (!from) return 'failed'
  const current = currentBackendOrigin(null)
  const result = from.kind === 'bundled'
    ? await connectBundledBackend(current)
    : from.kind === 'server'
      ? await connectExternalBackend({ baseUrl: from.baseUrl, name: from.name, persist: true, currentBaseUrl: current })
      : await connectAccountComputer({ deviceId: from.deviceId, label: from.name, currentBaseUrl: current })
  if (!result.ok) return result.cancelled ? 'cancelled' : 'failed'
  // The page never started on the server it left: always load afresh.
  reloadForBackendSwitch()
  return 'switching'
}
