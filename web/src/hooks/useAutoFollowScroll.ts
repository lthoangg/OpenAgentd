import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const SCROLL_THRESHOLD = 40
const USER_SCROLL_INTENT_MS = 250
/** Quiet time after the last visual-viewport resize before the keyboard counts as settled. */
export const KEYBOARD_SETTLE_MS = 120
const SCROLL_UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
/** How long a return to a session waits for its anchor block to render. */
const RESTORE_WAIT_MS = 3000

/**
 * Where each session was left scrolled up: the first block in view and its
 * offset from the viewport top. A session left at the bottom has no entry
 * and keeps following. In memory only, like the rest of the view state.
 */
interface SavedPosition {
  anchorId: string
  offset: number
}
const savedPositions = new Map<string, SavedPosition>()

export function _resetScrollMemoryForTests(): void {
  savedPositions.clear()
}

/** The first ``[data-block-id]`` whose bottom is below the viewport top. */
function firstBlockInView(root: HTMLElement): HTMLElement | null {
  const blocks = root.querySelectorAll<HTMLElement>('[data-block-id]')
  const top = root.getBoundingClientRect().top
  // Blocks are in document order, so their bottoms only grow: bisect.
  let lo = 0
  let hi = blocks.length - 1
  let found: HTMLElement | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (blocks[mid].getBoundingClientRect().bottom > top) {
      found = blocks[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return found
}

function findBlock(root: HTMLElement, id: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>('[data-block-id]')) if (el.dataset.blockId === id) return el
  return null
}

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
  const lastScrollHeightRef = useRef(0)
  const lastContentHeightRef = useRef(0)
  const smoothScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const smoothScrollFinishRef = useRef<(() => void) | null>(null)
  const userScrollIntentUntilRef = useRef(0)
  const pointerDownRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const sessionIdRef = useRef(sessionId)
  // A return to a session left scrolled up, until its anchor renders.
  const pendingRestoreRef = useRef<(SavedPosition & { until: number }) | null>(null)
  const saveFrameRef = useRef(0)

  const onLoadOlderTopRef = useRef(onLoadOlderTop)
  useEffect(() => {
    onLoadOlderTopRef.current = onLoadOlderTop
  }, [onLoadOlderTop])

  // Two anchoring modes, keyed on ``data-follow`` (index.css):
  // - ``live``: the scroller opts out of native anchoring and this hook keeps
  //   the bottom in view (the ResizeObserver below). The sentinel's own
  //   ``overflow-anchor`` is kept in step for engines that honour it.
  // - ``reading``: the reader scrolled up, so the scroller opts in and the
  //   browser holds the first visible block still when content above it
  //   grows or shrinks (an image, KaTeX, a late highlight, a tool row).
  const syncAnchor = useCallback(() => {
    const el = scrollRef.current
    if (el) el.dataset.follow = attachedRef.current ? 'live' : 'reading'
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
      if (smoothScrollTimeoutRef.current) {
        clearTimeout(smoothScrollTimeoutRef.current)
        smoothScrollTimeoutRef.current = null
      }
      if (smoothScrollFinishRef.current) {
        smoothScrollFinishRef.current()
      }
      isProgrammaticScrollRef.current = true
      el.scrollTo({ top: bottom, behavior: 'smooth' })
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        smoothScrollFinishRef.current = null
        if (smoothScrollTimeoutRef.current) {
          clearTimeout(smoothScrollTimeoutRef.current)
          smoothScrollTimeoutRef.current = null
        }
        el.removeEventListener('scrollend', finish)
        const target = Math.max(0, el.scrollHeight - el.clientHeight)
        if (Math.abs(el.scrollTop - target) > 1) {
          el.scrollTop = target
          lastScrollTopRef.current = el.scrollTop
        }
        isProgrammaticScrollRef.current = false
      }
      smoothScrollFinishRef.current = finish
      el.addEventListener('scrollend', finish)
      smoothScrollTimeoutRef.current = setTimeout(finish, 600)
    } else {
      if (smoothScrollTimeoutRef.current) {
        clearTimeout(smoothScrollTimeoutRef.current)
        smoothScrollTimeoutRef.current = null
      }
      if (smoothScrollFinishRef.current) {
        smoothScrollFinishRef.current = null
      }
      isProgrammaticScrollRef.current = false
      el.scrollTop = bottom
      lastScrollTopRef.current = el.scrollTop
    }
  }, [syncAnchor])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    if (contentRef.current) {
      lastContentHeightRef.current = contentRef.current.getBoundingClientRect().height
    }

    const onScroll = () => {
      const currentScrollTop = el.scrollTop
      const prevScrollTop = lastScrollTopRef.current
      lastScrollTopRef.current = currentScrollTop

      const currentScrollHeight = el.scrollHeight
      const prevScrollHeight = lastScrollHeightRef.current
      lastScrollHeightRef.current = currentScrollHeight

      const content = contentRef.current
      const currentContentHeight = content ? content.getBoundingClientRect().height : 0
      const prevContentHeight = lastContentHeightRef.current
      if (content) {
        lastContentHeightRef.current = currentContentHeight
      }

      if (isProgrammaticScrollRef.current) return
      const dist = currentScrollHeight - currentScrollTop - el.clientHeight
      const atBottom = dist <= SCROLL_THRESHOLD

      if (atBottom) {
        if (Date.now() >= userScrollIntentUntilRef.current) {
          attachedRef.current = true
          syncAnchor()
          setShowScrollBtn(false)
        }
      } else if (attachedRef.current) {
        const layoutShrank =
          (prevScrollHeight > 0 && currentScrollHeight < prevScrollHeight) ||
          (prevContentHeight > 0 && currentContentHeight < prevContentHeight)

        if (!layoutShrank && !document.documentElement.hasAttribute('data-keyboard-open')) {
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
      scheduleSave()
    }

    // Remember where the reader is, once a frame while they scroll, so a
    // switch away (whose re-render replaces the blocks) has it on record.
    const scheduleSave = () => {
      if (saveFrameRef.current) return
      const sid = sessionIdRef.current
      saveFrameRef.current = requestAnimationFrame(() => {
        saveFrameRef.current = 0
        if (!sid || sid !== sessionIdRef.current || pendingRestoreRef.current) return
        if (attachedRef.current) {
          savedPositions.delete(sid)
          return
        }
        const anchor = firstBlockInView(el)
        const anchorId = anchor?.dataset.blockId
        if (!anchor || !anchorId) return
        savedPositions.set(sid, { anchorId, offset: anchor.getBoundingClientRect().top - el.getBoundingClientRect().top })
      })
    }

    const detachForUserScrollUp = () => {
      pendingRestoreRef.current = null
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
      cancelAnimationFrame(saveFrameRef.current)
      saveFrameRef.current = 0
    }
  }, [syncAnchor])

  /** Put a returning session back where it was left; false until its anchor renders. */
  const tryRestore = useCallback((): boolean => {
    const pending = pendingRestoreRef.current
    const el = scrollRef.current
    if (!pending || !el) return false
    if (Date.now() > pending.until) {
      pendingRestoreRef.current = null
      return false
    }
    const anchor = findBlock(el, pending.anchorId)
    if (!anchor) return false
    pendingRestoreRef.current = null
    attachedRef.current = false
    syncAnchor()
    el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - pending.offset
    lastScrollTopRef.current = el.scrollTop
    setShowScrollBtn(true)
    return true
  }, [syncAnchor])

  // Before paint, so a scroll event the swap causes is neither saved under
  // the session being left nor saved over the one being entered.
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId
    cancelAnimationFrame(saveFrameRef.current)
    saveFrameRef.current = 0
    const saved = sessionId ? savedPositions.get(sessionId) : undefined
    pendingRestoreRef.current = saved ? { ...saved, until: Date.now() + RESTORE_WAIT_MS } : null
  }, [sessionId])

  // Layout effects, like the one above: a switch's or a load's first frame
  // paints already at the bottom (or the restored spot), never at the top.
  useLayoutEffect(() => {
    if (tryRestore()) return
    // Until a returning session's anchor renders, follow the bottom.
    attachedRef.current = true
    syncAnchor()
    setShowScrollBtn(false)
    scrollToBottom()
  }, [sessionId, scrollToBottom, syncAnchor, tryRestore])

  useLayoutEffect(() => {
    if (isUserMessage) {
      // Sending in a session returns it to the live end.
      pendingRestoreRef.current = null
      attachedRef.current = true
    }
    if (pendingRestoreRef.current && tryRestore()) return
    if (attachedRef.current) {
      syncAnchor()
      scrollToBottom()
    }
  }, [totalLen, lastContent, isUserMessage, scrollToBottom, syncAnchor, tryRestore])

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
      lastContentHeightRef.current = nextContentHeight
      lastScrollHeightRef.current = el.scrollHeight
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

  // The soft keyboard shrinks the scrollport from the bottom while scrollTop
  // stays put, so the end of the latest reply slides under the composer. The
  // observer above deliberately ignores those per-frame shrinks (chasing the
  // keyboard animation is janky); instead re-pin once, after the keyboard has
  // settled, if the reader was following the bottom.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const root = document.documentElement
    const vv = window.visualViewport
    let open = root.hasAttribute('data-keyboard-open')
    let timer: ReturnType<typeof setTimeout> | null = null
    const repin = () => {
      timer = null
      vv?.removeEventListener('resize', settle)
      if (attachedRef.current) scrollToBottom()
    }
    function settle() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(repin, KEYBOARD_SETTLE_MS)
    }
    const observer = new MutationObserver(() => {
      const next = root.hasAttribute('data-keyboard-open')
      if (next === open) return
      open = next
      if (!next) return
      vv?.addEventListener('resize', settle)
      settle()
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-keyboard-open'] })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
      vv?.removeEventListener('resize', settle)
    }
  }, [scrollToBottom])

  return {
    scrollRef,
    contentRef,
    anchorRef,
    attachedRef,
    syncAnchor,
    showScrollBtn,
    setShowScrollBtn,
    scrollToBottom,
  }
}
