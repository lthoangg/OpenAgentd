import { Suspense, useEffect, useState } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'
import { AppBackendDialog } from '@/components/AppBackendDialog'
import { Button } from '@/components/ui/button'
import { getBundledBackendLogPath } from '@/lib/app-backend'
import { UpdateCard } from './components/UpdateCard'
import { useAppBackendBootstrap } from './hooks/use-app-backend-bootstrap'
import { router } from './router'
import { queryClient } from '@/lib/query-client'
import { preloadConnectedApp } from '@/lib/connected-app-preload'

function App() {
  const { ready, unavailable, failed, retrying, retry } = useAppBackendBootstrap()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)

  useEffect(() => {
    if (ready) preloadConnectedApp(queryClient)
  }, [ready])

  if (!ready) return <AppLoadingScreen unavailable={unavailable} failed={failed} retrying={retrying} onRetry={retry} onChooseServer={() => setBackendDialogOpen(true)} backendDialogOpen={backendDialogOpen} onBackendDialogOpenChange={setBackendDialogOpen} />

  return (
    <Suspense fallback={<AppLoadingScreen unavailable={false} failed={false} retrying={false} onRetry={() => {}} onChooseServer={() => {}} backendDialogOpen={false} onBackendDialogOpenChange={() => {}} />}>
      <RouterProvider router={router} />
      <UpdateCard />
    </Suspense>
  )
}

function AppLoadingScreen({ unavailable, failed, retrying, onRetry, onChooseServer, backendDialogOpen, onBackendDialogOpenChange }: {
  unavailable: boolean
  failed: boolean
  retrying: boolean
  onRetry: () => void
  onChooseServer: () => void
  backendDialogOpen: boolean
  onBackendDialogOpenChange: (open: boolean) => void
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
        <div className="relative flex items-center justify-center">
          <div className="absolute -inset-2.5 rounded-3xl bg-(--bg-key)/50 blur-xl animate-pulse" />
          <img src={OPENAGENTD_APP_ICON} width={88} height={88} alt="OpenAgentd" className="relative rounded-2xl shadow-sm" />
        </div>
        {!unavailable ? (
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm font-medium text-(--color-text-muted) animate-pulse">Connecting to OpenAgentd…</p>
            <Button variant="ghost" size="sm" className="mt-1 text-xs text-(--color-text-subtle)" onClick={onChooseServer}>
              Choose Server
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-(--color-text-muted)">{failed ? 'OpenAgentd could not start its local backend.' : 'OpenAgentd is taking longer than usual to start.'}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onRetry} disabled={retrying}>{retrying ? 'Restarting…' : 'Retry'}</Button>
              <Button variant="subtle" onClick={onChooseServer}>Choose Server</Button>
              <Button variant="ghost" onClick={() => { void copyBackendLogPath() }}>{logCopyState === 'copied' ? 'Backend Log Path Copied' : logCopyState === 'failed' ? 'Copy Failed' : 'Copy Backend Log Path'}</Button>
            </div>
            {logCopyState === 'failed' && backendLogPath && <code className="max-w-full select-text break-all text-xs text-(--color-text-muted)">{backendLogPath}</code>}
          </>
        )}
      </div>
      <AppBackendDialog open={backendDialogOpen} onOpenChange={onBackendDialogOpenChange} />
    </div>
  )
}

export default App
