import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect } from 'react'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { queryClient } from '@/lib/query-client'
import { TitleTooltipLayer } from '@/components/ui/title-tooltip'
import { RunStatusAnnouncer } from '@/components/RunStatusAnnouncer'
import { Seal } from '@/components/brand/Logo'
import { Home } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { lazySurface, prefetchSurfacesWhenIdle, useSurfaceMounted } from '@/lib/lazy-surface'
import { SkipLink } from '@/components/motion'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'
import { MacTitleBar } from '@/components/MacTitleBar'
import { WindowCaptionButtons } from '@/components/WindowCaptionButtons'
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
import { useNeedsYouBadge } from '@/hooks/use-needs-you-badge'
import { getPlatform } from '@/hooks/use-platform'
import { FloatingNotices } from '@/components/FloatingNotices'
import { AiDataConsent } from '@/components/AiDataConsent'
import { CAPABILITY, useServerCapability } from '@/queries'
import { takeQuietOpenFromRoute } from '@/lib/quiet-open'

// Home-screen widgets exist only in the phone apps; keep their sync out of
// the desktop and browser bundle.
const WidgetSnapshotSync = lazy(() =>
  import('@/hooks/use-widget-snapshot').then((module) => ({ default: module.WidgetSnapshotSync })),
)
// Same for the phone's account: only the phone apps have one.
const PhoneCloudSync = lazy(() =>
  import('@/hooks/use-phone-cloud-sync').then((module) => ({ default: module.PhoneCloudSync })),
)

// Settings and Telemetry stay out of the startup bundle; they load while the
// app is idle after it starts (or when opened first), so they open at once.
const SettingsModal = lazySurface(() => import('@/components/SettingsModal'), 'SettingsModal')
const TelemetryOverlay = lazySurface(() => import('@/components/Telemetry/TelemetryOverlay'), 'TelemetryOverlay')
const PluginNotice = lazySurface(() => import('@/components/settings/pages/settings.plugins'), 'PluginNotice')
// Keyboard shortcuts (⌘/), with the help text for every shortcut: opened on
// demand, never on the first screen.
const KeyboardShortcutsSheet = lazySurface(() => import('@/components/KeyboardShortcutsSheet'), 'KeyboardShortcutsSheet')

function widgetsSupported(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

// Only v3 backends can answer the plugin status request the notice makes.
function PluginNoticeGate() {
  const supported = useServerCapability(CAPABILITY.plugins)
  // A notice, not a screen: it can wait for the idle prefetch.
  const mounted = useSurfaceMounted(false)
  if (!supported || !mounted) return null
  return <PluginNotice />
}

function SettingsSurface() {
  const open = useSettingsStore((s) => s.open)
  return useSurfaceMounted(open) ? <SettingsModal /> : null
}

function ShortcutsSurface() {
  const open = useUIStore((s) => s.shortcutsHelpOpen)
  return useSurfaceMounted(open) ? <KeyboardShortcutsSheet /> : null
}

function TelemetrySurface() {
  const open = useUIStore((s) => s.telemetryOpen)
  return useSurfaceMounted(open) ? <TelemetryOverlay /> : null
}

// The app badge and the tab/window title count follow the user to every
// route, not only the chat layout.
function NeedsYouBadgeSync() {
  useNeedsYouBadge()
  return null
}

export function Root() {
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

  useEffect(() => prefetchSurfacesWhenIdle(), [])

  useEffect(() => {
    const target = window as Window & { __OAD_INITIAL_ROUTE__?: string }
    // A widget's new window marks its session quiet (`?quiet=1`) and opens it without the flag.
    const initialRoute = takeQuietOpenFromRoute(target.__OAD_INITIAL_ROUTE__)
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
      <NeedsYouBadgeSync />
      {widgetsSupported() && (
        <Suspense fallback={null}>
          <WidgetSnapshotSync />
        </Suspense>
      )}
      {widgetsSupported() && (
        <Suspense fallback={null}>
          <PhoneCloudSync />
        </Suspense>
      )}
      <PluginNoticeGate />
      <SkipLink />
      <MacTitleBar />
      <WindowCaptionButtons />
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
      <SettingsSurface />
      <TelemetrySurface />
      <ShortcutsSurface />
      <FloatingNotices />
      <AiDataConsent />
      <TitleTooltipLayer />
      <RunStatusAnnouncer />
    </QueryClientProvider>
  )
}

function RouteLoadingFallback() {
  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh items-center justify-center bg-(--bg-page)" role="status" aria-label="Loading OpenAgentd" aria-live="polite">
      <div className="flex flex-col items-center gap-4 text-center">
        <Seal size={88} pulse title="OpenAgentd" className="text-(--color-text)" />
        <p role="status" className="text-sm font-medium text-(--color-text-muted)">Loading OpenAgentd…</p>
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
        className={buttonVariants({ variant: 'primary', size: 'lg' })}
      >
        <Home size={14} />
        Go home
      </Link>
    </div>
  )
}
