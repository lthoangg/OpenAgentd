/**
 * The account's computers on the phone's Servers screen (decision D8).
 *
 * One row per server of the account (spec 3.4: the phone opens sessions
 * only on devices with the server role; itself and clients left out). A saved LAN server that is known to be the same computer (its
 * remembered fingerprint matches, see `lib/computer-fingerprints`) is that
 * row, "via LAN", and no longer appears again in the saved list. Opening a
 * row asks the shell for the LAN address first and the account's relay
 * otherwise, then switches to it like choosing a saved server.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { deviceLabel, isServer, type DeviceRow } from '@/api/phone-cloud'
import { ServerRow } from '@/components/AppBackendPanel'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { getAppBackendStatus, type AppBackendStatus } from '@/lib/app-backend'
import {
  connectAccountComputer,
  currentBackendOrigin,
  normalizeServerBaseUrl,
  reloadForBackendSwitch,
} from '@/lib/backend-switch'
import { normalizeFingerprint, useLanComputers } from '@/lib/computer-fingerprints'
import { usePhoneCloudDevices, usePhoneCloudStatus } from '@/queries/phone-cloud'

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
  const loadApp = useCallback(() => getAppBackendStatus().then(setApp), [])
  const { refetch } = devicesQ

  useEffect(() => {
    if (active && connected) void loadApp()
  }, [active, connected, loadApp])

  const computers = useMemo<AccountComputer[]>(() => {
    if (!connected) return []
    const saved = new Set((app?.servers ?? []).map((server) => normalizeServerBaseUrl(server.base_url)))
    return (devicesQ.data ?? [])
      .filter((device) => !device.me && isServer(device))
      .map((device) => {
        const remembered = lan[normalizeFingerprint(device.fingerprint)]
        const lanUrl = remembered ? normalizeServerBaseUrl(remembered) : null
        return { device, label: deviceLabel(device), lanUrl: lanUrl && saved.has(lanUrl) ? lanUrl : null }
      })
  }, [connected, devicesQ.data, app, lan])

  const hiddenServerUrls = useMemo(
    () => new Set(computers.flatMap((computer) => (computer.lanUrl ? [computer.lanUrl] : []))),
    [computers],
  )
  const refresh = useCallback(async () => {
    await Promise.all([connected ? refetch() : undefined, loadApp()])
  }, [connected, refetch, loadApp])

  return { computers, hiddenServerUrls, app, refresh }
}

export function AccountComputersSection({
  computers,
  app,
  onOpenSessions,
}: {
  computers: AccountComputer[]
  app: AppBackendStatus | null
  onOpenSessions: () => void
}) {
  const touch = useTouchFirst()
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  if (computers.length === 0) return null

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
          const inUse = Boolean(onExternal && computer.lanUrl && app && normalizeServerBaseUrl(app.base_url) === computer.lanUrl)
          const idle = opening === null
          return (
            <ServerRow
              key={computer.device.device_id}
              health={null}
              title={computer.label}
              subtitle={computer.lanUrl ? 'via LAN' : 'via account'}
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
