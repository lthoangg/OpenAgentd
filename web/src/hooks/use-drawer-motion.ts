/**
 * useDrawerMotion — binds a phone drawer to its ``lib/drawer-motion`` driver.
 *
 * The drawer (and its scrim) carry ``data-edge-drawer="<id>"`` /
 * ``data-edge-drawer-scrim="<id>"``; this hook positions them for ``open``:
 * where the drawer mounts, and the spring a button press or an outside tap
 * runs. An edge swipe moves the same driver directly (``useEdgeSwipe``), and
 * the state change it commits finds the spring already heading there.
 *
 * A drawer that is mounted by its toggle (the Review panel) has no shut state
 * to spring from: ``slideIn`` mounts it shut and springs it open, from where an
 * edge swipe's release left it when one was already under way.
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
  /**
   * Mounted open by its toggle: start shut and slide in, rather than appear in
   * place. A drawer mounted shut, or already open, is left as it is.
   */
  slideIn?: boolean
}

export function useDrawerMotion(id: string, { open, enabled, hidden, reduced, slideIn = false }: DrawerMotionOptions): void {
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
    else if (slideIn && target === 1 && motion.progress < 1) {
      // Written now, so the first paint has it where the spring starts; a
      // settle already heading for open (an edge swipe's release) goes on.
      motion.apply()
      motion.settle(1)
    } else motion.attach(target)
    attached.current = true
  }, [id, enabled, hidden, open, reduced, slideIn])
}
