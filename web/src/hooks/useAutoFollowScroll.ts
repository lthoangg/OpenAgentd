import { useCallback, useEffect, useRef, useState } from 'react'

const SCROLL_THRESHOLD = 40
const USER_SCROLL_INTENT_MS = 250
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isInsideScrollableChild(root: HTMLElement, target: EventTarget | null, deltaY: number): boolean {
  if (!target || !(target instanceof Element)) return false
  let curr: Element | null = target
  while (curr && curr !== root) {
    if (curr instanceof HTMLElement) {
      const style = window.getComputedStyle(curr)
      const isScrollable =
        (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') &&
        curr.scrollHeight > curr.clientHeight
      if (isScrollable) {
        const isContain = style.overscrollBehavior === 'contain' || style.overscrollBehaviorY === 'contain'
        if (deltaY < 0 && (curr.scrollTop > 0 || isContain)) return true
        if (deltaY > 0 && (curr.scrollTop < curr.scrollHeight - curr.clientHeight - 1 || isContain)) return true
      }
    }
    curr = curr.parentElement
  }
  return false
}

export interface UseAutoFollowScrollOptions {
  totalLen?: number
  lastContent?: string
  sessionId?: string
  isUserMessage?: boolean
  isEmpty?: boolean
  onLoadOlderTop?: () => void
}

export function useAutoFollowScroll(options: UseAutoFollowScrollOptions = {}) {
  const { totalLen, lastContent, sessionId, isUserMessage, isEmpty, onLoadOlderTop } = options

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef(true)
  const isProgrammaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const userScrollIntentUntilRef = useRef(0)
  const pointerDownRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const onLoadOlderTopRef = useRef(onLoadOlderTop)
  useEffect(() => {
    onLoadOlderTopRef.current = onLoadOlderTop
  }, [onLoadOlderTop])

  // Overflow-anchor pairs with the bottom sentinel the views render: while
  // attached, the browser pins the viewport to the sentinel as the stream
  // grows — no per-frame ``scrollTop`` writes that would drop compositor
  // tiles and leave the transcript blank until the next user scroll. When the
  // user detaches (scrolled up to read), the anchor is disabled so the
  // browser does not silently yank them back to the bottom.
  const syncAnchor = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    anchor.style.overflowAnchor = attachedRef.current ? 'auto' : 'none'
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
    attachedRef.current = true
    syncAnchor()
    userScrollIntentUntilRef.current = 0
    setShowScrollBtn(false)
    if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
      isProgrammaticScrollRef.current = true
      el.scrollTo({ top: bottom, behavior: 'smooth' })
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        isProgrammaticScrollRef.current = false
        el.removeEventListener('scrollend', finish)
        const target = Math.max(0, el.scrollHeight - el.clientHeight)
        if (Math.abs(el.scrollTop - target) > 1) {
          el.scrollTop = target
          lastScrollTopRef.current = el.scrollTop
        }
      }
      el.addEventListener('scrollend', finish)
      setTimeout(finish, 500)
    } else {
      el.scrollTop = bottom
      lastScrollTopRef.current = el.scrollTop
    }
  }, [syncAnchor])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop

    const onScroll = () => {
      const currentScrollTop = el.scrollTop
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      if (isProgrammaticScrollRef.current) return
      const dist = el.scrollHeight - currentScrollTop - el.clientHeight
      const atBottom = dist <= SCROLL_THRESHOLD

      if (atBottom) {
        if (Date.now() >= userScrollIntentUntilRef.current) {
          attachedRef.current = true
          syncAnchor()
          setShowScrollBtn(false)
        }
      } else if (attachedRef.current) {
        if (!document.documentElement.hasAttribute('data-keyboard-open')) {
          const isScrollUp = currentScrollTop < prevScrollTop
          if (isScrollUp) {
            attachedRef.current = false
            syncAnchor()
            setShowScrollBtn(true)
          }
        }
      }

      if (currentScrollTop <= 300) {
        onLoadOlderTopRef.current?.()
      }
    }

    const detachForUserScrollUp = () => {
      userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS
      if (!attachedRef.current) return
      if (el.scrollHeight - el.clientHeight <= 1) return
      attachedRef.current = false
      syncAnchor()
      setShowScrollBtn(true)
    }

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        if (isInsideScrollableChild(el, e.target, e.deltaY)) return
        detachForUserScrollUp()
      }
    }
    let lastTouchY: number | null = null
    let lastTouchTarget: EventTarget | null = null
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null
      lastTouchTarget = e.target
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (y === undefined) return
      if (lastTouchY !== null && y > lastTouchY) {
        if (!isInsideScrollableChild(el, lastTouchTarget ?? e.target, -1)) {
          detachForUserScrollUp()
        }
      }
      lastTouchY = y
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_UP_KEYS.has(e.key)) return
      const target = e.target as HTMLElement | null
      if (target && target !== document.body && !el.contains(target)) return
      if (target && (target.isContentEditable || EDITABLE_TAGS.has(target.tagName))) return
      detachForUserScrollUp()
    }

    const onPointerDown = () => { pointerDownRef.current = true }
    const onPointerUp = () => {
      if (!pointerDownRef.current) return
      pointerDownRef.current = false
      if (!attachedRef.current) return
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      lastScrollTopRef.current = el.scrollTop
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerUp, { passive: true })
    document.addEventListener('keydown', onKeyDown)

    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [syncAnchor])

  useEffect(() => {
    attachedRef.current = true
    syncAnchor()
    setShowScrollBtn(false)
    scrollToBottom()
  }, [sessionId, scrollToBottom, syncAnchor])

  useEffect(() => {
    if (isUserMessage) {
      attachedRef.current = true
    }
    if (attachedRef.current) {
      syncAnchor()
      scrollToBottom()
    }
  }, [totalLen, lastContent, isUserMessage, scrollToBottom, syncAnchor])

  useEffect(() => {
    if (!isEmpty) return
    attachedRef.current = true
    syncAnchor()
    setShowScrollBtn(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [isEmpty, syncAnchor])

  const hasContent = !isEmpty
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    let lastContentHeight = content.getBoundingClientRect().height
    let lastClientHeight = el.clientHeight
    const ro = new ResizeObserver((entries) => {
      if (!attachedRef.current) return
      if (pointerDownRef.current) return
      const nextContentHeight = content.getBoundingClientRect().height
      const nextClientHeight = el.clientHeight
      const contentGrew = nextContentHeight > lastContentHeight
      const viewportChanged = nextClientHeight !== lastClientHeight
      const contentChanged = entries.some((entry) => entry.target === content)

      lastContentHeight = nextContentHeight
      lastClientHeight = nextClientHeight
      if (document.documentElement.hasAttribute('data-keyboard-open') && viewportChanged && !contentGrew && !contentChanged) return
      const target = Math.max(0, el.scrollHeight - el.clientHeight)
      if (Math.abs(el.scrollTop - target) > 0.5) {
        el.scrollTop = target
        lastScrollTopRef.current = el.scrollTop
      }
    })
    ro.observe(content)
    ro.observe(el)
    if (anchorRef.current) ro.observe(anchorRef.current)
    return () => ro.disconnect()
  }, [hasContent])

  return {
    scrollRef,
    contentRef,
    anchorRef,
    attachedRef,
    showScrollBtn,
    setShowScrollBtn,
    scrollToBottom,
  }
}
