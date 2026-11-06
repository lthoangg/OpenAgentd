/**
 * ServersScreen — the phone's bottom level: Servers → Sessions → a chat.
 *
 * The saved servers, as Settings → Server lists them (``AppBackendPanel``,
 * so connecting, keys and editing live in one place), under a large
 * "Servers" title that hands over to the bar's small one as it scrolls
 * away. The row in use offers **Sessions ›**, which pushes its session list
 * back over this screen; **Use** on another switches the app to that server
 * (the "Switching to…" screen, then its Sessions).
 *
 * ``active``: the screen is on top, or one swipe away under Sessions. The
 * panel loads the servers and pings them each time it turns true, so a
 * swipe back reveals the real list with fresh states.
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { useLargeTitleCollapse } from '@/components/Sidebar/useLargeTitleCollapse'

export function ServersScreen({ active, onOpenSessions }: { active: boolean; onOpenSessions: () => void }) {
  const { barRef, titleRef, onScroll } = useLargeTitleCollapse(false)
  return (
    <div data-servers-screen="" className="flex h-full w-full min-w-0 flex-col bg-(--bg-page)">
      <header
        ref={barRef}
        data-servers-bar=""
        className="group/bar mobile-safe-header flex shrink-0 items-center justify-center border-b border-transparent px-3 transition-colors duration-(--motion-fast) data-title-visible:border-(--color-border)"
      >
        {/* The large title is the heading; this one only echoes it. */}
        <span
          aria-hidden="true"
          className="text-base font-semibold text-(--color-text) opacity-0 transition-opacity duration-(--motion-fast) group-data-title-visible/bar:opacity-100"
        >
          Servers
        </span>
      </header>
      <div data-servers-scroller="" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-safe" onScroll={onScroll}>
        <div className="px-3 pb-2">
          <h1 ref={titleRef} className="pb-1 pt-0.5 text-large-title font-bold text-(--color-text)">
            Servers
          </h1>
        </div>
        <div className="px-3 pb-6">
          <AppBackendPanel active={active} sectionTitle="Your servers" onOpenInUse={onOpenSessions} />
        </div>
      </div>
    </div>
  )
}
