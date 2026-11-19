import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'
import type { AppBackendPrefill } from '@/components/AppBackendDialog'
import { AppBackendDialog } from '@/components/LazyAppBackendDialog'
import { BackendSwitchBack, BackendSwitchMessage, BackendSwitchScreen } from '@/components/BackendSwitchScreen'
import { PreviewKeepAlive } from '@/components/Preview/PreviewKeepAlive'
import { ServersScreen } from '@/components/phone/LazyServersScreen'
import { Button } from '@/components/ui/button'
import { useConnectLink } from '@/hooks/useConnectLink'
import { useDynamicType } from '@/hooks/use-dynamic-type'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { isMobileApp } from '@/lib/mobile-app'
import { getAppBackendStatus, getBundledBackendLogPath } from '@/lib/app-backend'
import { WEB_BUILD_VERSION } from '@/lib/app-version'
import { isDesktopShell } from '@/lib/desktop-shell'
import { useBackHandler } from '@/lib/back-button'
import { clearBackendSwitchHandoff, endLandedBackendSwitch, pendingBackendSwitch, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'
import { openServersScreen } from '@/stores/useServersScreenStore'
import { useAppBackendBootstrap } from './hooks/use-app-backend-bootstrap'
import { router } from './router'

/**
 * A phone with a saved server is ready as soon as the shell reports it: an
 * external server has nothing to start, so the logo shows only for that
 * answer and the access key read (the router and its own connection banner
 * take over from there; the server answering is not waited for). A phone
 * that is still not ready after this long (the shell or the key store not
 * answering) shows Servers instead of the logo. No saved server at all, or a
 * scanned connect link, shows it at once.
 */
const PHONE_SERVERS_AFTER_MS = 10_000

// The phone's account sync (a tapped "A device wants to join" opens the
// approval sheet). Mounted here, once, under both the loading screens and
// the running app: a phone with no server can still approve, and the sheet
// a tap opened stays open while the app starts under it.
const PhoneCloudSync = lazy(() =>
  import('@/hooks/use-phone-cloud-sync').then((module) => ({ default: module.PhoneCloudSync })),
)

function App() {
  // Mounted here, not in the root route, so the loading screen and the
  // first-run server dialog already get the mobile shell's viewport guards
  // (fixed layout, keyboard tracking) and the iOS text size.
  useMobileViewportGuards()
  useDynamicType()
  const { ready, unavailable, failed, failureMessage, retrying, retry } = useAppBackendBootstrap()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)
  const isPhone = useIsPhone()
  // A phone has one server picker, its Servers screen: shown in place of the
  // loading logo once connecting takes a moment, or at once for a link.
  const [phoneServers, setPhoneServers] = useState(false)
  // The phone and its account computers (`lib/account-route`): at launch
  // the computer last opened is opened again through its link; the shell
  // is told (`cloud_poke`) when the app comes back (also when this page
  // starts), goes away, or the network changes, and once when health fails
  // on an account computer. A failed launch attempt shows Servers.
  useEffect(() => {
    if (!isMobileApp()) return
    let cancelled = false
    let stop: (() => void) | undefined
    void import('@/lib/account-route')
      .then((module) => {
        if (cancelled) return 'skipped' as const
        stop = module.startAccountRouteWatch()
        return module.checkRouteAtLaunch()
      })
      .then((outcome) => { if (outcome === 'failed') setPhoneServers(true) })
      .catch(() => {})
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  // Desktop: the built-in server's links to other computers check
  // themselves when a window comes back or the network changes.
  useEffect(() => {
    if (!isDesktopShell()) return
    let cancelled = false
    let stop: (() => void) | undefined
    void import('@/lib/account-route')
      .then((module) => { if (!cancelled) stop = module.startDesktopLinkPokes() })
      .catch(() => {})
    return () => {
      cancelled = true
      stop?.()
    }
  }, [])
  useEffect(() => {
    if (!isPhone || ready) return
    let cancelled = false
    void getAppBackendStatus().then((status) => {
      if (!cancelled && !status?.base_url) setPhoneServers(true)
    }).catch(() => {})
    const timer = setTimeout(() => setPhoneServers(true), PHONE_SERVERS_AFTER_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [isPhone, ready])
  // A server switch reloaded the window: the startup screen keeps saying
  // where it is going, and forgets once the new server is up.
  const [switchingTo, setSwitchingTo] = useState(pendingBackendSwitch)
  // A layout effect: it runs in the same commit that mounts the router, so
  // nothing that sees the app running can still find the hand-off (a passive
  // effect could land a tick later on a busy main thread).
  useLayoutEffect(() => {
    if (!ready) return
    clearBackendSwitchHandoff()
    // A switch that started the app on this page: its screen goes now.
    endLandedBackendSwitch()
  }, [ready])
  // Back on that screen, so a server that never comes up does not trap the
  // person: forget the switch, and on a phone show its Computers list; else
  // switch back to the server the window came from (the server chooser when
  // that is unknown or fails too).
  const backFromSwitch = () => {
    const from = switchingTo?.from
    clearBackendSwitchHandoff()
    setSwitchingTo(null)
    if (isPhone) {
      setPhoneServers(true)
      return
    }
    void import('@/lib/backend-switch')
      .then((module) => module.returnFromBackendSwitch(from))
      .then((outcome) => { if (outcome === 'failed') setBackendDialogOpen(true) })
      .catch(() => setBackendDialogOpen(true))
  }
  const handoffBack = !ready && switchingTo !== null && !(isPhone && phoneServers)
  useBackHandler(handoffBack, backFromSwitch)
  // A scanned `openagentd://connect` link opens the dialog prefilled, in
  // the loading screen (no server yet) and in the running app alike.
  const { request: connectRequest, clear: clearConnectRequest } = useConnectLink()
  const onBackendDialogOpenChange = (open: boolean) => {
    setBackendDialogOpen(open)
    if (!open) clearConnectRequest()
  }
  useEffect(() => {
    if (!isPhone || !connectRequest) return
    openServersScreen(connectRequest)
    clearConnectRequest()
    if (!ready) setPhoneServers(true)
  }, [isPhone, connectRequest, clearConnectRequest, ready])

  let screen: ReactNode
  if (ready) {
    screen = (
      <>
        <Suspense fallback={<AppLoadingScreen switchingTo={switchingTo} unavailable={false} failed={false} retrying={false} onRetry={() => {}} onChooseServer={() => {}} backendDialogOpen={false} onBackendDialogOpenChange={() => {}} />}>
          <RouterProvider router={router} />
        </Suspense>
        {!isPhone && <AppBackendDialog open={connectRequest !== null} onOpenChange={onBackendDialogOpenChange} prefill={connectRequest} />}
        {/* Keeps pages the agent opened driveable while no Preview tab shows them. */}
        <PreviewKeepAlive />
      </>
    )
  } else if (!isPhone) {
    screen = <AppLoadingScreen switchingTo={switchingTo} onSwitchBack={backFromSwitch} unavailable={unavailable} failed={failed} failureMessage={failureMessage} retrying={retrying} onRetry={retry} onChooseServer={() => setBackendDialogOpen(true)} backendDialogOpen={backendDialogOpen || connectRequest !== null} onBackendDialogOpenChange={onBackendDialogOpenChange} backendPrefill={connectRequest} />
  } else if (phoneServers) {
    screen = (
      <div className="mobile-safe-shell mobile-viewport h-dvh">
        <ServersScreen active />
      </div>
    )
  } else {
    screen = (
      <div className="mobile-safe-shell mobile-viewport relative flex h-dvh items-center justify-center bg-(--bg-page)">
        {switchingTo && <BackendSwitchBack placement="bar" onBack={backFromSwitch} />}
        <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center" role="status" aria-label="Loading OpenAgentd">
          <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
          {switchingTo && <BackendSwitchMessage target={switchingTo} />}
        </div>
      </div>
    )
  }

  // One tree for every state: what sits after the screen keeps its place,
  // and so its state, when the app starts.
  return (
    <>
      {screen}
      <BackendSwitchScreen />
      {isMobileApp() && (
        <Suspense fallback={null}>
          <PhoneCloudSync />
        </Suspense>
      )}
    </>
  )
}

/** What the recovery screen says, by whether start-up failed or is only slow. */
const STARTUP_FAILED = "OpenAgentd couldn't start on this computer."
const STARTUP_SLOW = 'OpenAgentd is taking longer than usual to start.'

function AppLoadingScreen({ switchingTo = null, onSwitchBack, unavailable, failed, failureMessage = null, retrying, onRetry, onChooseServer, backendDialogOpen, onBackendDialogOpenChange, backendPrefill = null }: {
  /** The server a switch reloaded this window onto. */
  switchingTo?: BackendSwitchTarget | null
  /** Back on "Switching to …": return to the server the window came from. */
  onSwitchBack?: () => void
  unavailable: boolean
  failed: boolean
  /** The shell's own error, for Copy details only. */
  failureMessage?: string | null
  retrying: boolean
  onRetry: () => void
  onChooseServer: () => void
  backendDialogOpen: boolean
  onBackendDialogOpenChange: (open: boolean) => void
  backendPrefill?: AppBackendPrefill | null
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Shown only when the clipboard refuses, so the details can be selected.
  const [details, setDetails] = useState<string | null>(null)
  /** What a bug report needs: what failed, the shell's error, where the log is. */
  const copyDetails = async () => {
    const logPath = await getBundledBackendLogPath()
    const text = [
      failed ? STARTUP_FAILED : STARTUP_SLOW,
      failureMessage ? `Error: ${failureMessage}` : null,
      WEB_BUILD_VERSION ? `Version: ${WEB_BUILD_VERSION}` : null,
      logPath ? `Log: ${logPath}` : null,
    ].filter(Boolean).join('\n')
    setDetails(text)
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }
  // Another computer is the rare road on a first launch: a link, not a button.
  const useAnotherComputer = (
    <Button variant="link" size="sm" onClick={onChooseServer}>Use another computer</Button>
  )

  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
        <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
        {!unavailable ? (
          <div className="flex flex-col items-center gap-2">
            {switchingTo
              ? <BackendSwitchMessage target={switchingTo} />
              : <p role="status" className="text-sm font-medium text-(--color-text-muted)">Starting OpenAgentd…</p>}
            {switchingTo && onSwitchBack
              ? <div className="flex flex-wrap justify-center gap-2"><BackendSwitchBack placement="inline" onBack={onSwitchBack} />{useAnotherComputer}</div>
              : useAnotherComputer}
          </div>
        ) : (
          <>
            <p className="text-sm text-(--color-text-muted)">{failed ? STARTUP_FAILED : STARTUP_SLOW}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onRetry} disabled={retrying}>{retrying ? 'Restarting…' : 'Retry'}</Button>
              <Button variant="subtle" onClick={() => { void copyDetails() }}>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy" : 'Copy details'}</Button>
            </div>
            {useAnotherComputer}
            {copyState === 'failed' && details && <code className="max-w-full select-text whitespace-pre-wrap break-all text-left text-xs text-(--color-text-muted)">{details}</code>}
          </>
        )}
      </div>
      <AppBackendDialog open={backendDialogOpen} onOpenChange={onBackendDialogOpenChange} prefill={backendPrefill} />
    </div>
  )
}

export default App
