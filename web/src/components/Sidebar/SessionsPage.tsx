/**
 * The phone's Sessions screen around the session list (``Sidebar`` with
 * ``page``): a 44px top bar, a large title with a search field that scroll
 * with the list, and a bottom toolbar. The list itself (Pinned, Needs you,
 * the workspaces) is the sidebar's own. It is the middle level of the
 * phone's stack: ‹ Servers goes down to the Servers screen.
 */
import type { Ref } from 'react'
import { Activity, Clock, Search, Settings, SquarePen, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HealthDot } from '@/components/HealthDot'
import { PhoneBackButton } from '@/components/phone/PhoneNavBar'
import { NEXT_THEME, THEME_OPTIONS } from '@/components/theme-options'
import { useThemePreference } from '@/hooks/useThemePreference'
import { apiBaseUrl } from '@/api/base-url'
import { formatBackendConnectionLabel } from '@/lib/app-backend'
import { cn } from '@/lib/utils'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'

/**
 * The top bar: ‹ Servers on the left (the server chip when there is no
 * Servers screen to go back to), ✎ New session on the right, and a small
 * centred title that fades in once the large one has scrolled away
 * (``data-title-visible``, written by ``useLargeTitleCollapse``). The title
 * has its own column, like ``PhoneNavBar``'s, so a long label truncates
 * instead of running under it.
 */
export function SessionsPageBar({
  barRef,
  onNewSession,
  onOpenServers,
}: {
  barRef: Ref<HTMLElement>
  onNewSession: () => void
  onOpenServers?: () => void
}) {
  return (
    <header
      ref={barRef}
      data-sessions-page-bar=""
      className={cn(
        'group/bar mobile-safe-header grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-transparent pr-2 transition-colors duration-(--motion-fast) data-title-visible:border-(--color-border)',
        onOpenServers ? 'pl-2' : 'pl-3',
      )}
    >
      <div className="flex min-w-0 justify-start">
        {onOpenServers ? <PhoneBackButton label="Servers" onBack={onOpenServers} /> : <HealthDot labeled chip />}
      </div>
      {/* The large title is the heading; this one only echoes it. */}
      <span
        aria-hidden="true"
        className="text-base font-semibold text-(--color-text) opacity-0 transition-opacity duration-(--motion-fast) group-data-title-visible/bar:opacity-100"
      >
        Sessions
      </span>
      <div className="flex min-w-0 justify-end">
        <Button type="button" variant="ghost" size="icon" aria-label="New session" onClick={onNewSession} className="relative touch-hit">
          <SquarePen className="size-5" aria-hidden="true" />
        </Button>
      </div>
    </header>
  )
}

/**
 * The server the list belongs to, under the large title: its dot (green
 * connected, red not reachable, grey connecting) and name. With ‹ Servers
 * in the bar instead of the server chip, this keeps the server in sight; a
 * tap goes down to Servers too.
 */
function SessionsServerLine({ onOpenServers }: { onOpenServers: () => void }) {
  const health = useHealthQuery()
  const backendStatus = useBackendStatusQuery()
  const label = formatBackendConnectionLabel(backendStatus.data ?? null, apiBaseUrl())
  // In a browser there is no app shell to report a status, and the Servers
  // screen calls the page's own server "This server"; say the same here.
  const inBrowser = backendStatus.isSuccess && backendStatus.data === null
  const name = inBrowser && label === 'built-in' ? 'This server' : label === 'built-in' ? 'Built-in server' : label
  const state = health.isSuccess ? 'connected' : health.isError ? 'not reachable' : 'connecting…'
  return (
    <button
      type="button"
      onClick={onOpenServers}
      data-sessions-server=""
      aria-label={`${name}, ${state}. Show servers`}
      className="relative touch-hit -mt-0.5 mb-2 flex max-w-full items-center gap-1.5 rounded-sm text-left text-subhead text-(--color-text-muted) transition-opacity active:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          health.isSuccess ? 'bg-(--accent-green-text)' : health.isError ? 'bg-(--color-error)' : 'bg-(--color-text-muted)',
        )}
      />
      <span className="min-w-0 truncate text-(--color-text-2)">{name}</span>
      <span className="shrink-0">· {state}</span>
    </button>
  )
}

/**
 * The large title, the server it lists, and the search field under them, at
 * the top of the scroller. The field only looks like one: a tap opens
 * ``SessionSearch``, which has the real input. It is a plain button, not
 * ``Button``: a search field is 36px (iOS's), under the phone's button floor.
 */
export function SessionsPageHeader({
  titleRef,
  searchRef,
  onSearch,
  onOpenServers,
}: {
  titleRef: Ref<HTMLHeadingElement>
  searchRef: Ref<HTMLButtonElement>
  onSearch: () => void
  onOpenServers?: () => void
}) {
  return (
    <div data-sessions-page-header="" className="px-3 pb-2">
      <h1 ref={titleRef} className="pb-1 pt-0.5 text-large-title font-bold text-(--color-text)">
        Sessions
      </h1>
      {onOpenServers && <SessionsServerLine onOpenServers={onOpenServers} />}
      <button
        ref={searchRef}
        type="button"
        onClick={onSearch}
        className="flex h-9 w-full items-center gap-1.5 rounded-md bg-(--bg-key) px-2.5 text-left text-xs text-(--color-text-muted) transition-colors hover:bg-(--color-fill-key-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
      >
        <Search size={16} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">Search</span>
      </button>
    </div>
  )
}

interface ToolbarItem {
  label: string
  icon: LucideIcon
  onClick: () => void
  /** The accessible name when it says more than the caption. */
  ariaLabel?: string
}

/**
 * The bottom toolbar, an iOS toolbar's: equal buttons, a 20px icon over a
 * caption. It holds what the drawer's footer did (Settings, Usage, the
 * theme) and Scheduled, so each is one tap from the root screen. The theme
 * button shows the current choice and moves to the next on a tap (System →
 * Light → Dark), as the drawer's did. The command palette has no button: it
 * is a keyboard surface, and ⌘K still opens it from a hardware keyboard.
 *
 * Each item is its own grid, not a ``Button``: its height grows with its
 * content (a fixed px height let a Dynamic Type or textZoom label spill out
 * of the box and sit low), the icon and caption are centred as one block,
 * and a press dims it, as iOS does, rather than filling a wide key.
 */
export function SessionsPageToolbar({
  onOpenSettings,
  onOpenScheduler,
  onOpenUsage,
}: {
  onOpenSettings: () => void
  onOpenScheduler: () => void
  onOpenUsage: () => void
}) {
  const { preference, setPreference } = useThemePreference()
  const theme = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0]
  const items: ToolbarItem[] = [
    { label: 'Settings', icon: Settings, onClick: onOpenSettings },
    { label: 'Scheduled', icon: Clock, onClick: onOpenScheduler },
    { label: 'Usage', icon: Activity, onClick: onOpenUsage },
    {
      label: theme.label,
      icon: theme.Icon,
      onClick: () => setPreference(NEXT_THEME[preference]),
      ariaLabel: `Theme: ${theme.label}. Tap for ${THEME_OPTIONS.find((option) => option.value === NEXT_THEME[preference])?.label}.`,
    },
  ]
  return (
    <div
      data-sessions-page-toolbar=""
      className="flex shrink-0 border-t border-(--color-border) bg-(--bg-sidebar) px-1 pb-safe"
    >
      {items.map(({ label, icon: Icon, onClick, ariaLabel }) => (
        <button
          key={label}
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          data-sessions-toolbar-item=""
          // One full-width column (so a long caption truncates), its rows
          // centred as a block in the 49px band.
          className="grid min-h-[49px] min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-center justify-items-center gap-0.5 rounded-md py-1 text-(--color-text-muted) transition-opacity select-none active:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
        >
          <Icon className="size-5 shrink-0" aria-hidden="true" />
          <span className="max-w-full truncate text-meta leading-tight">{label}</span>
        </button>
      ))}
    </div>
  )
}
