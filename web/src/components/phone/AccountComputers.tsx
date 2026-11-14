/**
 * The account's computers: the phone's Servers screen (decision D8), and the
 * desktop app's Settings → Server (one component for both).
 *
 * One row per server of the account (spec 3.4: sessions open only on
 * devices with the server role; this device and clients left out). A
 * computer is its device, not an address: opening a row starts its link,
 * which reaches it directly on the home network or through the account's
 * relay and moves between the two by itself, with no reload. Saved servers
 * (address and access key) are a separate list and a separate thing, even
 * when one is the same machine: they are never merged into these rows.
 *
 * A row is titled by the name its computer gave for itself (its host name,
 * or what you called it), once the app has been on it; until then by its
 * system and key. The system, the key and the role are under **Details**
 * (a button, or the row's ⋯ on touch), where any computer is also renamed:
 * the name lives on the computer, so it is changed over the connection to
 * it (the computer in use) or over its link in the background (any other).
 *
 * The phone's account lives in its shell; the desktop's in the built-in
 * server (`api/cloud.ts` always calls that one). So on the desktop a
 * stopped built-in server leaves nothing to list: the section says so and
 * offers Start. A desktop signed in without the client role cannot open
 * other computers, and the section says that instead of listing them.
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
import { Fragment, useState } from 'react'
import { Info } from 'lucide-react'

import { isServer, type DeviceRow, type LinkRoute } from '@/api/phone-cloud'
import { ServerRow } from '@/components/AppBackendPanel'
import { ComputerDetailsDialog, deviceFacts } from '@/components/ComputerDetails'
import { ServerUpdateOnRow } from '@/components/settings/ServerUpdate'
import { ActionSheet } from '@/components/ui/action-sheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { PanelSection } from '@/components/ui/panel-section'
import { useTouchFirst } from '@/hooks/use-touch-first'
import {
  BUILTIN_STOPPED_COMPUTERS,
  CANNOT_OPEN_COMPUTERS,
  computerLine,
  type AccountComputer,
} from '@/lib/account-computers'
import type { AppBackendStatus } from '@/lib/app-backend'
import { connectAccountComputer, currentBackendOrigin, reloadForBackendSwitch } from '@/lib/backend-switch'
import { NAME_NEEDS_UPDATE, renameAccountComputer, serverInUseKeepsName } from '@/lib/computer-rename'
import { isDesktopShell } from '@/lib/desktop-shell'

export {
  ACCOUNT_COMPUTERS_REFRESH_MS,
  LINK_ROUTE_REFRESH_MS,
  BUILTIN_STOPPED_COMPUTERS,
  CANNOT_OPEN_COMPUTERS,
  accountComputerLine,
  computerLine,
  useAccountComputers,
  useLinkRoute,
  type AccountComputer,
} from '@/lib/account-computers'

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
  builtinStopped = false,
  onStartBuiltin,
  cannotOpen = false,
  onRenamed,
}: {
  computers: AccountComputer[]
  /** The account's devices have loaded (else an empty list says nothing yet). */
  loaded: boolean
  app: AppBackendStatus | null
  /** The route of the link to the computer in use. */
  route: LinkRoute
  /** Back to the Sessions of the server in use; absent while no server is connected. */
  onOpenSessions?: () => void
  /** Desktop: the built-in server, which holds the account, is stopped. */
  builtinStopped?: boolean
  /** Desktop: starts the built-in server (without switching to it). */
  onStartBuiltin?: () => Promise<void>
  /** Desktop: signed in without the client role, so it cannot open others. */
  cannotOpen?: boolean
  /** A computer was renamed: the host reads the app's status again. */
  onRenamed?: () => void | Promise<void>
}) {
  const touch = useTouchFirst()
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // Details stays on its computer while the dialog closes.
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sheet, setSheet] = useState<AccountComputer | null>(null)
  const desktop = isDesktopShell()
  if (builtinStopped) {
    const start = async () => {
      if (!onStartBuiltin) return
      setStarting(true)
      setError(null)
      try {
        await onStartBuiltin()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setStarting(false)
      }
    }
    return (
      <>
        <PanelSection title="Your computers">
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-(--color-text-2)">{BUILTIN_STOPPED_COMPUTERS}</p>
            {onStartBuiltin ? (
              <Button type="button" variant="subtle" size="sm" onClick={() => { void start() }} disabled={starting}>
                Start
              </Button>
            ) : null}
          </div>
        </PanelSection>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
      </>
    )
  }
  if (cannotOpen) {
    return (
      <PanelSection title="Your computers">
        <p className="text-xs leading-relaxed text-(--color-text-2)">{CANNOT_OPEN_COMPUTERS}</p>
      </PanelSection>
    )
  }
  if (computers.length === 0) {
    if (!loaded) return null
    return (
      <PanelSection title="Your computers">
        <div className="space-y-1 text-xs leading-relaxed text-(--color-text-2)">
          <p className="font-medium text-(--color-text)">No computers yet</p>
          <p>{desktop
            ? 'On another computer, open OpenAgentd, go to Settings → Account and sign in to your account.'
            : 'On your computer, open OpenAgentd, go to Settings → Account and sign in. You approve it here.'}</p>
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
  const showDetails = (computer: AccountComputer) => {
    setDetailsId(computer.device.device_id)
    setDetailsOpen(true)
  }
  const detailed = computers.find((computer) => computer.device.device_id === detailsId) ?? null
  // The computer in use is renamed over the connection to it, any other over its link.
  const detailedOnBridge = detailed !== null && onExternal && app?.account_device?.device_id === detailed.device.device_id
  const detailedName = detailed ? app?.computer_names?.[detailed.device.device_id] ?? null : null
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
            <Fragment key={computer.device.device_id}>
            <ServerRow
              health={computerHealth(computer.device)}
              title={computer.label}
              subtitle={computerLine(computer, onBridge, route)}
              inUse={inUse}
              onOpen={touch && idle ? (inUse ? onOpenSessions : () => { void open(computer) }) : undefined}
              onMore={touch ? () => setSheet(computer) : undefined}
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
              {touch ? null : (
                <Button type="button" variant="ghost" size="sm" aria-label={`Details of ${computer.label}`} onClick={() => showDetails(computer)}>
                  Details
                </Button>
              )}
            </ServerRow>
            {inUse ? <ServerUpdateOnRow /> : null}
            </Fragment>
          )
        })}
      </PanelSection>
      {error && <Callout tone="error" role="alert">{error}</Callout>}
      {opened && !error && <Callout tone="info" role="status">{opened}</Callout>}
      <ActionSheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet?.label ?? 'Computer'}
        // No Open or Use here: a tap on the row already does it.
        items={sheet ? [{ id: 'details', label: 'Details', icon: Info, afterClose: true, run: () => showDetails(sheet) }] : []}
      />
      <ComputerDetailsDialog
        open={detailsOpen && detailed !== null}
        onOpenChange={setDetailsOpen}
        title={detailed?.label ?? ''}
        name={detailedName}
        facts={detailed ? deviceFacts({
          kind: detailed.device.kind,
          fingerprint: detailed.device.fingerprint,
          signer: detailed.device.signer,
          server: isServer(detailed.device),
          client: detailed.device.client ?? false,
        }) : []}
        rename={detailed && (!detailedOnBridge || serverInUseKeepsName()) ? {
          name: detailedName ?? '',
          save: async (name) => {
            await renameAccountComputer(app, detailed.device.device_id, name)
            await onRenamed?.()
          },
        } : null}
        renameHint={NAME_NEEDS_UPDATE}
      />
    </>
  )
}
