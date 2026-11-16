/**
 * Where focus lands as the Review panel opens. Covering the chat (overlay)
 * makes the chat inert, which drops its focus onto <body>: the active tab
 * takes it, or the launcher's first row when the panel is empty. Opened by
 * the user with nothing in it, the launcher's first row takes focus.
 */
import { useEffect, useRef } from 'react'
import { useClaimStrandedFocus } from '@/hooks/use-dock-focus'

export function useDockOpenFocus({
  open,
  overlay,
  activeTabId,
  tabButtonRefs,
  tabCount,
  launcherFocusKey,
  handledLauncherFocusKeyRef: parentHandledLauncherFocusKeyRef,
}: {
  open: boolean
  /** The panel covers the chat. */
  overlay: boolean
  activeTabId: string
  tabButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>
  /** Tabs open in the panel. */
  tabCount: number
  /** Grows when the user opens the panel. */
  launcherFocusKey: number
  /** Parent-owned, so a remounted panel does not replay a handled open. */
  handledLauncherFocusKeyRef?: React.RefObject<number>
}) {
  // Covering the chat makes it inert, which drops its focus onto <body>:
  // take it on the active tab, or the launcher's first row when empty.
  useClaimStrandedFocus(open && overlay, activeTabId, () =>
    tabButtonRefs.current.get(activeTabId) ?? document.querySelector<HTMLElement>('[data-dock-launcher] button'))
  // Opened by the user with nothing in it, the launcher is the choice to
  // make: its first row takes focus, so ↓ and Return pick. Not when the
  // panel comes back open with the window, nor when it opens on a tab.
  const localHandledLauncherFocusKeyRef = useRef(0)
  const handledLauncherFocusKeyRef = parentHandledLauncherFocusKeyRef ?? localHandledLauncherFocusKeyRef
  const tabCountRef = useRef(tabCount)
  tabCountRef.current = tabCount
  useEffect(() => {
    if (!open || !launcherFocusKey || handledLauncherFocusKeyRef.current === launcherFocusKey) return
    let frame = requestAnimationFrame(() => {
      // A second frame: a view request's tab lands in the render after this one.
      frame = requestAnimationFrame(() => {
        // Marked here, not before: a cancelled run (Strict Mode) must not use it up.
        handledLauncherFocusKeyRef.current = launcherFocusKey
        if (tabCountRef.current > 0) return
        const row = document.querySelector<HTMLElement>('[data-dock-launcher] button')
        if (row && !row.closest('[inert]')) row.focus()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, launcherFocusKey, handledLauncherFocusKeyRef])
}
