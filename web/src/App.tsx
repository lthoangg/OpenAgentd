import { Suspense } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'
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
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <img src={OpenAgentdAppIcon} width={88} height={88} alt="" aria-hidden="true" className="rounded-2xl" />
    </div>
  )
}

export default App
