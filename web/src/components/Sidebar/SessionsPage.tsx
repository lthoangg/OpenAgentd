/**
 * The phone's Sessions screen around the session list (``Sidebar`` with
 * ``page``): a 44px top bar, a large title with a search field that scroll
 * with the list, and a bottom toolbar. The list itself (Pinned, Needs you,
 * the workspaces) is the sidebar's own.
 */
import type { Ref } from 'react'
import { Activity, Clock, Command, Search, Settings, SquarePen, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HealthDot } from '@/components/HealthDot'

/**
 * The top bar: the server on the left, ✎ New session on the right, and a
 * small centred title that fades in once the large one has scrolled away
 * (``data-title-visible``, written by ``useLargeTitleCollapse``). The title
 * has its own column, like ``PhoneNavBar``'s, so a long server name
 * truncates instead of running under it.
 */
export function SessionsPageBar({ barRef, onNewSession }: { barRef: Ref<HTMLElement>; onNewSession: () => void }) {
  return (
    <header
      ref={barRef}
      data-sessions-page-bar=""
      className="group/bar mobile-safe-header grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-transparent pl-3 pr-2 transition-colors duration-(--motion-fast) data-title-visible:border-(--color-border)"
    >
      <div className="flex min-w-0 justify-start">
        <HealthDot labeled chip />
      </div>
      {/* The large title is the heading; this one only echoes it. */}
      <span
        aria-hidden="true"
        className="text-base font-semibold text-(--color-text) opacity-0 transition-opacity duration-(--motion-fast) group-data-title-visible/bar:opacity-100"
      >
        Sessions
      </span>
      <div className="flex min-w-0 justify-end">
        <Button type="button" variant="ghost" size="icon" aria-label="New session" onClick={onNewSession}>
          <SquarePen className="size-5" aria-hidden="true" />
        </Button>
      </div>
    </header>
  )
}

/**
 * The large title and the search field under it, at the top of the scroller.
 * The field only looks like one: a tap opens ``SessionSearch``, which has the
 * real input. It is a plain button, not ``Button``: a search field is 36px
 * (iOS's), and every ``Button`` has the phone's 44px floor.
 */
export function SessionsPageHeader({
  titleRef,
  searchRef,
  onSearch,
}: {
  titleRef: Ref<HTMLHeadingElement>
  searchRef: Ref<HTMLButtonElement>
  onSearch: () => void
}) {
  return (
    <div data-sessions-page-header="" className="px-3 pb-2">
      <h1 ref={titleRef} className="pb-1 pt-0.5 text-large-title font-bold text-(--color-text)">
        Sessions
      </h1>
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
}

/**
 * The bottom toolbar, an iOS toolbar's: equal buttons, a 20px icon over a
 * caption. It holds what the drawer's footer did (Settings, Usage, the
 * command palette) and Scheduled, so each is one tap from the root screen.
 * Commands is left out when nothing opens the palette.
 */
export function SessionsPageToolbar({
  onOpenSettings,
  onOpenScheduler,
  onOpenUsage,
  onOpenPalette,
}: {
  onOpenSettings: () => void
  onOpenScheduler: () => void
  onOpenUsage: () => void
  onOpenPalette?: () => void
}) {
  const items: ToolbarItem[] = [
    { label: 'Settings', icon: Settings, onClick: onOpenSettings },
    { label: 'Scheduled', icon: Clock, onClick: onOpenScheduler },
    { label: 'Usage', icon: Activity, onClick: onOpenUsage },
    ...(onOpenPalette ? [{ label: 'Commands', icon: Command, onClick: onOpenPalette }] : []),
  ]
  return (
    <div
      data-sessions-page-toolbar=""
      className="flex shrink-0 border-t border-(--color-border) bg-(--bg-sidebar) px-1 pb-safe"
    >
      {items.map(({ label, icon: Icon, onClick }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          // ``size="icon"`` brings no padding and no text size, so the 49px
          // height and the column are the only things set here.
          className="h-[49px] min-w-0 flex-1 flex-col"
        >
          <Icon className="size-5" aria-hidden="true" />
          <span className="max-w-full truncate text-meta">{label}</span>
        </Button>
      ))}
    </div>
  )
}
