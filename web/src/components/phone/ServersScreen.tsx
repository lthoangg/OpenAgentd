/**
 * ServersScreen — the phone's bottom level: Servers → Sessions → a chat.
 *
 * The saved servers, as Settings → Server lists them (``AppBackendPanel``,
 * so connecting, keys and editing live in one place), under a large
 * "Servers" title that hands over to the bar's small one as it scrolls
 * away. The row in use offers **Sessions ›**, which pushes its session list
 * back over this screen; **Use** on another switches the app to that server
 * (the "Switching to…" screen, then its Sessions).
 *
 * ``active``: the screen is on top, or one swipe away under Sessions. The
 * panel loads the servers and pings them each time it turns true, so a
 * swipe back reveals the real list with fresh states.
 *
 * Pulling the list down reloads it and pings every server again.
 *
 * From the top: the phone's account (`AccountSection`, there before any
 * server answers, so a phone can sign in and approve devices first), the
 * account's computers, then the saved servers. One **Scan QR code** (in
 * the guest's Account card and under Your servers) reads both an account
 * invitation and a server's connect code (`useScanAnyCode`).
 *
 * It is the phone's only server picker: the connection banner, the server
 * chip and a scanned connect link open it (``useServersScreenStore``), and
 * before any server answers the app shows it in place of the loading screen.
 */
import { useEffect, useRef, useState } from 'react'

import { AppBackendPanel, type AppBackendPanelControl, type AppBackendPrefill } from '@/components/AppBackendPanel'
import { AccountComputersSection, useAccountComputers } from '@/components/phone/AccountComputers'
import { AccountSection } from '@/components/phone/AccountSection'
import { AccountSheet } from '@/components/phone/AccountSheet'
import { PullToRefresh } from '@/components/phone/PullToRefresh'
import { QrScanOverlay } from '@/components/phone/QrScanOverlay'
import { useScanAnyCode } from '@/components/phone/useScanAnyCode'
import { Callout } from '@/components/ui/callout'
import { cancelQrScan, canScanQr } from '@/lib/qr-scan'
import { usePhoneCloudStatus } from '@/queries/phone-cloud'
import { useLargeTitleCollapse } from '@/components/Sidebar/useLargeTitleCollapse'
import { takeServersPrefill, useServersScreenStore } from '@/stores/useServersScreenStore'

export function ServersScreen({ active, onOpenSessions }: {
  active: boolean
  /** Back up to the Sessions of the server in use; absent before any server answers. */
  onOpenSessions?: () => void
}) {
  const { barRef, titleRef, onScroll } = useLargeTitleCollapse(false)
  const panel = useRef<AppBackendPanelControl>(null)
  const [accountOpen, setAccountOpen] = useState(false)
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
    onJoining: () => {
      joinedByScan.current = true
      setAccountOpen(true)
    },
  })
  const accountState = usePhoneCloudStatus().data?.state
  useEffect(() => {
    if (!joinedByScan.current) return
    if (accountState === 'connected') {
      joinedByScan.current = false
      setAccountOpen(false)
    } else if (accountState === 'guest') {
      joinedByScan.current = false
    }
  }, [accountState])
  const scan = canScanQr() ? () => { void scanner.scan() } : undefined
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
          Servers
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
            Servers
          </h1>
        </div>
        <div className="space-y-8 px-4 pb-6">
          {scanner.error && <Callout tone="error" role="alert">{scanner.error}</Callout>}
          <AccountSection active={active} devices={devices} onOpen={() => setAccountOpen(true)} onScan={scan} />
          {connected && <AccountComputersSection computers={computers} loaded={devices !== undefined} app={app} route={route} onOpenSessions={onOpenSessions} />}
          <AppBackendPanel active={active} prefill={prefill} sectionTitle="Your servers" onOpenInUse={onOpenSessions} controlRef={panel} onScanQr={scan} />
        </div>
      </PullToRefresh>
      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />
      {scanner.scanning && <QrScanOverlay onCancel={() => { void cancelQrScan() }} />}
    </div>
  )
}
