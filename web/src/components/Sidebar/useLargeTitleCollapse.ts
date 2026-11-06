import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react'

/**
 * The Sessions screen's large title (34px, in the scroller) hands over to the
 * small one in the top bar once it has scrolled out of sight, as a large
 * navigation title does: ``data-title-visible`` on the bar, and CSS fades
 * the small title in. The attribute is written straight to the DOM, so a
 * scroll never re-renders the sidebar; React never owns it.
 *
 * ``forceShown``: the large title is not on screen at all (search is open),
 * so the small one stays.
 */
export function useLargeTitleCollapse(forceShown: boolean): {
  barRef: RefObject<HTMLElement | null>
  titleRef: RefObject<HTMLHeadingElement | null>
  onScroll: (event: UIEvent<HTMLElement>) => void
} {
  const barRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const bar = barRef.current
    const title = titleRef.current
    if (!bar || !title) return
    // The title's bottom edge, in the scroller's own coordinates.
    bar.toggleAttribute('data-title-visible', event.currentTarget.scrollTop > title.offsetTop + title.offsetHeight)
  }, [])

  // The scroller starts over at the top when search closes, so the large
  // title is back; while search is open it is gone.
  useEffect(() => {
    barRef.current?.toggleAttribute('data-title-visible', forceShown)
  }, [forceShown])

  return { barRef, titleRef, onScroll }
}
