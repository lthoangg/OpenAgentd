/**
 * TitleTooltipLayer — every native ``title`` attribute becomes the app's
 * tooltip (DESIGN.md → Keyboard focus model). Mounted once at the root.
 *
 * The browser's own title box ignores the app's timing, never opens for the
 * keyboard, and looks like neither the OS nor the app. This layer takes the
 * title off the element the moment the pointer (or keyboard focus) reaches
 * it, so the browser has nothing to show, and draws the same hint as
 * <Tooltip>: 500 ms on hover, at once while warm or for keyboard focus,
 * closed by a press, a key or a scroll. The title goes back when the pointer
 * or focus leaves, so React's view of the DOM stays true.
 *
 * While the title is off, the element keeps what it meant to assistive
 * tech: an ``aria-label`` when the title was its only name (an icon-only
 * button), otherwise an ``aria-description``. Touch shows nothing, like the
 * OS.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import {
  OPEN_DELAY_MS,
  TOOLTIP_CONTENT_CLASS,
  isKeyboardFocus,
  isTooltipWarm,
  noteTooltipClosed,
  noteTooltipOpened,
} from '@/components/ui/tooltip'

const VIEWPORT_MARGIN = 8
const SIDE_OFFSET = 8
const HELD = 'data-oa-title'
const ADDED_ARIA = 'data-oa-title-aria'

/** Take the title off ``el`` (keeping its meaning for assistive tech). */
function holdTitle(el: Element): string | null {
  const title = el.getAttribute('title')
  if (title === null) return el.getAttribute(HELD)
  el.removeAttribute('title')
  el.setAttribute(HELD, title)
  if (!title.trim()) return null
  const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || Boolean(el.textContent?.trim())
  if (!named) {
    el.setAttribute('aria-label', title)
    el.setAttribute(ADDED_ARIA, 'label')
  } else if (!el.hasAttribute('aria-description') && !el.hasAttribute('aria-describedby')) {
    el.setAttribute('aria-description', title)
    el.setAttribute(ADDED_ARIA, 'description')
  }
  return title
}

/** Put the title back as React rendered it. */
function releaseTitle(el: Element): void {
  const held = el.getAttribute(HELD)
  if (held === null) return
  el.removeAttribute(HELD)
  if (!el.hasAttribute('title')) el.setAttribute('title', held)
  const added = el.getAttribute(ADDED_ARIA)
  if (added) el.removeAttribute(`aria-${added}`)
  el.removeAttribute(ADDED_ARIA)
}

function titledAncestor(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null
  return target.closest(`[title]:not(iframe), [${HELD}]`)
}

export function TitleTooltipLayer() {
  const isMobile = useIsMobile()
  const [tip, setTip] = useState<{ text: string; anchor: Element } | null>(null)
  const currentRef = useRef<Element | null>(null)
  const openRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isMobile) return
    const clearTimer = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const open = (el: Element, text: string) => {
      clearTimer()
      if (!openRef.current) noteTooltipOpened()
      openRef.current = true
      setTip({ text, anchor: el })
    }
    const close = () => {
      clearTimer()
      if (openRef.current) noteTooltipClosed()
      openRef.current = false
      setTip(null)
    }
    const leave = (el: Element | null) => {
      if (!el || el !== currentRef.current) return
      close()
      releaseTitle(el)
      currentRef.current = null
    }
    const enter = (el: Element, immediate: boolean) => {
      if (el === currentRef.current) return
      if (currentRef.current) leave(currentRef.current)
      const text = holdTitle(el)
      currentRef.current = el
      if (!text?.trim()) return
      if (immediate || isTooltipWarm()) open(el, text)
      else timerRef.current = setTimeout(() => open(el, text), OPEN_DELAY_MS)
    }

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const el = titledAncestor(event.target)
      if (el) enter(el, false)
    }
    const onPointerOut = (event: PointerEvent) => {
      const el = currentRef.current
      if (!el) return
      const to = event.relatedTarget
      if (to instanceof Node && el.contains(to)) return
      leave(el)
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !isKeyboardFocus(target)) return
      const el = titledAncestor(target)
      if (el) enter(el, true)
    }
    const onFocusOut = (event: FocusEvent) => {
      const el = currentRef.current
      if (el && event.target instanceof Node && el.contains(event.target)) leave(el)
    }
    // A press, a key or a scroll ends the hint, as native ones do. The title
    // stays held until the pointer leaves, so the browser cannot show its own.
    const dismiss = () => close()

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('scroll', dismiss, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('scroll', dismiss, { capture: true })
      clearTimer()
      if (openRef.current) noteTooltipClosed()
      openRef.current = false
      if (currentRef.current) releaseTitle(currentRef.current)
      currentRef.current = null
    }
  }, [isMobile])

  if (!tip || isMobile) return null
  return <TitleHint text={tip.text} anchor={tip.anchor} />
}

function TitleHint({ text, anchor }: { text: string; anchor: Element }) {
  const ref = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const a = anchor.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Above the element, like <Tooltip>; below when there is no room.
    let top = a.top - b.height - SIDE_OFFSET
    if (top < VIEWPORT_MARGIN) top = a.bottom + SIDE_OFFSET
    let left = a.left + a.width / 2 - b.width / 2
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - b.width - VIEWPORT_MARGIN))
    top = Math.min(Math.max(top, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vh - b.height - VIEWPORT_MARGIN))
    setCoords({ top, left })
  }, [anchor, text])

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-slot="tooltip-content"
      className={cn(TOOLTIP_CONTENT_CLASS, 'animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-fast)', !coords && 'invisible')}
      style={{ top: coords?.top ?? 0, left: coords?.left ?? 0 }}
    >
      {text}
    </div>,
    document.body,
  )
}
