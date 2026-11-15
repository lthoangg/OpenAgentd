/**
 * The account's computers, as rows of the one list of computers
 * (`AppBackendPanel`'s `accountRows`): the phone's Computers screen and the
 * desktop app's Settings → Server.
 *
 * One row per server of the account (spec 3.4: sessions open only on
 * devices with the server role; this device and clients left out). A
 * computer is its device, not an address: opening a row starts its link,
 * which reaches it directly on the home network or through the account's
 * relay and moves between the two by itself, with no reload. A computer
 * added by address is its own row, even when it is the same machine: the
 * two are listed together and never merged.
 *
 * A row is titled by the name the account keeps for the computer (an
 * older shell: the name it gave for itself once the app had been on it);
 * else by its system and key. The system, the key and the role are under
 * **Details** (a button, or the row's ⋯ on touch), where any computer is
 * also renamed: in the account, and on the computer itself over the
 * connection to it or its link, in the background.
 *
 * The phone's account lives in its shell; the desktop's in this computer's
 * own OpenAgentd (`api/cloud.ts` always calls that one). So on the desktop,
 * while that is stopped, there is nothing to list: a row says so and offers
 * Start. A desktop signed in without the client role cannot open other
 * computers, and a row says that instead of listing them. An account with
 * no other computer has one row that says how the first one is added.
 *
 * The line under a computer in use names the route its link is on: "On
 * your network" or "Through your account" (`cloud_link_route`, polled while
 * the screen is up). Otherwise it says what the account knows (online,
 * can't reach) and that the row is "from your account". A failed open
 * shows the error under the rows.
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
import { ROW_PAD } from '@/components/settings/tokens'
import { useTouchFirst } from '@/hooks/use-touch-first'
import {
  BUILTIN_STOPPED_COMPUTERS,
  CANNOT_OPEN_COMPUTERS,
  computerLine,
  type AccountComputer,
} from '@/lib/account-computers'
import type { AppBackendStatus } from '@/lib/app-backend'
import { connectAccountComputer, currentBackendOrigin, reloadForBackendSwitch } from '@/lib/backend-switch'
import { NAME_NEEDS_UPDATE, renameAccountDevice, serverInUseKeepsName } from '@/lib/computer-rename'
import { isDesktopShell } from '@/lib/desktop-shell'
import { cn } from '@/lib/utils'

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

/**
 * The row's line in the one list of computers: what the account knows
 * (online, can't reach), and that the row is from the account. The route of
 * the computer in use ("On your network", "Through your account") stands alone.
 */
function fromAccount(line: string): string {
  if (line === 'Your account') return 'From your account'
  if (line === 'Online' || line === "Can't reach") return `${line} \u00b7 from your account`
  return line
}

function computerHealth(device: DeviceRow): 'online' | 'offline' | null {
  if (device.online === true) return 'online'
  if (device.online === false) return 'offline'
  return null
}

export function AccountComputerRows({
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
  const [starting, setStarting] = useState(false)
  // Details stays on its computer while the dialog closes.
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sheet, setSheet] = useState<AccountComputer | null>(null)
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
    const stopped = (
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-(--color-text-2)">{BUILTIN_STOPPED_COMPUTERS}</p>
        {onStartBuiltin ? (
          <Button type="button" variant="subtle" size="sm" onClick={() => { void start() }} disabled={starting}>
            Start
          </Button>
        ) : null}
      </div>
    )
    return (
      <div data-account-note="" className={cn(ROW_PAD, 'space-y-2')}>
        {stopped}
        {error && <p role="alert" className="text-xs text-(--color-error)">{error}</p>}
      </div>
    )
  }
  if (cannotOpen) {
    return (
      <div data-account-note="" className={ROW_PAD}>
        <p className="text-xs leading-relaxed text-(--color-text-2)">{CANNOT_OPEN_COMPUTERS}</p>
      </div>
    )
  }
  if (computers.length === 0) {
    if (!loaded) return null
    // Signed in with no computer yet: one row says how the first one gets here.
    return (
      <div data-account-note="" className={cn(ROW_PAD, 'space-y-1 text-xs leading-relaxed text-(--color-text-2)')}>
        <p className="font-medium text-(--color-text)">No computers in your account yet</p>
        <p>{isDesktopShell()
          ? 'On another computer, open OpenAgentd, go to Settings → Account and sign in to your account.'
          : 'On your computer, open OpenAgentd, go to Settings → Account and sign in. You approve it here.'}</p>
      </div>
    )
  }

  const open = async (computer: AccountComputer) => {
    setOpening(computer.device.device_id)
    setError(null)
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
  // The account's name for it; an older shell keeps none, then what the computer called itself.
  const detailedName = detailed
    ? (detailed.device.name !== undefined ? detailed.device.name : app?.computer_names?.[detailed.device.device_id]) ?? null
    : null
  const rows = (
    <>
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
              subtitle={fromAccount(computerLine(computer, onBridge, route))}
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
    </>
  )
  return (
    <>
      {rows}
      {error ? <p role="alert" className={cn(ROW_PAD, 'text-xs text-(--color-error)')}>{error}</p> : null}
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
        rename={detailed && (detailed.device.name !== undefined || !detailedOnBridge || serverInUseKeepsName()) ? {
          name: detailedName ?? '',
          save: async (name) => {
            await renameAccountDevice(app, { ...detailed.device, me: false, server: true }, name)
            await onRenamed?.()
          },
        } : null}
        renameHint={NAME_NEEDS_UPDATE}
      />
    </>
  )
}
