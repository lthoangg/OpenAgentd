import { Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'
import type { AppBackendPrefill } from '@/components/AppBackendDialog'
import { AppBackendDialog } from '@/components/LazyAppBackendDialog'
import { BackendSwitchMessage, BackendSwitchScreen } from '@/components/BackendSwitchScreen'
import { PreviewKeepAlive } from '@/components/Preview/PreviewKeepAlive'
import { ServersScreen } from '@/components/phone/LazyServersScreen'
import { Button } from '@/components/ui/button'
import { useConnectLink } from '@/hooks/useConnectLink'
import { useDynamicType } from '@/hooks/use-dynamic-type'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { getAppBackendStatus, getBundledBackendLogPath } from '@/lib/app-backend'
import { clearBackendSwitchHandoff, pendingBackendSwitch, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'
import { openServersScreen } from '@/stores/useServersScreenStore'
import { useAppBackendBootstrap } from './hooks/use-app-backend-bootstrap'
import { router } from './router'

/**
 * A phone with a server saved shows the logo while it connects (a cold start
 * can spend seconds reading the access key); only one that is still not
 * connected after this long shows Servers. No server at all shows it at once.
 */
const PHONE_SERVERS_AFTER_MS = 10_000

function App() {
  // Mounted here, not in the root route, so the loading screen and the
  // first-run server dialog already get the mobile shell's viewport guards
  // (fixed layout, keyboard tracking) and the iOS text size.
  useMobileViewportGuards()
  useDynamicType()
  const { ready, unavailable, failed, retrying, retry } = useAppBackendBootstrap()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)
  const isPhone = useIsPhone()
  // A phone has one server picker, its Servers screen: shown in place of the
  // loading logo once connecting takes a moment, or at once for a link.
  const [phoneServers, setPhoneServers] = useState(false)
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
  const [switchingTo] = useState(pendingBackendSwitch)
  // A layout effect: it runs in the same commit that mounts the router, so
  // nothing that sees the app running can still find the hand-off (a passive
  // effect could land a tick later on a busy main thread).
  useLayoutEffect(() => {
    if (ready) clearBackendSwitchHandoff()
  }, [ready])
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

  if (!ready) {
    if (isPhone) {
      return (
        <>
          {phoneServers ? (
            <div className="mobile-safe-shell mobile-viewport h-dvh">
              <ServersScreen active onOpenSessions={() => {}} />
            </div>
          ) : (
            <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd">
              <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
            </div>
          )}
          <BackendSwitchScreen />
        </>
      )
    }
    return (
      <>
        <AppLoadingScreen switchingTo={switchingTo} unavailable={unavailable} failed={failed} retrying={retrying} onRetry={retry} onChooseServer={() => setBackendDialogOpen(true)} backendDialogOpen={backendDialogOpen || connectRequest !== null} onBackendDialogOpenChange={onBackendDialogOpenChange} backendPrefill={connectRequest} />
        <BackendSwitchScreen />
      </>
    )
  }

  return (
    <>
      <Suspense fallback={<AppLoadingScreen switchingTo={switchingTo} unavailable={false} failed={false} retrying={false} onRetry={() => {}} onChooseServer={() => {}} backendDialogOpen={false} onBackendDialogOpenChange={() => {}} />}>
        <RouterProvider router={router} />
      </Suspense>
      {!isPhone && <AppBackendDialog open={connectRequest !== null} onOpenChange={onBackendDialogOpenChange} prefill={connectRequest} />}
      {/* Keeps pages the agent opened driveable while no Preview tab shows them. */}
      <PreviewKeepAlive />
      <BackendSwitchScreen />
    </>
  )
}

function AppLoadingScreen({ switchingTo = null, unavailable, failed, retrying, onRetry, onChooseServer, backendDialogOpen, onBackendDialogOpenChange, backendPrefill = null }: {
  /** The server a switch reloaded this window onto. */
  switchingTo?: BackendSwitchTarget | null
  unavailable: boolean
  failed: boolean
  retrying: boolean
  onRetry: () => void
  onChooseServer: () => void
  backendDialogOpen: boolean
  onBackendDialogOpenChange: (open: boolean) => void
  backendPrefill?: AppBackendPrefill | null
}) {
  const [logCopyState, setLogCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [backendLogPath, setBackendLogPath] = useState<string | null>(null)
  const copyBackendLogPath = async () => {
    const path = await getBundledBackendLogPath()
    setBackendLogPath(path)
    if (!path) {
      setLogCopyState('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(path)
      setLogCopyState('copied')
    } catch {
      setLogCopyState('failed')
    }
  }

  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <div className="flex max-w-sm flex-col items-center gap-5 px-6 text-center">
        <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
        {!unavailable ? (
          <div className="flex flex-col items-center gap-2">
            {switchingTo
              ? <BackendSwitchMessage target={switchingTo} />
              : <p role="status" className="text-sm font-medium text-(--color-text-muted)">Connecting to OpenAgentd…</p>}
            <Button variant="subtle" size="sm" className="mt-1" onClick={onChooseServer}>
              Choose server
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-(--color-text-muted)">{failed ? "OpenAgentd couldn't start its local server." : 'OpenAgentd is taking longer than usual to start.'}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onRetry} disabled={retrying}>{retrying ? 'Restarting…' : 'Retry'}</Button>
              <Button variant="subtle" onClick={onChooseServer}>Choose server</Button>
              <Button variant="ghost" onClick={() => { void copyBackendLogPath() }}>{logCopyState === 'copied' ? 'Log path copied' : logCopyState === 'failed' ? "Couldn't copy" : 'Copy log path'}</Button>
            </div>
            {logCopyState === 'failed' && backendLogPath && <code className="max-w-full select-text break-all text-xs text-(--color-text-muted)">{backendLogPath}</code>}
          </>
        )}
      </div>
      <AppBackendDialog open={backendDialogOpen} onOpenChange={onBackendDialogOpenChange} prefill={backendPrefill} />
    </div>
  )
}

export default App
