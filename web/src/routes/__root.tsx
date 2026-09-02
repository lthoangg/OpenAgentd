import { QueryClientProvider } from '@tanstack/react-query'
import { useHotkey } from '@tanstack/react-hotkeys'
import { Suspense, useEffect, useRef } from 'react'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { OPENAGENTD_APP_ICON } from '@/lib/brand-assets'
import { Home } from 'lucide-react'
import { ToastStack } from '@/components/ToastStack'
import { SettingsModal } from '@/components/SettingsModal'
import { SkipLink } from '@/components/motion'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { MacTitleBar } from '@/components/MacTitleBar'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { useDesktopCommands } from '@/lib/desktop-commands'
import { closestRestorableRoute, LAST_ROUTE_KEY, lastRouteStorageKey } from '@/lib/route-restore'
import { getPlatform } from '@/hooks/use-platform'
import { useContainerSelectAll } from '@/hooks/useContainerSelectAll'
import { usePreventBackspaceNavigation } from '@/hooks/usePreventBackspaceNavigation'
import { usePreventStrayFileDrop } from '@/hooks/usePreventStrayFileDrop'
import { useHistoryBackForwardShortcuts } from '@/hooks/useHistoryBackForwardShortcuts'
import { useDeepLinkRouter } from '@/hooks/useDeepLinkRouter'
import { GlobalEventStream } from '@/hooks/use-global-event-stream'
import { LspInstallPrompt } from '@/components/LspInstallPrompt'

export function Root() {
  useMobileViewportGuards()
  useDesktopCommands()
  useContainerSelectAll()
  usePreventBackspaceNavigation()
  usePreventStrayFileDrop()
  useHistoryBackForwardShortcuts()
  useDeepLinkRouter()

  // Global ⌘, / Ctrl+, shortcut — opens/toggles the Settings modal from any page.
  const openSettings = useSettingsStore((s) => s.openSettings)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const settingsOpen = useSettingsStore((s) => s.open)
  const settingsOpenRef = useRef(settingsOpen)
  useEffect(() => { settingsOpenRef.current = settingsOpen }, [settingsOpen])
  const { os } = getPlatform()
  useHotkey(
    'Mod+,',
    () => {
      if (settingsOpenRef.current) closeSettings()
      else openSettings()
    },
    {
      target: document,
      platform: os === 'macos' ? 'mac' : os === 'windows' ? 'windows' : 'linux',
      preventDefault: true,
      stopPropagation: false,
      ignoreInputs: false,
      meta: { name: 'Settings', description: 'Toggle settings' },
    },
  )
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
      navigate({ to: closestRestorableRoute(initialRoute), replace: true })
      return
    }

    const storageKey = lastRouteStorageKey()
    const savedRoute = localStorage.getItem(storageKey) ?? localStorage.getItem(LAST_ROUTE_KEY)

    if (window.location.pathname === '/index.html') {
      if (savedRoute && savedRoute !== '/' && savedRoute !== '/index.html') {
        navigate({ to: closestRestorableRoute(savedRoute), replace: true })
        return
      }
      navigate({ to: closestRestorableRoute(window.location.pathname + window.location.search + window.location.hash), replace: true })
      return
    }
    if (window.location.pathname === '/') {
      if (savedRoute && savedRoute !== '/' && savedRoute !== '/index.html') {
        navigate({ to: closestRestorableRoute(savedRoute), replace: true })
      }
    }
  }, [navigate])

  useEffect(() => {
    const fullPath = window.location.pathname + window.location.search + window.location.hash
    const pathname = window.location.pathname
    // Root is never saved, so a reload from the hub always lands on the last
    // content route rather than the hub. That is the intended trade: users
    // reload to recover a session far more often than to reach the hub, which
    // is one click away from anywhere.
    if (pathname !== '/' && pathname !== '/index.html') {
      localStorage.setItem(lastRouteStorageKey(), fullPath)
    }
  }, [location])

  return (
    <QueryClientProvider client={queryClient}>
      <GlobalEventStream />
      <SkipLink />
      <MacTitleBar />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
      <LspInstallPrompt />
      <ToastStack />
    </QueryClientProvider>
  )
}

function RouteLoadingFallback() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative flex items-center justify-center">
          <div className="absolute -inset-2.5 rounded-3xl bg-(--bg-key)/50 blur-xl animate-pulse" />
          <img src={OPENAGENTD_APP_ICON} width={88} height={88} alt="OpenAgentd" className="relative rounded-2xl shadow-sm" />
        </div>
        <p className="text-sm font-medium text-(--color-text-muted) animate-pulse">Loading OpenAgentd…</p>
      </div>
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
        className="interactive-weight flex items-center gap-2 rounded-sm border border-(--color-border-strong) bg-(--bg-key) px-4 py-2 text-sm text-(--color-accent) transition-colors hover:bg-(--bg-key)"
      >
        <Home size={14} />
        Go home
      </Link>
    </div>
  )
}
