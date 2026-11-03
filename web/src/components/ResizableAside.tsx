/**
 * ResizableAside — a side panel whose drag-resize re-renders only itself.
 *
 * ``usePanelResize`` tracks the live width in state, one update per frame.
 * Owning it here, with the panel body passed in as ``children``, means a drag
 * re-renders this wrapper and the ``PanelResizeHandle`` (which reads the live
 * handle props from context), while React skips the unchanged ``children``
 * subtree. The owner (sidebar, review dock) renders once, on commit.
 *
 * Width stays a framer-motion ``animate`` target so open/close tweens and the
 * drag share one value; ``getMotion`` maps the live width to motion props.
 *
 * ``pinContentWidth`` holds the body at the ``pinWidth`` the motion returns,
 * so opening and closing clip the body instead of reflowing it every frame
 * (a long plan in the review dock cost ~125 ms per close). Without a
 * ``pinWidth`` the body fills the aside: a resize (a drag, or the sidebar
 * beside it changing the room) must move the body with the edge, or its far
 * side is clipped, or left blank, until the tween ends.
 *
 * The aside publishes its target width in ``data-panel-target-width`` so a
 * neighbour can size itself for where the tween ends (``settledWidthBesidePanels``).
 * When a show/hide slide starts, it tells the elements beside it in that
 * same commit (``onPanelSlideBeside``, ``usePanelSlideBeside``), so one sized
 * by the room it leaves can re-measure and slide along from the first frame.
 * With ``publishWidthAs`` it also writes its live border-box width to that CSS
 * property on the elements that line up with it (``usePanelWidthSink``: the
 * header's caps, ``AgentChatHeader``) through a drag and a show/hide slide.
 * Only on them, never on ``<html>``: every element inherits a custom
 * property, so changing one on the root each frame of a slide restyled the
 * whole app, a long transcript above all, every frame.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { motion, type TargetAndTransition, type Transition } from 'framer-motion'

import { panelResizeHandleClass, usePanelResize, type PanelResizeOptions } from '@/hooks/use-panel-resize'
import { DURATIONS_S } from '@/lib/motion'

type ResizeState = ReturnType<typeof usePanelResize>

const ResizeContext = createContext<ResizeState | null>(null)

const PANEL_TARGET_ATTR = 'data-panel-target-width'

/** Dispatched on a panel's parent when its show/hide slide starts. */
const PANEL_SLIDE_EVENT = 'oa-panel-slide'

/** A side panel showing or hiding: the sheet curve, at the ``base`` duration
 *  (DESIGN.md → Motion). Reduced motion zeroes it (index.css). */
const PANEL_SLIDE = 'width var(--motion-base) var(--ease-sheet)'

/** ``PANEL_SLIDE``'s length, for owners timing ``useToggleTween``. */
export const PANEL_SLIDE_MS = DURATIONS_S.base * 1000

/**
 * ``center``'s width once the panels beside it (its siblings) finish their
 * width tweens. A dock sized as a ratio of the measured center would chase
 * the sidebar frame by frame, restarting its own tween each time: it lagged
 * behind and the chat between them overshot, then snapped back. Sized for
 * the settled center, the dock tweens once, alongside the sidebar.
 */
export function settledWidthBesidePanels(center: HTMLElement): number {
  let width = center.getBoundingClientRect().width
  for (const panel of Array.from(center.parentElement?.children ?? [])) {
    if (panel === center || !(panel instanceof HTMLElement)) continue
    const attr = panel.getAttribute(PANEL_TARGET_ATTR)
    const target = attr === null ? Number.NaN : Number(attr)
    if (!Number.isFinite(target)) continue
    // A panel tweened to 0 still renders its border.
    const style = getComputedStyle(panel)
    const floor = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
    width += panel.getBoundingClientRect().width - Math.max(target, floor)
  }
  return width
}

export interface LiveWidth {
  width: number
  isResizing: boolean
}

/**
 * Calls ``callback`` when a panel beside ``center`` (a sibling) starts a
 * show/hide slide, from that panel's layout effect: the panel already has
 * its new target, its width has not moved yet, and a state update made here
 * lands before the slide's first paint. Returns the unsubscribe. A stable
 * ``remeasureOn`` for ``useElementWidth``.
 */
export function onPanelSlideBeside(center: HTMLElement, callback: () => void): () => void {
  const row = center.parentElement
  if (!row) return () => {}
  row.addEventListener(PANEL_SLIDE_EVENT, callback)
  return () => row.removeEventListener(PANEL_SLIDE_EVENT, callback)
}

/**
 * Whether a panel beside ``ref``'s element is sliding open or shut, from
 * the commit the slide starts in until ``PANEL_SLIDE_MS`` later. A panel
 * sized by the room that one leaves slides its own width meanwhile, on the
 * same curve, so the chat between them grows or shrinks in one motion.
 */
export function usePanelSlideBeside(ref: RefObject<HTMLElement | null>): boolean {
  const [slides, setSlides] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    return onPanelSlideBeside(node, () => setSlides((count) => count + 1))
  }, [ref])
  useEffect(() => {
    if (slides === 0) return
    const timer = setTimeout(() => setSlides(0), PANEL_SLIDE_MS)
    return () => clearTimeout(timer)
  }, [slides])
  return slides > 0
}

interface ResizableAsideProps
  extends Omit<ComponentProps<typeof motion.aside>, 'animate' | 'transition' | 'children'> {
  resize: PanelResizeOptions
  /**
   * ``pinWidth`` pins the body width (a panel tweening open or closed keeps
   * its open width). ``instantWidth`` applies ``animate.width`` as a plain
   * style instead: a straight cut that needs no animation frame (desktop
   * panels never tween their width; a throttled frame loop, as in a hidden
   * window, must not leave them stuck at 0).
   * ``tweenWidth`` (with ``instantWidth``) slides that style change with a
   * CSS transition: only while a show/hide toggle runs (``useToggleTween``),
   * never for a drag or a window resize. CSS, not a frame loop, so a hidden
   * window still ends at the right width.
   */
  getMotion: (live: LiveWidth) => { animate: TargetAndTransition; transition: Transition; pinWidth?: number; instantWidth?: boolean; tweenWidth?: boolean }
  /** Lay the children out at ``pinWidth`` rather than the tweening width. */
  pinContentWidth?: boolean
  /**
   * A CSS custom property (e.g. ``--oa-dock-w``) to publish the live
   * border-box width to, on that property's sinks (``usePanelWidthSink``);
   * cleared when unset or unmounted. Owners pass it only while the panel is
   * in flow beside the chat.
   */
  publishWidthAs?: string
  /**
   * Whether the aside takes room in its row. A drawer floating over the row
   * (``false``) publishes no target width and announces no slide: its
   * neighbours keep the room they have, so ``settledWidthBesidePanels`` must
   * not count it (it would shrink the center by the drawer's width on open
   * and grow it on close).
   */
  inFlow?: boolean
  children: ReactNode
}

/** The last published value of each width property, for a sink that mounts later. */
const publishedWidths = new Map<string, string>()
/** The elements that carry each width property. */
const widthSinks = new Map<string, Set<HTMLElement>>()

function writeWidth(el: HTMLElement, name: string, value: string | undefined) {
  if (value === undefined) el.style.removeProperty(name)
  else el.style.setProperty(name, value)
}

function publishWidth(name: string, value: string | undefined) {
  if (publishedWidths.get(name) === value) return
  if (value === undefined) publishedWidths.delete(name)
  else publishedWidths.set(name, value)
  widthSinks.get(name)?.forEach((el) => writeWidth(el, name, value))
}

/**
 * A callback ref that keeps ``name`` (a ``publishWidthAs`` property) on the
 * element it is attached to, and nowhere else.
 */
export function usePanelWidthSink(name: string): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return undefined
    let sinks = widthSinks.get(name)
    if (!sinks) {
      sinks = new Set()
      widthSinks.set(name, sinks)
    }
    sinks.add(el)
    writeWidth(el, name, publishedWidths.get(name))
    return () => {
      sinks.delete(el)
      el.style.removeProperty(name)
    }
  }, [name])
}

/** Keeps ``name`` on its sinks equal to ``ref``'s border-box width while set. */
function usePublishedWidth(ref: RefObject<HTMLElement | null>, name: string | undefined) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!name || !el) return
    const write = () => publishWidth(name, `${el.getBoundingClientRect().width}px`)
    write()
    // Border box: closing to 0 then dropping the 1px edge changes only it.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(write)
    observer?.observe(el, { box: 'border-box' })
    return () => {
      observer?.disconnect()
      publishWidth(name, undefined)
    }
  }, [ref, name])
}

export function ResizableAside({ resize, getMotion, pinContentWidth = false, publishWidthAs, inFlow = true, children, style, ...asideProps }: ResizableAsideProps) {
  const state = usePanelResize(resize)
  const asideRef = useRef<HTMLElement>(null)
  usePublishedWidth(asideRef, publishWidthAs)
  const { animate, transition, pinWidth, instantWidth = false, tweenWidth = false } = getMotion({ width: state.width, isResizing: state.isResizing })
  const { width: targetWidth, ...animateRest } = animate
  const cut = instantWidth && targetWidth !== undefined
  const slide = cut && tweenWidth && !state.isResizing
  // Tell the panels beside this one that a slide to a new target has begun.
  const numericTarget = typeof targetWidth === 'number' ? targetWidth : undefined
  const announcedTarget = useRef(numericTarget)
  useLayoutEffect(() => {
    if (numericTarget === announcedTarget.current) return
    announcedTarget.current = numericTarget
    if (slide && inFlow) asideRef.current?.parentElement?.dispatchEvent(new Event(PANEL_SLIDE_EVENT))
  }, [numericTarget, slide, inFlow])
  // Always the same wrapper, so a change of target (mobile has none) never
  // remounts the panel body.
  const pinnedWidth = pinWidth ?? '100%'
  return (
    <ResizeContext.Provider value={state}>
      <motion.aside
        {...asideProps}
        ref={asideRef}
        data-panel-target-width={inFlow ? numericTarget : undefined}
        style={cut ? { ...style, width: targetWidth as number | string, transition: slide ? PANEL_SLIDE : undefined } : style}
        animate={cut ? animateRest : animate}
        transition={transition}
      >
        {pinContentWidth ? <div className="h-full" style={{ width: pinnedWidth }}>{children}</div> : children}
      </motion.aside>
    </ResizeContext.Provider>
  )
}

/** The separator for the enclosing ``ResizableAside``; place it where the edge is. */
export function PanelResizeHandle({ edge }: { edge: 'left' | 'right' }) {
  const state = useContext(ResizeContext)
  if (!state) return null
  return <div {...state.handleProps} className={panelResizeHandleClass(edge, state.isResizing)} />
}
