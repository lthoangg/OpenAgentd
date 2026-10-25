import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect } from 'react'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { Seal } from '@/components/brand/Logo'
import { Home } from 'lucide-react'
import { SettingsModal } from '@/components/SettingsModal'
import { PluginNotice } from '@/components/settings/pages/settings.plugins'
import { TelemetryOverlay } from '@/components/Telemetry/TelemetryOverlay'
import { KeyboardShortcutsSheet } from '@/components/KeyboardShortcutsSheet'
import { SkipLink } from '@/components/motion'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { MacTitleBar } from '@/components/MacTitleBar'
import { useMobileViewportGuards } from '@/hooks/use-mobile-viewport'
import { useDynamicType } from '@/hooks/use-dynamic-type'
import { useDesktopCommands } from '@/lib/desktop-commands'
import { LAST_ROUTE_KEY, lastRouteStorageKey, resolveStartupRoute } from '@/lib/route-restore'
import { isPageReload } from '@/lib/page-reload'
import { useAppShortcut } from '@/lib/keyboard/hooks'
import { useContainerSelectAll } from '@/hooks/useContainerSelectAll'
import { usePreventBackspaceNavigation } from '@/hooks/usePreventBackspaceNavigation'
import { usePreventStrayFileDrop } from '@/hooks/usePreventStrayFileDrop'
import { useHistoryBackForwardShortcuts } from '@/hooks/useHistoryBackForwardShortcuts'
import { useDeepLinkRouter } from '@/hooks/useDeepLinkRouter'
import { GlobalEventStream } from '@/hooks/use-global-event-stream'
import { getPlatform } from '@/hooks/use-platform'
import { FloatingNotices } from '@/components/FloatingNotices'
import { CAPABILITY, useServerCapability } from '@/queries'

// Home-screen widgets exist only in the phone apps; keep their sync out of
// the desktop and browser bundle.
const WidgetSnapshotSync = lazy(() =>
  import('@/hooks/use-widget-snapshot').then((module) => ({ default: module.WidgetSnapshotSync })),
)

function widgetsSupported(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

// Only v3 backends can answer the plugin status request the notice makes.
function PluginNoticeGate() {
  if (!useServerCapability(CAPABILITY.plugins)) return null
  return <PluginNotice />
}

export function Root() {
  useMobileViewportGuards()
  useDynamicType()
  useDesktopCommands()
  useContainerSelectAll()
  usePreventBackspaceNavigation()
  usePreventStrayFileDrop()
  useHistoryBackForwardShortcuts()
  useDeepLinkRouter()

  // Global ⌘, / Ctrl+, — opens Settings from any page, and may replace an
  // open overlay. While Settings is on top its own binding closes it.
  const openSettings = useSettingsStore((s) => s.openSettings)
  useAppShortcut('settings', () => { openSettings() })
  // ⌘/ — the Keyboard Shortcuts sheet, from any page.
  useAppShortcut('shortcutsHelp', () => { useUIStore.getState().toggleShortcutsHelp() })
  // Theme application is handled by `initTheme()` in main.tsx and the
  // inline pre-paint script in index.html. Do not force `.dark` here —
  // it would override the user's preference.
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const target = window as Window & { __OAD_INITIAL_ROUTE__?: string }
    const initialRoute = target.__OAD_INITIAL_ROUTE__
    delete target.__OAD_INITIAL_ROUTE__

    const storageKey = lastRouteStorageKey()
    const savedRoute = localStorage.getItem(storageKey) ?? localStorage.getItem(LAST_ROUTE_KEY)
    const next = resolveStartupRoute({
      initialRoute,
      isReload: isPageReload(),
      pathname: window.location.pathname,
      fullPath: window.location.pathname + window.location.search + window.location.hash,
      savedRoute,
    })
    if (next !== null) navigate({ to: next, replace: true })
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
      {widgetsSupported() && (
        <Suspense fallback={null}>
          <WidgetSnapshotSync />
        </Suspense>
      )}
      <PluginNoticeGate />
      <SkipLink />
      <MacTitleBar />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SettingsModal />
      <TelemetryOverlay />
      <KeyboardShortcutsSheet />
      <FloatingNotices />
    </QueryClientProvider>
  )
}

function RouteLoadingFallback() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-center">
        <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
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
