/**
 * shake — the "no" of an OS text field: a quick left-right wobble when input
 * is rejected (a wrong access key, a bad server URL). Web Animations, so it
 * needs no state and does not fight the element's own transform; it moves
 * the ``translate`` property, which leaves ``transform`` to the element.
 * ``slow`` (400ms) on ``ease-out``. Reduced motion (and an environment without
 * Web Animations, such as the test DOM) does nothing.
 */
import { DURATIONS_S, EASINGS, cssEasing, prefersReducedMotion } from '@/lib/motion'

/** Horizontal offsets in px, first and last at rest. */
const SHAKE_OFFSETS = [0, -6, 6, -4, 4, 0] as const

const SHAKE_ID = 'oa-shake'

/** Wobble ``el`` once; a shake already running is restarted. Returns the animation, or null if it did not run. */
export function shake(el: HTMLElement | null | undefined): Animation | null {
  if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return null
  if (typeof el.getAnimations === 'function') {
    for (const running of el.getAnimations()) if (running.id === SHAKE_ID) running.cancel()
  }
  const animation = el.animate(
    SHAKE_OFFSETS.map((x) => ({ translate: `${x}px 0` })),
    { duration: DURATIONS_S.slow * 1000, easing: cssEasing(EASINGS.out) },
  )
  animation.id = SHAKE_ID
  // Restarting a shake cancels the one running; that rejects its ``finished``
  // promise, which nobody awaits.
  animation.finished?.catch(() => {})
  return animation
}
