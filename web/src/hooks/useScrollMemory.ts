/**
 * Where each dock view was left scrolled, so switching tabs (which unmounts
 * the view) and coming back opens it where you were reading.
 *
 * In memory only, like the transcript's own scroll memory
 * (``useAutoFollowScroll``). Keys name what is shown, not the tab: the plan
 * of one session, a file by path, a commit by sha.
 */
import { useCallback } from 'react'
import type { RefCallback, RefObject } from 'react'

/** How long a restore waits for content (a file, a diff) to grow tall enough. */
const RESTORE_FRAMES = 60

const positions = new Map<string, number>()

export function _resetScrollMemoryForTests(): void {
  positions.clear()
}

/** Things the reader does that take over from a pending restore. */
const TAKEOVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * A callback ref for a view's scroll container. Remembers its position under
 * ``key`` and puts it back when an element with the same key mounts again,
 * waiting a second for late content. A scroll the reader starts, or one
 * other code makes (a reveal, a jump to newest), wins over the restore.
 * ``also`` receives the element too, for views that keep their own ref.
 */
export function useScrollMemory<T extends HTMLElement = HTMLDivElement>(
  key: string | null | undefined,
  also?: RefObject<T | null>,
): RefCallback<T> {
  return useCallback((el: T | null) => {
    if (also) also.current = el
    if (!el || !key) {
      return () => {
        if (also) also.current = null
      }
    }
    const saved = positions.get(key) ?? 0
    let pending = saved > 0
    let written: number | null = null
    let frames = 0
    let frame = 0

    const stop = () => {
      pending = false
      cancelAnimationFrame(frame)
    }
    const restore = () => {
      if (!pending) return
      // Something else moved it since the last attempt: it wins.
      if (written !== null && Math.abs(el.scrollTop - written) > 1) return stop()
      el.scrollTop = saved
      written = el.scrollTop
      if (Math.abs(written - saved) <= 1 || ++frames >= RESTORE_FRAMES) return stop()
      frame = requestAnimationFrame(restore)
    }
    const onScroll = () => {
      if (!pending) positions.set(key, el.scrollTop)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    for (const type of TAKEOVER_EVENTS) el.addEventListener(type, stop, { passive: true })
    restore()

    return () => {
      stop()
      el.removeEventListener('scroll', onScroll)
      for (const type of TAKEOVER_EVENTS) el.removeEventListener(type, stop)
      if (also) also.current = null
    }
  }, [key, also])
}
