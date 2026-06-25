/**
 * Settings shell — responsive two-column layout below a shared header.
 *
 * Desktop (≥768px):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ AppHeader (Home · ☰ · "Settings" · ● local)          │
 *   ├──────────────┬───────────────────────────────────────┤
 *   │ Sidebar      │ Detail / list / editor (Outlet)       │
 *   │ (240 px)     │                                       │
 *   └──────────────┴───────────────────────────────────────┘
 *
 * Mobile (<768px):
 *   ┌──────────────────────────────────────────────────────┐
 *   │ AppHeader (Home · ☰ · "Settings" · ● local)          │
 *   ├──────────────────────────────────────────────────────┤
 *   │ Outlet — full width                                   │
 *   └──────────────────────────────────────────────────────┘
 *
 * The list pages (agents/skills/MCP) render cards inline in the right
 * pane via `SettingsListView`; there is no middle list column.
 */
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

import { AppHeader } from '@/components/AppHeader'
import { SettingsSidebar } from '@/components/settings/SettingsSidebar'
import { useIsMobile } from '@/hooks/use-mobile'

/** Page title shown in the AppHeader based on the current pathname. */
function pageTitleFor(pathname: string): string {
  if (pathname.startsWith('/settings/agents')) return 'Agents'
  if (pathname.startsWith('/settings/skills')) return 'Skills'
  if (pathname.startsWith('/settings/mcp')) return 'MCP servers'
  if (pathname === '/settings/providers') return 'Providers'
  if (pathname === '/settings/multimodal') return 'Multimodal'
  if (pathname === '/settings/sandbox') return 'Sandbox'
  if (pathname === '/settings/title-generation') return 'Title generation'
  if (pathname === '/settings/notifications') return 'Notifications'
  return 'Settings'
}

export function SettingsLayout() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // Mobile-only drawer state for the sidebar. On desktop the sidebar
  // is permanently visible so the hamburger acts as a back-to-settings
  // shortcut (navigates the outlet to /settings).
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const handleToggleSidebar = () => {
    if (isMobile) {
      setMobileSidebarOpen((v) => !v)
    } else {
      navigate({ to: '/settings' })
    }
  }

  return (
    <div className="mobile-safe-shell mobile-viewport flex h-dvh flex-col overflow-hidden bg-(--bg-page) text-(--color-text)">
      <AppHeader
        title={pageTitleFor(pathname)}
        onToggleSidebar={handleToggleSidebar}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop sidebar — always visible. Mobile renders the same
            sidebar inside a slide-over so the hamburger has somewhere
            meaningful to open. */}
        {!isMobile && <SettingsSidebar />}

        {isMobile && mobileSidebarOpen && (
          <>
            <div
              className="mobile-safe-overlay fixed inset-0 z-30 bg-black/40"
              onClick={() => setMobileSidebarOpen(false)}
              aria-hidden="true"
            />
            <div className="mobile-safe-top fixed bottom-0 left-0 z-40 flex">
              <SettingsSidebar />
            </div>
          </>
        )}

        <main id="main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
