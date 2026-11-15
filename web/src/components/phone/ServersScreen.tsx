/**
 * ServersScreen — the phone's bottom level: Computers → Sessions → a chat.
 *
 * One list of computers, as Settings → Computers lists them
 * (``AppBackendPanel``, so connecting, keys and editing live in one place):
 * the ones of the phone's account and the ones added by address, under a
 * large "Computers" title that hands over to the bar's small one as it
 * scrolls away. The row in use offers **Sessions ›**, which pushes its
 * session list back over this screen; a tap on another switches the app to
 * it (the "Switching to…" screen, then its Sessions).
 *
 * ``active``: the screen is on top, or one swipe away under Sessions. The
 * panel loads the list and pings each address every time it turns true, so
 * a swipe back reveals the real list with fresh states.
 *
 * Pulling the list down reloads it and pings every computer again.
 *
 * Under the list: the phone's account (`AccountSection`, there before any
 * computer answers, so a phone can sign in and approve devices first). One
 * **Scan QR code** (under the list) reads
 * both an account invitation and a computer's connect code
 * (`useScanAnyCode`).
 *
 * A computer's sign-in code scanned before this phone can approve devices
 * is held in memory (`pendingAdd`) while the Account sheet signs the phone
 * in; once it is connected and approves devices, Add this computer opens
 * with it. It is dropped when the sign-in is cancelled, when the sheet is
 * closed before signing in, or when the phone joins without approving.
 * The code's own 10 minutes still apply: Add this computer says so.
 *
 * Last, in the phone app signed in to an account, **Copy diagnostics**
 * (`ConnectionDiagnosticsRow`): the shell's last connection events, for a
 * problem report.
 *
 * It is the phone's only picker of a computer: the connection banner, the
 * chip on Sessions and a scanned connect link open it
 * (``useServersScreenStore``), and before any computer answers the app
 * shows it in place of the loading screen.
 */
import { useEffect, useRef, useState } from 'react'

import { AppBackendPanel, type AppBackendPanelControl, type AppBackendPrefill } from '@/components/AppBackendPanel'
import { AccountComputerRows, useAccountComputers } from '@/components/phone/AccountComputers'
import { AccountSection } from '@/components/phone/AccountSection'
import { AccountSheet } from '@/components/phone/AccountSheet'
import { ConnectionDiagnosticsRow } from '@/components/phone/ConnectionDiagnostics'
import { PullToRefresh } from '@/components/phone/PullToRefresh'
import { QrScanOverlay } from '@/components/phone/QrScanOverlay'
import { useScanAnyCode } from '@/components/phone/useScanAnyCode'
import { AddScannedSheet } from '@/components/phone/AddScannedSheet'
import { CANT_ADD_DEVICES } from '@/components/settings/pages/remote-copy'
import { PhoneAccountContent } from '@/components/settings/pages/settings.remote.phone'
import { Button } from '@/components/ui/button'
import { useAppStatusWithNames } from '@/lib/account-computers'
import { thisDeviceName } from '@/lib/device-words'
import { Callout } from '@/components/ui/callout'
import { cancelQrScan, canScanQr } from '@/lib/qr-scan'
import { isPhoneCloudShell } from '@/api/phone-cloud'
import { usePhoneCloudStatus } from '@/queries/phone-cloud'
import { useLargeTitleCollapse } from '@/components/Sidebar/useLargeTitleCollapse'
import { takeServersPrefill, useServersScreenStore } from '@/stores/useServersScreenStore'

/** What the Account sheet says while a scanned device waits for this phone to sign in. */
export const ADD_AFTER_SIGN_IN = 'Sign in on this phone. Then it adds the device you scanned.'
export const JOINED_WITHOUT_APPROVING = CANT_ADD_DEVICES
/** On the Computers screen, once a new device got into the account from its first screen. */
export const ALL_SET = "You're all set. Your computers are below."

/** States where a new device is still on its way into an account (its first screen stays up). */
const ON_THE_WAY = new Set(['guest', 'signing_in', 'scanned', 'confirming', 'joining', 'invited', 'recovery'])

/** The first screen's title: "Use your computers on this iPad". */
export function welcomeTitle(self = thisDeviceName()): string {
  return `Use your computers on ${self === 'phone' ? 'this phone' : `this ${self}`}`
}

/** A scanned computer waiting for this phone to sign in. `leftGuest`: a sign-in has started. */
interface PendingAdd {
  link: string
  leftGuest: boolean
}

export function ServersScreen({ active, onOpenSessions }: {
  active: boolean
  /** Back up to the Sessions of the server in use; absent before any server answers. */
  onOpenSessions?: () => void
}) {
  const { barRef, titleRef, onScroll } = useLargeTitleCollapse(false)
  const panel = useRef<AppBackendPanelControl>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  const [addComputer, setAddComputer] = useState<string | null>(null)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const { computers, devices, connected, app, route, refresh: refreshComputers } = useAccountComputers(active)
  // A connect link's address and key, kept while the screen is up.
  const pending = useServersScreenStore((state) => state.prefill)
  const [prefill, setPrefill] = useState<AppBackendPrefill | null>(null)
  useEffect(() => {
    if (pending) setPrefill(takeServersPrefill())
  }, [pending])
  // A scanned invitation: the sheet shows the Joining step, and once the
  // other device adds this phone it closes onto the account's computers.
  const joinedByScan = useRef(false)
  const scanner = useScanAnyCode({
    onConnect: setPrefill,
    onAddComputer: setAddComputer,
    onAddAfterSignIn: (link) => {
      setAddError(null)
      setPendingAdd({ link, leftGuest: false })
      setAccountOpen(true)
    },
    onJoining: () => {
      joinedByScan.current = true
      setAccountOpen(true)
    },
  })
  const accountStatus = usePhoneCloudStatus().data
  const accountState = accountStatus?.state
  const signer = accountStatus?.state === 'connected' && accountStatus.signer
  // A new device (no account, no computer saved by address) opens on the
  // QR code its other phone scans; "Other ways to connect" shows this screen.
  const appStatus = useAppStatusWithNames()
  const [otherWays, setOtherWays] = useState(false)
  const supported = !(accountStatus?.state === 'guest' && !accountStatus.supported)
  const welcome = isPhoneCloudShell() && supported && !otherWays && !pendingAdd && !prefill && appStatus !== null
    && appStatus.servers.length === 0 && accountState !== undefined && ON_THE_WAY.has(accountState)
  // Joined from the first screen: one line says where the computers are.
  const [allSet, setAllSet] = useState(false)
  const wasWelcome = useRef(false)
  useEffect(() => {
    if (welcome) wasWelcome.current = true
    else if (wasWelcome.current && accountState === 'connected') {
      wasWelcome.current = false
      setAllSet(true)
    }
  }, [welcome, accountState])
  useEffect(() => {
    if (!joinedByScan.current) return
    if (accountState === 'connected') {
      joinedByScan.current = false
      setAccountOpen(false)
    } else if (accountState === 'guest') {
      joinedByScan.current = false
    }
  }, [accountState])
  // The scanned computer, once this phone has signed in (or given up).
  useEffect(() => {
    if (!pendingAdd || !accountState) return
    if (accountState === 'connected') {
      setPendingAdd(null)
      setAccountOpen(false)
      if (signer) setAddComputer(pendingAdd.link)
      else setAddError(JOINED_WITHOUT_APPROVING)
    } else if (accountState === 'guest') {
      // Back to guest after a sign-in started: it was cancelled or denied.
      if (pendingAdd.leftGuest) setPendingAdd(null)
    } else if (!pendingAdd.leftGuest) {
      setPendingAdd({ ...pendingAdd, leftGuest: true })
    }
  }, [pendingAdd, accountState, signer])
  const closeAccount = () => {
    setAccountOpen(false)
    // Closed before any sign-in started: the person gave up on adding it.
    if (pendingAdd && accountState === 'guest') setPendingAdd(null)
  }
  const scan = canScanQr() ? () => { void scanner.scan() } : undefined
  if (welcome) {
    return (
      <div data-servers-screen="" data-new-device-screen="" className="flex h-full w-full min-w-0 flex-col bg-(--bg-page)">
        <header className="mobile-safe-header shrink-0" />
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-safe">
          <div className="mx-auto max-w-md space-y-6 py-4">
            <h1 className="text-large-title font-bold text-(--color-text)">{welcomeTitle()}</h1>
            <PhoneAccountContent />
            <div className="flex justify-center">
              <Button variant="link" size="sm" onClick={() => setOtherWays(true)}>Other ways to connect</Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div data-servers-screen="" className="flex h-full w-full min-w-0 flex-col bg-(--bg-page)">
      <header
        ref={barRef}
        data-servers-bar=""
        className="group/bar mobile-safe-header flex shrink-0 items-center justify-center border-b border-transparent px-3 transition-colors duration-(--motion-fast) data-title-visible:border-(--color-border)"
      >
        {/* The large title is the heading; this one only echoes it. */}
        <span
          aria-hidden="true"
          className="text-base font-semibold text-(--color-text) opacity-0 transition-opacity duration-(--motion-fast) group-data-title-visible/bar:opacity-100"
        >
          Computers
        </span>
      </header>
      <PullToRefresh
        data-servers-scroller=""
        className="min-h-0 flex-1 overflow-x-hidden pb-safe"
        onScroll={onScroll}
        onRefresh={async () => { await Promise.all([panel.current?.refresh(), refreshComputers()]) }}
      >
        <div className="px-4 pb-2">
          <h1 ref={titleRef} className="pb-1 pt-0.5 text-large-title font-bold text-(--color-text)">
            Computers
          </h1>
        </div>
        <div className="space-y-8 px-4 pb-6">
          {allSet && connected && <Callout tone="success" role="status">{ALL_SET}</Callout>}
          {scanner.error && <Callout tone="error" role="alert">{scanner.error}</Callout>}
          {addError && !scanner.error && <Callout tone="error" role="alert">{addError}</Callout>}
          <AppBackendPanel
            active={active}
            prefill={prefill}
            untitled
            accountRows={connected ? <AccountComputerRows computers={computers} loaded={devices !== undefined} app={app} route={route} onOpenSessions={onOpenSessions} onRenamed={refreshComputers} /> : null}
            onOpenInUse={onOpenSessions}
            controlRef={panel}
            onScanQr={scan}
          />
          <AccountSection active={active} devices={devices} onOpen={() => setAccountOpen(true)} />
          {connected && isPhoneCloudShell() && <ConnectionDiagnosticsRow />}
        </div>
      </PullToRefresh>
      <AccountSheet open={accountOpen} onClose={closeAccount} note={pendingAdd ? ADD_AFTER_SIGN_IN : null} />
      {addComputer && <AddScannedSheet link={addComputer} onClose={() => setAddComputer(null)} />}
      {scanner.scanning && <QrScanOverlay onCancel={() => { void cancelQrScan() }} />}
    </div>
  )
}
