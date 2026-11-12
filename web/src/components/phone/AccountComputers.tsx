/**
 * The account's computers on the phone's Servers screen (decision D8).
 *
 * One row per server of the account (spec 3.4: the phone opens sessions
 * only on devices with the server role; itself and clients left out). A
 * computer is its device, not an address: opening a row starts its link in
 * the shell, which reaches it directly on the home network or through the
 * account's relay and moves between the two by itself, with no reload.
 * Saved servers (address and access key) are a separate list and a
 * separate thing, even when one is the same machine: they are never merged
 * into these rows.
 *
 * The line under a computer in use names the route its link is on: "On
 * your network" or "Through your account" (`cloud_link_route`, polled while
 * the screen is up). Otherwise it says what the account knows (online,
 * offline). A failed open shows the error below the list.
 *
 * The dot is the cloud's word on whether the computer holds its relay
 * connection (`online`; none when it could not say). It can be stale, so an
 * offline computer can still be tapped. The list refreshes every 30 s while
 * the screen is up and visible. A row is In use when the app is on its
 * bridge.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { getLinkRoute, isServer, type DeviceRow, type LinkRoute } from '@/api/phone-cloud'
import { ServerRow } from '@/components/AppBackendPanel'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import { connectAccountComputer, currentBackendOrigin, reloadForBackendSwitch } from '@/lib/backend-switch'
import { usePhoneCloudDevices, usePhoneCloudStatus } from '@/queries/phone-cloud'

/** How often the computers (and their dots) refresh while the screen is up. */
export const ACCOUNT_COMPUTERS_REFRESH_MS = 30_000
/** How often the route of the computer in use is read while the screen is up. */
export const LINK_ROUTE_REFRESH_MS = 2_000

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

export function useAccountComputers(active: boolean) {
  const connected = usePhoneCloudStatus().data?.state === 'connected'
  const devicesQ = usePhoneCloudDevices(connected && active)
  const [app, setApp] = useState<AppBackendStatus | null>(null)
  const loadApp = useCallback(async () => {
    setApp(await getAppBackendStatus())
  }, [])
  const { refetch } = devicesQ

  useEffect(() => {
    if (active && connected) void loadApp()
  }, [active, connected, loadApp])

  // The dots go stale: refresh while the screen is up and the app visible.
  useEffect(() => {
    if (!active || !connected) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refetch()
    }, ACCOUNT_COMPUTERS_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [active, connected, refetch])

  const computers = useMemo<AccountComputer[]>(() => {
    if (!connected) return []
    return (devicesQ.data ?? [])
      .filter((device) => !device.me && isServer(device))
      .map((device) => ({ device, label: accountComputerTitle(device) }))
  }, [connected, devicesQ.data])

  const refresh = useCallback(async () => {
    await Promise.all([connected ? refetch() : undefined, loadApp()])
  }, [connected, refetch, loadApp])

  const route = useLinkRoute(app?.account_device?.device_id ?? null, active && connected)
  return { computers, devices: connected ? devicesQ.data : undefined, connected, app, route, refresh }
}

/**
 * The line under a computer: the route its link is on when the app is on
 * it, else what the account knows.
 */
export function computerLine(computer: AccountComputer, inUse: boolean, route: LinkRoute): string {
  if (inUse) {
    if (route === 'direct') return 'On your network'
    if (route === 'relay') return 'Through your account'
    if (route === 'connecting') return 'Connecting…'
    if (route === 'down') return "Can't reach it · Retrying…"
  }
  if (computer.device.online === true) return 'Online'
  if (computer.device.online === false) return 'Offline'
  return 'Your account'
}

function computerHealth(device: DeviceRow): 'online' | 'offline' | null {
  if (device.online === true) return 'online'
  if (device.online === false) return 'offline'
  return null
}

export function AccountComputersSection({
  computers,
  loaded,
  app,
  route,
  onOpenSessions,
}: {
  computers: AccountComputer[]
  /** The account's devices have loaded (else an empty list says nothing yet). */
  loaded: boolean
  app: AppBackendStatus | null
  /** The route of the link to the computer in use. */
  route: LinkRoute
  /** Back to the Sessions of the server in use; absent while no server is connected. */
  onOpenSessions?: () => void
}) {
  const touch = useTouchFirst()
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  if (computers.length === 0) {
    if (!loaded) return null
    return (
      <PanelSection title="Your computers">
        <div className="space-y-1 text-xs leading-relaxed text-(--color-text-2)">
          <p className="font-medium text-(--color-text)">No computers yet</p>
          <p>On your computer, open OpenAgentd, go to Settings → Account and sign in. You approve it here.</p>
        </div>
      </PanelSection>
    )
  }

  const open = async (computer: AccountComputer) => {
    setOpening(computer.device.device_id)
    setError(null)
    setOpened(null)
    const result = await connectAccountComputer({
      deviceId: computer.device.device_id,
      label: computer.label,
      currentBaseUrl: currentBackendOrigin(app),
    })
    setOpening(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpened('Opened.')
    if (result.reload) reloadForBackendSwitch()
    // The same server, answering again: go on to its Sessions.
    else onOpenSessions?.()
  }

  const onExternal = app?.mode === 'external' || Boolean(app?.external)
  return (
    <>
      <PanelSection
        title="Your computers"
        description={touch ? 'Tap a computer to use it, at home or away.' : 'Use opens a computer of your account, at home or away.'}
        flush
      >
        {computers.map((computer) => {
          // In use while the app is on its bridge; the link under it picks
          // the route.
          const onBridge = app?.account_device?.device_id === computer.device.device_id
          const inUse = Boolean(onOpenSessions) && onExternal && onBridge
          const idle = opening === null
          return (
            <ServerRow
              key={computer.device.device_id}
              health={computerHealth(computer.device)}
              title={computer.label}
              subtitle={computerLine(computer, onBridge, route)}
              inUse={inUse}
              onOpen={touch && idle ? (inUse ? onOpenSessions : () => { void open(computer) }) : undefined}
            >
              {inUse ? (
                touch ? null : (
                  <Button type="button" variant="subtle" size="sm" aria-label={`Open sessions on ${computer.label}`} onClick={onOpenSessions}>
                    Sessions
                  </Button>
                )
              ) : touch ? null : (
                <Button type="button" variant="subtle" size="sm" aria-label={`Use ${computer.label}`} onClick={() => { void open(computer) }} disabled={!idle}>
                  Use
                </Button>
              )}
            </ServerRow>
          )
        })}
      </PanelSection>
      {error && <Callout tone="error" role="alert">{error}</Callout>}
      {opened && !error && <Callout tone="info" role="status">{opened}</Callout>}
    </>
  )
}
