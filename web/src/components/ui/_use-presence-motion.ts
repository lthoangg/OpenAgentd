/**
 * usePresenceMotion — the enter and exit of a floating layer (popover,
 * dropdown, dialog, tooltip), interruptible.
 *
 * Pairs with ``useDeferredUnmount``, which keeps the element mounted for the
 * exit. A CSS keyframe enter/exit restarts from its first frame when the
 * layer reopens mid-exit (the class swaps, the animation name changes), so it
 * flashed. This drives the same pose with the Web Animations API and starts
 * each move from where the element is drawn now, as a native popover does
 * when you change your mind. WAAPI rather than framer-motion: it runs on the
 * compositor, needs no motion component around a portal, and where it is
 * missing (tests) the layer simply rests in place.
 *
 * In at ``base`` on ``ease-out``, out at ``fast`` on ``ease-in-out``
 * (DESIGN.md → Motion); reduced motion fades without moving.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { DURATIONS_S, EASINGS, cssEasing } from '@/lib/motion'

/** The pose a layer enters from and leaves to (it rests at opacity 1, no transform). */
export interface PresencePose {
  opacity?: number
  scale?: number
  x?: number
  y?: number
}

export interface PresenceMotionOptions {
  /** Hidden pose; defaults to a 95% scale fade, the menu grow. */
  from?: PresencePose
  /** Enter duration in seconds (default ``base``). */
  enter?: number
  /** Exit duration in seconds (default ``fast``); keep it within the unmount delay. */
  exit?: number
}

const DEFAULT_FROM: PresencePose = { opacity: 0, scale: 0.95 }

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** A pose as a keyframe: opacity plus one transform. */
export function poseFrame(pose: PresencePose, reduced = false): Keyframe {
  const frame: Keyframe = { opacity: pose.opacity ?? 1 }
  if (reduced) return frame
  const parts: string[] = []
  if (pose.x || pose.y) parts.push(`translate(${pose.x ?? 0}px, ${pose.y ?? 0}px)`)
  if (pose.scale !== undefined && pose.scale !== 1) parts.push(`scale(${pose.scale})`)
  frame.transform = parts.length ? parts.join(' ') : 'none'
  return frame
}

/** Where the element is drawn now (mid-animation included), as a keyframe. */
export function drawnFrame(el: HTMLElement): Keyframe {
  const style = getComputedStyle(el)
  return { opacity: style.opacity, transform: style.transform }
}

export function usePresenceMotion(
  ref: RefObject<HTMLElement | null>,
  mounted: boolean,
  closing: boolean,
  { from = DEFAULT_FROM, enter = DURATIONS_S.base, exit = DURATIONS_S.fast }: PresenceMotionOptions = {},
): void {
  // The running enter or exit, and whether this mount has entered yet: the
  // first enter starts from the hidden pose, a reopen from where it is.
  const animRef = useRef<Animation | null>(null)
  const enteredRef = useRef(false)
  const fromRef = useRef(from)
  fromRef.current = from

  useLayoutEffect(() => {
    const el = ref.current
    if (!mounted || !el) {
      enteredRef.current = false
      animRef.current = null
      return
    }
    if (typeof el.animate !== 'function') return
    const reduced = prefersReducedMotion()
    const hidden = poseFrame({ opacity: 0, ...fromRef.current }, reduced)
    const rest = poseFrame({}, reduced)
    const running = animRef.current
    const start = !enteredRef.current ? hidden : running ? drawnFrame(el) : rest
    running?.cancel()
    if (closing) {
      // Holds the hidden pose until useDeferredUnmount removes the element.
      const anim = el.animate([start, hidden], {
        duration: reduced ? 0 : exit * 1000,
        easing: cssEasing(EASINGS.inOut),
        fill: 'forwards',
      })
      // A reversal cancels it, which rejects ``finished``: expected, not an error.
      anim.finished.catch(() => {})
      animRef.current = anim
    } else {
      enteredRef.current = true
      const anim = el.animate([start, rest], {
        duration: reduced ? 0 : enter * 1000,
        easing: cssEasing(EASINGS.out),
      })
      anim.finished.catch(() => {})
      anim.onfinish = () => {
        if (animRef.current === anim) animRef.current = null
      }
      animRef.current = anim
    }
  }, [ref, mounted, closing, enter, exit])
}
