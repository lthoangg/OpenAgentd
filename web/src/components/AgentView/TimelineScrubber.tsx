/**
 * TimelineScrubber — an overview rail at the transcript's right edge that
 * stands in for its scrollbar from ``md`` up. The view is a thumb; marks
 * show where prompts and a question waiting on the user sit.
 * Press or drag anywhere on it to scrub.
 *
 * Pointer-only and hidden from assistive tech: prompt navigation covers the
 * same ground from the keyboard.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { cn } from '@/lib/utils'
import { promptElements } from './prompt-nav'

type MarkKind = 'prompt' | 'question'

interface Mark {
  key: string
  kind: MarkKind
  /** Offset down the transcript, 0–1. */
  at: number
}

/** Later kinds paint over earlier ones where marks meet. */
const MARK_ORDER: Record<MarkKind, number> = { prompt: 0, question: 1 }

const MARK_CLASS: Record<MarkKind, string> = {
  prompt: 'h-0.5 w-1.5 bg-(--color-text-subtle)',
  question: 'h-1 w-2 bg-(--color-accent)',
}

/**
 * Marks are re-measured at most this often while the transcript only grows
 * (a streaming answer resizes it every frame). Each measure reads layout for
 * every rendered prompt and re-renders the rail; a mark that trails by a few
 * frames is invisible at this scale.
 */
const MARK_REMEASURE_MS = 200

function percent(fraction: number): string {
  return `${Math.round(fraction * 10_000) / 100}%`
}

/** Equal as drawn: `percent()` rounds to 0.01%. */
function sameFraction(a: number, b: number): boolean {
  return Math.round(a * 10_000) === Math.round(b * 10_000)
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((mark, i) => mark.key === b[i].key && mark.kind === b[i].kind && sameFraction(mark.at, b[i].at))
}

export function TimelineScrubber({ scrollRef, contentRef }: {
  scrollRef: RefObject<HTMLElement | null>
  contentRef: RefObject<HTMLElement | null>
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ top: number; height: number } | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [dragging, setDragging] = useState(false)
  const measuredHeight = useRef(-1)
  const lastMeasureAt = useRef(Number.NEGATIVE_INFINITY)
  const remeasureTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Where on the thumb the pointer holds it, in px; null when not dragging. */
  const grab = useRef<number | null>(null)

  const measureMarks = useCallback((root: HTMLElement) => {
    const height = root.scrollHeight
    measuredHeight.current = height
    if (height <= 0) {
      setMarks([])
      return
    }
    const origin = root.getBoundingClientRect().top - root.scrollTop
    const at = (el: Element) => Math.min(1, Math.max(0, (el.getBoundingClientRect().top - origin) / height))
    const next: Mark[] = promptElements(root).map((el) => ({ key: `prompt:${el.dataset.promptId}`, kind: 'prompt', at: at(el) }))
    const question = root.querySelector('[data-question-waiting]')
    if (question) next.push({ key: 'question', kind: 'question', at: at(question) })
    setMarks((current) => (sameMarks(current, next) ? current : next))
  }, [])
  const measureMarksRef = useRef(measureMarks)
  measureMarksRef.current = measureMarks

  /**
   * Moves the thumb; marks are re-measured when forced, or — throttled to
   * ``MARK_REMEASURE_MS`` — when the height changed.
   */
  const sync = useCallback((force: boolean) => {
    const root = scrollRef.current
    if (!root) return
    const { scrollHeight, clientHeight, scrollTop } = root
    const now = performance.now()
    if (force || (scrollHeight !== measuredHeight.current && now - lastMeasureAt.current >= MARK_REMEASURE_MS)) {
      lastMeasureAt.current = now
      measureMarks(root)
    } else if (scrollHeight !== measuredHeight.current && remeasureTimer.current === null) {
      remeasureTimer.current = setTimeout(() => {
        remeasureTimer.current = null
        const current = scrollRef.current
        if (!current) return
        lastMeasureAt.current = performance.now()
        measureMarksRef.current(current)
      }, MARK_REMEASURE_MS - (now - lastMeasureAt.current))
    }
    const next = scrollHeight > clientHeight + 1 ? { top: scrollTop / scrollHeight, height: clientHeight / scrollHeight } : null
    setView((current) => (
      current && next && sameFraction(current.top, next.top) && sameFraction(current.height, next.height) ? current : next
    ))
  }, [measureMarks, scrollRef])

  useEffect(() => {
    sync(true)
  }, [sync])

  useEffect(() => () => {
    if (remeasureTimer.current !== null) clearTimeout(remeasureTimer.current)
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => sync(false)
    root.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sync(false))
    observer?.observe(root)
    if (contentRef.current) observer?.observe(contentRef.current)
    return () => {
      root.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [contentRef, scrollRef, sync])

  const scrubTo = (clientY: number) => {
    const root = scrollRef.current
    const rail = railRef.current?.getBoundingClientRect()
    if (!root || !rail || rail.height <= 0 || grab.current === null) return
    root.scrollTop = ((clientY - rail.top - grab.current) / rail.height) * root.scrollHeight
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const thumb = thumbRef.current?.getBoundingClientRect()
    const onThumb = thumb !== undefined && event.clientY >= thumb.top && event.clientY <= thumb.bottom
    // Held by the thumb, it stays under the pointer; elsewhere the view centres there.
    grab.current = onThumb ? event.clientY - thumb.top : (thumb?.height ?? 0) / 2
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
    setDragging(true)
    scrubTo(event.clientY)
  }

  const endDrag = () => {
    grab.current = null
    setDragging(false)
  }

  // The rail sits beside the scroller, not in it, so a wheel over it is passed on.
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const root = scrollRef.current
    if (!root) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1
    root.scrollTop += event.deltaY * unit
  }

  const orderedMarks = useMemo(() => [...marks].sort((a, b) => MARK_ORDER[a.kind] - MARK_ORDER[b.kind]), [marks])

  if (!view) return null

  return (
    <div
      ref={railRef}
      aria-hidden="true"
      data-transcript-scrubber=""
      className="group/scrubber absolute inset-y-0 right-0 z-10 hidden w-3 touch-none select-none md:block"
      onPointerDown={onPointerDown}
      onPointerMove={(event) => scrubTo(event.clientY)}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onWheel={onWheel}
    >
      <div
        ref={thumbRef}
        data-scrubber-thumb=""
        // As slim as the app's native scrollbars (index.css); the rail
        // around it stays wider so it is still easy to grab.
        className={cn(
          'absolute right-0 w-[5px] rounded-full bg-(--color-border) transition-opacity duration-(--motion-fast) group-hover/scrubber:bg-(--color-text-muted)',
          dragging ? 'opacity-100' : 'opacity-0 group-hover/transcript:opacity-100',
        )}
        style={{
          top: `calc(min(${percent(view.top)}, 100% - max(${percent(view.height)}, 1.5rem)))`,
          height: `calc(max(${percent(view.height)}, 1.5rem))`,
        }}
      />
      {orderedMarks.map((mark) => (
        <span
          key={mark.key}
          data-scrubber-mark={mark.kind}
          className={cn('pointer-events-none absolute right-0 rounded-full', MARK_CLASS[mark.kind])}
          style={{ top: `calc(min(${percent(mark.at)}, 100% - 0.25rem))` }}
        />
      ))}
    </div>
  )
}
