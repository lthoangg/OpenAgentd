/**
 * useDrawerMotion — binds a phone drawer to its ``lib/drawer-motion`` driver.
 *
 * The drawer (and its scrim) carry ``data-edge-drawer="<id>"`` /
 * ``data-edge-drawer-scrim="<id>"``; this hook positions them for ``open``:
 * where the drawer mounts, and the spring a button press or an outside tap
 * runs. An edge swipe moves the same driver directly (``useEdgeSwipe``), and
 * the state change it commits finds the spring already heading there.
 */
import { useLayoutEffect, useRef } from 'react'
import { getDrawerMotion } from '@/lib/drawer-motion'

interface DrawerMotionOptions {
  open: boolean
  /** Drawn only on phones: desktop layouts leave the aside to its own sizing. */
  enabled: boolean
  /** Signed px the drawer is translated by when shut. */
  hidden: number
  reduced: boolean
}

export function useDrawerMotion(id: string, { open, enabled, hidden, reduced }: DrawerMotionOptions): void {
  const attached = useRef(false)
  // A layout effect: a drawer that mounts shut is off screen before the first paint.
  useLayoutEffect(() => {
    const motion = getDrawerMotion(id)
    if (!enabled) {
      if (attached.current) motion.detach()
      attached.current = false
      return
    }
    motion.configure({ hidden, reduced })
    const target = open ? 1 : 0
    if (attached.current) motion.settle(target)
    else motion.attach(target)
    attached.current = true
  }, [id, enabled, hidden, open, reduced])
}
