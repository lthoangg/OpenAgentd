/**
 * Settings shell — responsive layout.
 *
 * Desktop (≥768px): three-column
 *   ┌──┬──────────────┬─────────────────────────────┐
 *   │  │              │                             │
 *   │🔧│  Agents      │   Editor / Detail /         │
 *   │✨│  ─ search ─  │   Empty-state               │
 *   │🔌│  • Coder     │                             │
 *   │🛡│  • Reviewer  │                             │
 *   │  │              │                             │
 *   └──┴──────────────┴─────────────────────────────┘
 *
 * Mobile (<768px): single column — CategoryList fills screen; detail
 * routes render full-screen on top. CategoryRail is hidden (each detail
 * route and the list header provide their own back navigation).
 */
import { Outlet, useLocation } from '@tanstack/react-router'

import { CategoryList } from '@/components/settings/CategoryList'
import { CategoryRail } from '@/components/settings/CategoryRail'
import { useIsMobile } from '@/hooks/use-mobile'

type ListKind = 'agents' | 'skills' | 'mcp'

function detectListKind(pathname: string): ListKind | null {
  if (pathname.startsWith('/settings/agents')) return 'agents'
  if (pathname.startsWith('/settings/skills')) return 'skills'
  if (pathname.startsWith('/settings/mcp')) return 'mcp'
  return null
}

/** Returns true when the pathname points at a detail/editor route (not the list root). */
function isDetailRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/settings/agents/') ||
    pathname.startsWith('/settings/skills/') ||
    pathname.startsWith('/settings/mcp/')   ||
    pathname === '/settings/sandbox'         ||
    pathname === '/settings/dream'           ||
    pathname === '/settings/voice'           ||
    pathname === '/settings'
  )
}

export function SettingsLayout() {
  const { pathname } = useLocation()
  const isMobile = useIsMobile()
  const listKind = detectListKind(pathname)
  const onDetail = isDetailRoute(pathname)

  // Mobile layout: show list OR detail, never side-by-side.
  // The list column fills the screen; when the user taps a row TanStack
  // Router navigates to the detail route and we render only the Outlet.
  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {/* On a list route show the list; on a detail route show the outlet */}
        {onDetail ? (
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <Outlet />
          </main>
        ) : (
          listKind ? (
            <CategoryList kind={listKind} />
          ) : (
            <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <Outlet />
            </main>
          )
        )}
      </div>
    )
  }

  // Desktop layout: three-column
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <CategoryRail />
      {listKind && <CategoryList kind={listKind} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}
