/**
 * The account's computers as data: which servers of the account this app
 * can open, their line, and whether the desktop's built-in server (which
 * holds its account) is up. `AccountComputersSection` draws them (the phone's
 * Servers screen, the desktop's Settings → Server), and the command palette
 * lists them; this module stays light so the palette does not load the
 * Servers UI.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { isServer, type DeviceRow } from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import { normalizeServerBaseUrl } from '@/lib/backend-switch'
import { normalizeFingerprint, useLanComputers } from '@/lib/computer-fingerprints'
import { isDesktopShell } from '@/lib/desktop-shell'
import { pingServer } from '@/lib/server-probe'
import { useDesktopCloudDevices, useDesktopCloudStatus } from '@/queries/cloud'
import { usePhoneCloudDevices, usePhoneCloudStatus } from '@/queries/phone-cloud'

/** How often the computers (and their dots) refresh while the screen is up. */
export const ACCOUNT_COMPUTERS_REFRESH_MS = 30_000

/** A desktop signed in without "Use as client" (spec 3.4). */
export const CANNOT_OPEN_COMPUTERS = "This computer can't open your other computers: it isn't used as a client. Roles are chosen when it signs in."
/** The desktop's account lives in the built-in server. */
export const BUILTIN_STOPPED_COMPUTERS = 'The built-in server is stopped. Your account lives there: start it to use your other computers.'

export interface AccountComputer {
  device: DeviceRow
  label: string
  /** The saved LAN server that is this computer, normalized; null: only the account reaches it. */
  lanUrl: string | null
}

/**
 * The account's computers, for the phone's shell account or the desktop's
 * built-in server. `poll`: refresh the dots every 30 s while `active` and
 * visible (the cloud allows 60 reads per device per 10 minutes); the
 * palette reads once when its page opens instead.
 */
export function useAccountComputers(active: boolean, { poll = true }: { poll?: boolean } = {}) {
  const desktop = isDesktopShell()
  const phoneStatus = usePhoneCloudStatus().data
  const desktopStatus = useDesktopCloudStatus(desktop && active).data
  const connected = (desktop ? desktopStatus : phoneStatus)?.state === 'connected'
  // Opening others needs the client role; an older server does not say.
  const canOpen = !(desktop && desktopStatus?.state === 'connected' && desktopStatus.client === false)
  const phoneDevicesQ = usePhoneCloudDevices(!desktop && connected && active)
  const desktopDevicesQ = useDesktopCloudDevices(desktop && connected && canOpen && active)
  const devicesQ = desktop ? desktopDevicesQ : phoneDevicesQ
  const devicesData: DeviceRow[] | undefined = devicesQ.data
  const lan = useLanComputers()
  const [app, setApp] = useState<AppBackendStatus | null>(null)
  // Whether the server the app is on answers now: a computer is In use over
  // its LAN address only while it does (its listener can be turned off).
  const [current, setCurrent] = useState<{ url: string; alive: boolean } | null>(null)
  const loadApp = useCallback(async () => {
    const next = await getAppBackendStatus()
    setApp(next)
    if (!next?.base_url || next.account_device) return
    const url = normalizeServerBaseUrl(next.base_url)
    const alive = await pingServer(url)
    setCurrent({ url, alive })
  }, [])
  const { refetch } = devicesQ

  useEffect(() => {
    // The desktop needs the app's status signed in or not: is the built-in server up?
    if (active && (connected || desktop)) void loadApp()
  }, [active, connected, desktop, loadApp])

  // The dots go stale: refresh while the screen is up and the app visible.
  useEffect(() => {
    if (!active || !connected || !poll) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refetch()
    }, ACCOUNT_COMPUTERS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, connected, poll, refetch])

  const computers = useMemo<AccountComputer[]>(() => {
    if (!connected || !canOpen) return []
    const servers = app?.servers ?? []
    const saved = new Set(servers.map((server) => normalizeServerBaseUrl(server.base_url)))
    return (devicesData ?? [])
      .filter((device) => !device.me && isServer(device))
      .map((device) => {
        const remembered = lan[normalizeFingerprint(device.fingerprint)]
        const lanUrl = remembered ? normalizeServerBaseUrl(remembered) : null
        return { device, label: accountComputerTitle(device, servers, lan), lanUrl: lanUrl && saved.has(lanUrl) ? lanUrl : null }
      })
  }, [connected, canOpen, devicesData, app, lan])

  const hiddenServerUrls = useMemo(
    () => new Set(computers.flatMap((computer) => (computer.lanUrl ? [computer.lanUrl] : []))),
    [computers],
  )
  const refresh = useCallback(async () => {
    await Promise.all([connected ? refetch() : undefined, loadApp()])
  }, [connected, refetch, loadApp])

  const currentAlive = app && current?.url === normalizeServerBaseUrl(app.base_url) ? current.alive : null
  // Desktop: the account lives in the built-in server, which is not running.
  const builtinStopped = desktop && app !== null && app.supports_bundled !== false && !app.sidecar_running
  return {
    computers,
    devices: connected ? devicesData : undefined,
    connected,
    canOpen,
    builtinStopped,
    hiddenServerUrls,
    app,
    currentAlive,
    refresh,
    reloadApp: loadApp,
  }
}

/**
 * The line under a computer: the route in use when the app is on it, else
 * what could reach it (and whether it is up).
 */
export function computerLine(computer: AccountComputer, route: 'bridge' | 'lan' | null, lanAvailable: boolean): string {
  if (route === 'bridge') return lanAvailable ? 'Through your account · Home network available' : 'Through your account'
  if (route === 'lan') return 'via LAN'
  if (computer.lanUrl) return 'Home network or account'
  if (computer.device.online === true) return 'Online · through your account'
  if (computer.device.online === false) return 'Offline'
  return 'via account'
}

/** The palette's line under a computer: the row's line, with "Current" on the one in use. */
export function accountComputerLine(computer: AccountComputer, app: AppBackendStatus | null): string {
  const onBridge = app?.account_device?.device_id === computer.device.device_id
  const onLan = Boolean(computer.lanUrl && app && normalizeServerBaseUrl(app.base_url) === computer.lanUrl)
  const line = computerLine(computer, onBridge ? 'bridge' : onLan ? 'lan' : null, false)
  return onBridge || onLan ? `Current · ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line
}
