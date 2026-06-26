import { QueryClientProvider } from '@tanstack/react-query'
import { Suspense, useEffect } from 'react'
// Temporarily disabled for clean recordings — re-enable when done.
// import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { Home } from 'lucide-react'
import { ToastStack } from '@/components/ToastStack'
import { SettingsModal } from '@/components/SettingsModal'
import { SkipLink } from '@/components/motion'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { MacTitleBar } from '@/components/MacTitleBar'
import { useHistorySwipeNavigation } from '@/hooks/use-history-swipe-navigation'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { useDesktopCommands } from '@/lib/desktop-commands'
import { closestRestorableRoute } from '@/lib/route-restore'

export function Root() {
  useMobileViewportGuards()
  useDesktopCommands()
  useHistorySwipeNavigation()

  // Global Ctrl+. shortcut — opens/toggles the Settings modal from any page.
  const openSettings = useSettingsStore((s) => s.openSettings)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const settingsOpen = useSettingsStore((s) => s.open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && e.key === '.') {
        e.preventDefault()
        if (settingsOpen) closeSettings()
        else openSettings()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [settingsOpen, openSettings, closeSettings])
  // Theme application is handled by `initTheme()` in main.tsx and the
  // inline pre-paint script in index.html. Do not force `.dark` here —
  // it would override the user's preference.
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const target = window as Window & { __OAD_INITIAL_ROUTE__?: string }
    const initialRoute = target.__OAD_INITIAL_ROUTE__
    if (initialRoute) {
      delete target.__OAD_INITIAL_ROUTE__
      navigate({ to: initialRoute, replace: true })
      return
    }

    const LAST_ROUTE_KEY = 'oa-last-route'
    if (window.location.pathname === '/' && window.location.search === '') {
      const savedRoute = localStorage.getItem(LAST_ROUTE_KEY)
      if (savedRoute && savedRoute !== '/') {
        navigate({ to: closestRestorableRoute(savedRoute), replace: true })
      }
    }
  }, [navigate])

  useEffect(() => {
    const LAST_ROUTE_KEY = 'oa-last-route'
    const fullPath = window.location.pathname + window.location.search + window.location.hash
    localStorage.setItem(LAST_ROUTE_KEY, fullPath)
  }, [location])

  return (
    <QueryClientProvider client={queryClient}>
      <SkipLink />
      <MacTitleBar />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
      <ToastStack />
      {/* <ReactQueryDevtools initialIsOpen={false} /> */}
    </QueryClientProvider>
  )
}

function RouteLoadingFallback() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <img src="/openagentd-app-icon.png" width={88} height={88} alt="" aria-hidden="true" className="rounded-2xl" />
    </div>
  )
}

export function NotFound() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh flex-col items-center justify-center gap-6 bg-(--bg-page)">
      <div className="text-center">
        <p className="font-mono text-6xl font-bold text-(--color-text-muted)">404</p>
        <p className="mt-3 text-sm text-(--color-text-muted)">Page not found</p>
      </div>
      <Link
        to="/"
        className="interactive-weight flex items-center gap-2 rounded-lg bg-(--bg-key) px-4 py-2 text-sm text-(--color-accent) ring-1 ring-(--color-border-strong) transition-colors hover:bg-(--bg-key)"
      >
        <Home size={14} />
        Go home
      </Link>
    </div>
  )
}
