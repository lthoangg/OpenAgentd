import { Suspense } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { UpdateCard } from './components/UpdateCard'
import { useAppBackendBootstrap } from './hooks/use-app-backend-bootstrap'
import { router } from './router'

function App() {
  const backendReady = useAppBackendBootstrap()

  if (!backendReady) return <AppLoadingScreen />

  return (
    <Suspense fallback={<AppLoadingScreen />}>
      <RouterProvider router={router} />
      <UpdateCard />
    </Suspense>
  )
}

function AppLoadingScreen() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page) text-(--color-text-muted)" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-full border border-(--color-border) bg-(--bg-card) px-4 py-3 text-sm shadow-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-(--color-accent) motion-reduce:animate-none" />
        Loading OpenAgentd...
      </div>
    </div>
  )
}

export default App
