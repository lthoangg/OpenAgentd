/**
 * `Dialog` / `Sheet` — mobile edge-swipe exclusion regression.
 *
 * These are the shared zero-dependency overlay primitives used across the
 * app for confirmation dialogs and action-sheets (Sidebar's delete/rename
 * dialogs, CodingSidebar's workspace dialogs, CodingWorkspacePanel's
 * file/commit action sheets, etc). Many of those are rendered on top of an
 * already-open mobile edge-swipe drawer (e.g. the session sidebar).
 *
 * `useEdgeSwipe`'s close-gesture arms on *any* touch while a drawer is
 * open — not just one starting at the screen edge — so a drag on a
 * stacked dialog (e.g. tapping "Delete") could be misread as a
 * swipe-to-close for the drawer underneath. `data-swipe-ignore` on both
 * the backdrop and the content opts them out; see
 * `hooks/use-edge-swipe.ts` (`isSwipeExcluded`) and
 * `__tests__/hooks/useEdgeSwipe.test.tsx` for the consuming mechanism.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

afterEach(cleanup)

describe('Dialog — data-swipe-ignore', () => {
  it('marks both the overlay and the content data-swipe-ignore when open', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Delete session</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    const content = document.querySelector('[data-slot="dialog-content"]')
    expect(overlay).not.toBeNull()
    expect(content).not.toBeNull()
    expect(overlay).toHaveAttribute('data-swipe-ignore')
    expect(content).toHaveAttribute('data-swipe-ignore')
  })
})

describe('Sheet — data-swipe-ignore', () => {
  it('marks both the backdrop and the sliding panel data-swipe-ignore when open', () => {
    render(
      <Sheet open>
        <SheetContent side="left">
          <SheetTitle>Session sidebar</SheetTitle>
        </SheetContent>
      </Sheet>,
    )

    const content = document.querySelector('[data-slot="sheet-content"]')
    expect(content).not.toBeNull()
    expect(content).toHaveAttribute('data-swipe-ignore')

    // Backdrop is the sibling fixed inset-0 div rendered alongside the panel.
    const backdrop = content?.previousElementSibling
    expect(backdrop).not.toBeNull()
    expect(backdrop).toHaveAttribute('data-swipe-ignore')
  })
})
