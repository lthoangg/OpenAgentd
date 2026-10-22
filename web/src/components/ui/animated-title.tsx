/**
 * AnimatedTitle — a session title that animates when the server names the
 * session (``lib/auto-title``): the old title lifts out at ``base`` while the
 * new one is written in, left to right, over ``glacial`` (DESIGN.md → Motion,
 * "the agent wrote this"). Any other change swaps the text, and reduced
 * motion always does.
 *
 * Truncates like ``truncate``: give it the width (``min-w-0`` / ``flex-1``)
 * its plain ``<span>`` had.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'

import { cn } from '@/lib/utils'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { isFreshAutoTitle } from '@/lib/auto-title'
import { DURATIONS_S, EASINGS } from '@/lib/motion'

interface TitleState {
  text: string
  /** The title leaving, while it lifts out. */
  previous: string | null
  /** Bumps on each animated arrival, remounting the incoming text. */
  arrival: number
}

export function AnimatedTitle({ text, sessionId, className }: { text: string; sessionId?: string | null; className?: string }) {
  const reduced = useReducedMotion() ?? false
  const [state, setState] = useState<TitleState>(() => ({
    text,
    previous: null,
    // A title that mounts as it lands (the first one) is written in too.
    arrival: !reduced && isFreshAutoTitle(sessionId, text) ? 1 : 0,
  }))
  if (text !== state.text) {
    const animate = !reduced && isFreshAutoTitle(sessionId, text)
    setState({ text, previous: animate ? state.text : null, arrival: animate ? state.arrival + 1 : state.arrival })
  }

  useEffect(() => {
    if (state.previous === null) return
    const timer = setTimeout(() => setState((current) => ({ ...current, previous: null })), DURATIONS_S.base * 1000)
    return () => clearTimeout(timer)
  }, [state.previous, state.arrival])

  return (
    <span data-title-arrival={state.arrival || undefined} className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)]', className)}>
      {state.previous !== null && (
        <span aria-hidden="true" className="oa-title-out col-start-1 row-start-1 min-w-0 truncate">{state.previous}</span>
      )}
      <span key={state.arrival} className={cn('col-start-1 row-start-1 min-w-0 truncate', state.arrival > 0 && 'oa-title-reveal')}>
        {state.text}
      </span>
    </span>
  )
}

/**
 * One Signal Blue wash over ``ref`` when its session's title lands from the
 * server: it holds for a moment so the eye finds the row, then drains
 * (``linger``). Uses the Web Animations API, so the row keeps its own
 * classes and a second title restarts it cleanly.
 */
export function useTitleWash(ref: RefObject<HTMLElement | null>, sessionId: string, text: string) {
  const reduced = useReducedMotion() ?? false
  const shown = useRef(text)
  useEffect(() => {
    if (shown.current === text) return
    shown.current = text
    const el = ref.current
    if (!el || reduced || typeof el.animate !== 'function' || !isFreshAutoTitle(sessionId, text)) return
    const style = getComputedStyle(el)
    const wash = style.getPropertyValue('--accent-blue-soft').trim()
    if (!wash) return
    el.animate(
      [
        { backgroundColor: wash, offset: 0 },
        { backgroundColor: wash, offset: 0.4 },
        { backgroundColor: style.backgroundColor, offset: 1 },
      ],
      { duration: DURATIONS_S.linger * 1000, easing: `cubic-bezier(${EASINGS.inOut.join(', ')})` },
    )
  }, [ref, reduced, sessionId, text])
}
