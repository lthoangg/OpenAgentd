/**
 * Swap — one thing replacing another in the same spot, as SF Symbols'
 * "replace" transition and SwiftUI's ``numericText`` do it.
 *
 *  - ``IconSwap``: the old icon shrinks, blurs and fades while the new one
 *    springs up in its place (Copy → ✓, Send ↔ Stop, sun ↔ moon).
 *  - ``RollingNumber``: a number's digits that changed roll up (or down when
 *    it falls); the digits that did not change stay still.
 *
 * Both stack the leaving and the entering content in one grid cell, so the
 * box never changes size mid-swap, and run on the Web Animations API (no
 * motion where it is missing, as in tests). The first render never animates;
 * under reduced motion the content swaps at once.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { DURATIONS_S, EASINGS, cssEasing, prefersReducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

type SwapKey = string | number | boolean

interface Poses {
  hidden: Keyframe
  shown: Keyframe
  /** Where the leaving content goes; defaults to ``hidden``. */
  gone?: Keyframe
}

const REPLACE: Poses = {
  hidden: { opacity: 0, transform: 'scale(0.5)', filter: 'blur(2px)' },
  shown: { opacity: 1, transform: 'none', filter: 'blur(0px)' },
}
const ROLL_UP: Poses = {
  hidden: { opacity: 0, transform: 'translateY(70%)' },
  shown: { opacity: 1, transform: 'none' },
  gone: { opacity: 0, transform: 'translateY(-70%)' },
}
const ROLL_DOWN: Poses = {
  hidden: { opacity: 0, transform: 'translateY(-70%)' },
  shown: { opacity: 1, transform: 'none' },
  gone: { opacity: 0, transform: 'translateY(70%)' },
}

const CELL = '[grid-area:1/1]'

function Entering({ poses, animate, enterMs, easing, children }: {
  poses: Poses
  animate: boolean
  enterMs: number
  easing: string
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!animate || !el || typeof el.animate !== 'function') return
    const anim = el.animate([poses.hidden, poses.shown], { duration: enterMs, easing })
    anim.finished.catch(() => {})
    return () => anim.cancel()
    // Once, on mount: a new key mounts a new Entering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <span ref={ref} className={cn(CELL, 'inline-flex items-center justify-center')}>{children}</span>
}

function Leaving({ poses, onDone, children }: { poses: Poses; onDone: () => void; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof el.animate !== 'function') {
      doneRef.current()
      return
    }
    const anim = el.animate([poses.shown, poses.gone ?? poses.hidden], {
      duration: DURATIONS_S.fast * 1000,
      easing: cssEasing(EASINGS.inOut),
      fill: 'forwards',
    })
    anim.finished.then(() => doneRef.current(), () => {})
    return () => anim.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <span ref={ref} aria-hidden="true" className={cn(CELL, 'pointer-events-none inline-flex items-center justify-center')}>
      {children}
    </span>
  )
}

/**
 * Shows ``children`` and, when ``swapKey`` changes, swaps the previous
 * content out as the new one comes in. Internal: use IconSwap or
 * RollingNumber.
 */
function Swap({ swapKey, poses, enterMs, easing, className, children }: {
  swapKey: SwapKey
  poses: Poses
  enterMs: number
  easing: string
  className?: string
  children: ReactNode
}) {
  const [leaving, setLeaving] = useState<{ id: number; node: ReactNode; poses: Poses }[]>([])
  const lastRef = useRef<{ key: SwapKey; node: ReactNode }>({ key: swapKey, node: children })
  const swappedRef = useRef(false)
  const idRef = useRef(0)
  // Content swapped at least once: from then on a new key animates in (the
  // first render never does).
  if (lastRef.current.key !== swapKey) swappedRef.current = true

  // A new key: the content drawn until now leaves. ``lastRef`` still holds
  // it here; the effect below then records this render's.
  useLayoutEffect(() => {
    const last = lastRef.current
    if (last.key === swapKey || prefersReducedMotion()) return
    const id = ++idRef.current
    // At most one leaving copy: a fast run of swaps drops the oldest.
    setLeaving((list) => [...list.slice(-1), { id, node: last.node, poses }])
    // ``poses`` is read at the swap; changing it alone swaps nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapKey])
  useLayoutEffect(() => {
    lastRef.current = { key: swapKey, node: children }
  })

  const animateIn = swappedRef.current && !prefersReducedMotion()
  return (
    <span className={cn('inline-grid', className)}>
      {leaving.map((item) => (
        <Leaving key={item.id} poses={item.poses} onDone={() => setLeaving((list) => list.filter((l) => l.id !== item.id))}>
          {item.node}
        </Leaving>
      ))}
      <Entering key={String(swapKey)} poses={poses} animate={animateIn} enterMs={enterMs} easing={easing}>
        {children}
      </Entering>
    </span>
  )
}

/**
 * An icon that changes with state: the old one shrinks away as the new one
 * springs up (SF Symbols' replace). ``swapKey`` names the state, e.g.
 * ``copied``; the icon only animates when it changes.
 */
export function IconSwap({ swapKey, className, children }: { swapKey: SwapKey; className?: string; children: ReactNode }) {
  return (
    <Swap
      swapKey={swapKey}
      poses={REPLACE}
      enterMs={DURATIONS_S.base * 1000}
      easing={cssEasing(EASINGS.springSoft)}
      className={cn('shrink-0', className)}
    >
      {children}
    </Swap>
  )
}

function Digit({ char, up }: { char: string; up: boolean }) {
  // The glyph is drawn from ``data-char``, not a text node, so the number
  // reads once (the screen-reader copy below) for assistive tech and tests.
  return (
    <Swap swapKey={char} poses={up ? ROLL_UP : ROLL_DOWN} enterMs={DURATIONS_S.base * 1000} easing={cssEasing(EASINGS.out)} className="overflow-hidden">
      <span data-char={char} className="before:content-[attr(data-char)]" />
    </Swap>
  )
}

/**
 * A number whose changed digits roll (up as it grows, down as it falls),
 * like SwiftUI's ``numericText``. Pass the formatted text; ``value`` (the
 * raw number) sets the direction. Digits line up by their place from the
 * right, in tabular figures, so unchanged places stay still. ``suffix``
 * (" used", " new") is words that stay still after it; the number and its
 * words read as one phrase.
 */
export function RollingNumber({ text, value, suffix, className }: { text: string; value: number; suffix?: string; className?: string }) {
  const prevRef = useRef(value)
  const up = value >= prevRef.current
  useLayoutEffect(() => {
    prevRef.current = value
  })
  // Digits, separators and signs: one code unit each.
  const chars = text.split('')
  return (
    <span data-slot="rolling-number" className={cn('inline-flex tabular-nums', className)}>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, i) => (
          // Keyed by the place from the right, so a new leading digit does
          // not shift every other place into a roll.
          <Digit key={chars.length - i} char={char} up={up} />
        ))}
      </span>
      {/* Drawn from the attribute too, so the phrase reads once. */}
      {suffix && <span aria-hidden="true" data-suffix={suffix} className="whitespace-pre before:content-[attr(data-suffix)]" />}
      <span className="sr-only">{suffix ? `${text}${suffix}` : text}</span>
    </span>
  )
}

/**
 * Whether ``key`` has changed since mount: for a control that renders a new
 * element per state (so IconSwap would mount fresh and stay still), give its
 * icon ``oa-icon-in`` once this is true, and the first render stays still.
 */
export function useHasSwapped(key: SwapKey): boolean {
  const [first] = useState(key)
  const [swapped, setSwapped] = useState(false)
  if (!swapped && key !== first) setSwapped(true)
  return swapped
}

/**
 * A badge that bumps when its count grows (or its label changes): a quick
 * spring swell and back, the way an iOS badge takes a new count. Put the
 * returned ref on the badge. A count that falls, the first render and
 * reduced motion stay still.
 */
export function useBadgeBump<T extends HTMLElement>(value: number | string | undefined) {
  const ref = useRef<T>(null)
  const prevRef = useRef(value)
  useLayoutEffect(() => {
    const prev = prevRef.current
    prevRef.current = value
    const el = ref.current
    if (prev === value || value === undefined || prev === undefined) return
    if (typeof value === 'number' && typeof prev === 'number' && value < prev) return
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return
    const anim = el.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.2)', offset: 0.4 }, { transform: 'scale(1)' }],
      { duration: DURATIONS_S.base * 1000, easing: cssEasing(EASINGS.out) },
    )
    anim.finished.catch(() => {})
  }, [value])
  return ref
}
