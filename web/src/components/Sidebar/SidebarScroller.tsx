import type { ReactNode, UIEvent } from 'react'
import { PullToRefresh } from '@/components/phone/PullToRefresh'

/**
 * The sessions scroller: Pinned, Needs you and the sessions (under a header
 * that sticks) scroll together. On the phone's Sessions screen (``page``) it
 * is a ``PullToRefresh``, which is itself the scroll container. It is only
 * mounted while search is closed, so a pull can never start under a search.
 */
export function SidebarScroller({
  page,
  onRefresh,
  onScroll,
  children,
}: {
  page: boolean
  /** Reload what the list shows; the spinner turns until it settles. */
  onRefresh: () => Promise<unknown>
  onScroll?: (event: UIEvent<HTMLElement>) => void
  children: ReactNode
}) {
  if (!page) {
    return (
      <div data-sidebar-scroller="" className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        {children}
      </div>
    )
  }
  return (
    <PullToRefresh data-sidebar-scroller="" className="min-h-0 flex-1 overflow-x-hidden" onRefresh={onRefresh} onScroll={onScroll}>
      {children}
    </PullToRefresh>
  )
}
