import { Suspense, useEffect, useState } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { Seal } from '@/components/brand/Logo'
import { AppBackendDialog, type AppBackendPrefill } from '@/components/AppBackendDialog'
import { BackendSwitchMessage, BackendSwitchScreen } from '@/components/BackendSwitchScreen'
import { Button } from '@/components/ui/button'
import { useConnectLink } from '@/hooks/useConnectLink'
import { useDynamicType } from '@/hooks/use-dynamic-type'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { getBundledBackendLogPath } from '@/lib/app-backend'
import { clearBackendSwitchHandoff, pendingBackendSwitch, type BackendSwitchTarget } from '@/stores/useBackendSwitchStore'
import { useAppBackendBootstrap } from './hooks/use-app-backend-bootstrap'
import { router } from './router'

function App() {
  // Mounted here, not in the root route, so the loading screen and the
  // first-run server dialog already get the mobile shell's viewport guards
  // (fixed layout, keyboard tracking) and the iOS text size.
  useMobileViewportGuards()
  useDynamicType()
  const { ready, unavailable, failed, retrying, retry } = useAppBackendBootstrap()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)
  // A server switch reloaded the window: the startup screen keeps saying
  // where it is going, and forgets once the new server is up.
  const [switchingTo] = useState(pendingBackendSwitch)
  useEffect(() => {
    if (ready) clearBackendSwitchHandoff()
  }, [ready])
  // A scanned `openagentd://connect` link opens the dialog prefilled, in
  // the loading screen (no server yet) and in the running app alike.
  const { request: connectRequest, clear: clearConnectRequest } = useConnectLink()
  const onBackendDialogOpenChange = (open: boolean) => {
    setBackendDialogOpen(open)
    if (!open) clearConnectRequest()
  }

  if (!ready) {
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
      <AppBackendDialog open={connectRequest !== null} onOpenChange={onBackendDialogOpenChange} prefill={connectRequest} />
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
            <Button variant="ghost" size="sm" className="mt-1 text-xs text-(--color-text-subtle)" onClick={onChooseServer}>
              Choose Server
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
