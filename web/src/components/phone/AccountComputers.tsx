/**
 * The account's computers on the phone's Servers screen (decision D8).
 *
 * One row per server of the account (spec 3.4: the phone opens sessions
 * only on devices with the server role; itself and clients left out). A saved LAN server that is known to be the same computer (its
 * remembered fingerprint matches, see `lib/computer-fingerprints`) is that
 * row, titled with the name the person gave it, and no longer appears again
 * in the saved list. Opening a row asks the shell to try the LAN address and
 * the account's relay together (the LAN wins when it answers fast and takes
 * the stored key), then switches to it like choosing a saved server.
 *
 * The line under a computer follows the route in use: "Through your account"
 * on its bridge, "via LAN" on its LAN address while that answers. A computer
 * not in use never claims "via LAN": a row with a saved LAN address says
 * "Home network or account", one without says what the account knows
 * (online, offline). On its bridge, a row with a saved LAN address also
 * offers "Use home network" (touch and pointer alike); the route re-check
 * (`lib/account-route`) adds "Home network available" to the line when it
 * answers but the phone did not move by itself (a reply is running, or the
 * composer holds text). A failed switch shows the error below the list.
 *
 * The dot is the cloud's word on whether the computer holds its relay
 * connection (`online`; none when it could not say). It can be stale, so an
 * offline computer can still be tapped. The list refreshes every 30 s while
 * the screen is up and visible. A row is In use when the app is on it, over
 * its LAN address or its account bridge.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { isServer, type DeviceRow } from '@/api/phone-cloud'
import { ServerRow } from '@/components/AppBackendPanel'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { accountComputerTitle, getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import {
  connectAccountComputer,
  currentBackendOrigin,
  normalizeServerBaseUrl,
  reloadForBackendSwitch,
} from '@/lib/backend-switch'
import { normalizeFingerprint, useLanComputers } from '@/lib/computer-fingerprints'
import { pingServer } from '@/lib/server-probe'
import { usePhoneCloudDevices, usePhoneCloudStatus } from '@/queries/phone-cloud'
import { setLanAvailable, useAccountRouteStore } from '@/stores/useAccountRouteStore'

/** How often the computers (and their dots) refresh while the screen is up. */
export const ACCOUNT_COMPUTERS_REFRESH_MS = 30_000

export interface AccountComputer {
  device: DeviceRow
  label: string
  /** The saved LAN server that is this computer, normalized; null: only the account reaches it. */
  lanUrl: string | null
}

export function useAccountComputers(active: boolean) {
  const connected = usePhoneCloudStatus().data?.state === 'connected'
  const devicesQ = usePhoneCloudDevices(connected && active)
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
    const servers = app?.servers ?? []
    const saved = new Set(servers.map((server) => normalizeServerBaseUrl(server.base_url)))
    return (devicesQ.data ?? [])
      .filter((device) => !device.me && isServer(device))
      .map((device) => {
        const remembered = lan[normalizeFingerprint(device.fingerprint)]
        const lanUrl = remembered ? normalizeServerBaseUrl(remembered) : null
        return { device, label: accountComputerTitle(device, servers, lan), lanUrl: lanUrl && saved.has(lanUrl) ? lanUrl : null }
      })
  }, [connected, devicesQ.data, app, lan])

  const hiddenServerUrls = useMemo(
    () => new Set(computers.flatMap((computer) => (computer.lanUrl ? [computer.lanUrl] : []))),
    [computers],
  )
  const refresh = useCallback(async () => {
    await Promise.all([connected ? refetch() : undefined, loadApp()])
  }, [connected, refetch, loadApp])

  const currentAlive = app && current?.url === normalizeServerBaseUrl(app.base_url) ? current.alive : null
  return { computers, devices: connected ? devicesQ.data : undefined, connected, hiddenServerUrls, app, currentAlive, refresh }
}

/**
 * The line under a computer: the route in use when the app is on it, else
 * what could reach it (and whether it is up).
 */
function computerLine(computer: AccountComputer, route: 'bridge' | 'lan' | null, lanAvailable: boolean): string {
  if (route === 'bridge') return lanAvailable ? 'Through your account · Home network available' : 'Through your account'
  if (route === 'lan') return 'via LAN'
  if (computer.lanUrl) return 'Home network or account'
  if (computer.device.online === true) return 'Online · via account'
  if (computer.device.online === false) return 'Offline'
  return 'via account'
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
  currentAlive,
  onOpenSessions,
}: {
  computers: AccountComputer[]
  /** The account's devices have loaded (else an empty list says nothing yet). */
  loaded: boolean
  app: AppBackendStatus | null
  /** The app's current server answered its last ping (null: not checked). */
  currentAlive: boolean | null
  /** Back to the Sessions of the server in use; absent while no server is connected. */
  onOpenSessions?: () => void
}) {
  const touch = useTouchFirst()
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const lanAvailable = useAccountRouteStore((state) => state.lanAvailable)
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
      lanBaseUrl: computer.lanUrl,
      label: computer.label,
      currentBaseUrl: currentBackendOrigin(app),
    })
    setOpening(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setOpened(result.via === 'lan' ? 'Opened over your network.' : 'Opened through your account.')
    if (result.reload) reloadForBackendSwitch()
    // The same server, answering again: go on to its Sessions.
    else onOpenSessions?.()
  }

  // From the account bridge to the computer's saved home-network address.
  const switchToHomeNetwork = async (computer: AccountComputer) => {
    if (!computer.lanUrl) return
    setOpening(computer.device.device_id)
    setError(null)
    setOpened(null)
    const result = await connectAccountComputer({
      deviceId: computer.device.device_id,
      lanBaseUrl: computer.lanUrl,
      label: computer.label,
      currentBaseUrl: currentBackendOrigin(app),
    })
    setOpening(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.via !== 'lan') {
      // The shell found the home network slower or its key refused: still on the account.
      setError("Your home network didn't answer, or doesn't accept this phone's key. Still using your account.")
      if (result.reload) reloadForBackendSwitch()
      return
    }
    setLanAvailable(computer.device.device_id, false)
    setOpened('Opened over your network.')
    if (result.reload) reloadForBackendSwitch()
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
          // In use only while the app reaches it: on its account bridge, or
          // on its LAN address while that answers. Otherwise a tap opens it
          // again (LAN first, then the account) rather than a dead Sessions.
          const onBridge = app?.account_device?.device_id === computer.device.device_id
          const onLan = Boolean(computer.lanUrl && app && normalizeServerBaseUrl(app.base_url) === computer.lanUrl && currentAlive === true)
          const inUse = Boolean(onOpenSessions) && onExternal && (onBridge || onLan)
          const idle = opening === null
          const homeNetwork = onBridge && computer.lanUrl ? (
            <Button type="button" variant="subtle" size="sm" aria-label={`Use home network for ${computer.label}`} onClick={() => { void switchToHomeNetwork(computer) }} disabled={!idle}>
              Use home network
            </Button>
          ) : null
          return (
            <ServerRow
              key={computer.device.device_id}
              health={computerHealth(computer.device)}
              title={computer.label}
              subtitle={computerLine(computer, onBridge ? 'bridge' : onLan ? 'lan' : null, Boolean(lanAvailable[computer.device.device_id]))}
              inUse={inUse}
              onOpen={touch && idle ? (inUse ? onOpenSessions : () => { void open(computer) }) : undefined}
            >
              {homeNetwork}
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
