/**
 * The account's computers as data: which servers of the account this app
 * can open, their line, and whether the desktop's built-in server (which
 * holds its account) is up. `AccountComputersSection` draws them (the phone's
 * Servers screen, the desktop's Settings → Server), and the command palette
 * lists them; this module stays light so the palette does not load the
 * Servers UI.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getLinkRoute, isServer, type DeviceRow, type LinkRoute } from '@/api/phone-cloud'
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import { isDesktopShell } from '@/lib/desktop-shell'
import { useDesktopCloudDevices, useDesktopCloudStatus } from '@/queries/cloud-light'
import { usePhoneCloudDevices, usePhoneCloudStatus } from '@/queries/phone-cloud'

/** How often the computers (and their dots) refresh while the screen is up. */
export const ACCOUNT_COMPUTERS_REFRESH_MS = 30_000
/** How often the route of the computer in use is read while the screen is up. */
export const LINK_ROUTE_REFRESH_MS = 2_000

/** A desktop signed in without "Use as client" (spec 3.4). */
export const CANNOT_OPEN_COMPUTERS = "This computer can't open your other computers: it isn't used as a client. Roles are chosen when it signs in."
/** The desktop's account lives in the built-in server. */
export const BUILTIN_STOPPED_COMPUTERS = 'The built-in server is stopped. Your account lives there: start it to use your other computers.'

/**
 * A computer of the account: its device, never an address. A saved server
 * (address and access key) is a separate thing, even on the same machine.
 */
export interface AccountComputer {
  device: DeviceRow
  label: string
}

/** The route of the link to `deviceId` while `active`, read now and then. */
export function useLinkRoute(deviceId: string | null, active: boolean): LinkRoute {
  const [route, setRoute] = useState<LinkRoute>('none')
  useEffect(() => {
    if (!deviceId || !active) return
    let cancelled = false
    const read = () => {
      if (document.visibilityState !== 'visible') return
      void getLinkRoute(deviceId).then((r) => { if (!cancelled) setRoute(r) })
    }
    read()
    const timer = window.setInterval(read, LINK_ROUTE_REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [deviceId, active])
  return deviceId && active ? route : 'none'
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
  const [app, setApp] = useState<AppBackendStatus | null>(null)
  const loadApp = useCallback(async () => {
    setApp(await getAppBackendStatus())
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
    return (devicesData ?? [])
      .filter((device) => !device.me && isServer(device))
      .map((device) => ({ device, label: accountComputerTitle(device) }))
  }, [connected, canOpen, devicesData])

  const refresh = useCallback(async () => {
    await Promise.all([connected ? refetch() : undefined, loadApp()])
  }, [connected, refetch, loadApp])

  const route = useLinkRoute(app?.account_device?.device_id ?? null, active && connected)
  // Desktop: the account lives in the built-in server, which is not running.
  const builtinStopped = desktop && app !== null && app.supports_bundled !== false && !app.sidecar_running
  return {
    computers,
    devices: connected ? devicesData : undefined,
    connected,
    canOpen,
    builtinStopped,
    app,
    route,
    refresh,
    reloadApp: loadApp,
  }
}

/**
 * The line under a computer: the route its link is on when the app is on
 * it ("On your network", "Through your account"), else what the account
 * knows.
 */
export function computerLine(computer: AccountComputer, inUse: boolean, route: LinkRoute): string {
  if (inUse) {
    if (route === 'direct') return 'On your network'
    if (route === 'relay') return 'Through your account'
    if (route === 'connecting') return 'Connecting\u2026'
    if (route === 'down') return "Can't reach it \u00b7 Retrying\u2026"
  }
  if (computer.device.online === true) return 'Online'
  if (computer.device.online === false) return 'Offline'
  return 'Your account'
}

/** The palette's line under a computer: the row's line, with "Current" on the one in use. */
export function accountComputerLine(computer: AccountComputer, app: AppBackendStatus | null, route: LinkRoute = 'none'): string {
  const inUse = app?.account_device?.device_id === computer.device.device_id
  if (!inUse) return computerLine(computer, false, route)
  const line = route === 'none' ? 'Your account' : computerLine(computer, true, route)
  return `Current \u00b7 ${line.charAt(0).toLowerCase()}${line.slice(1)}`
}
