/**
 * Brings a Review panel tab into view by scrolling its own strip, and
 * nothing else. Not ``scrollIntoView``: that scrolls every ancestor too,
 * ``overflow: hidden`` ones included. A phone's closed Review panel is
 * parked beside the screen, so showing its open tab scrolled ``<body>`` and
 * slid the whole app sideways, with no way to scroll it back.
 */
export function revealTab(tab: HTMLElement | undefined): void {
  const strip = tab?.closest<HTMLElement>('[data-dock-tab-scroller]')
  if (!tab || !strip) return
  const view = strip.getBoundingClientRect()
  const box = tab.getBoundingClientRect()
  if (box.left < view.left) strip.scrollLeft -= view.left - box.left
  else if (box.right > view.right) strip.scrollLeft += box.right - view.right
}
