const QUIET = 'data-quiet-focus'

/**
 * Focus without the keyboard ring, for focus the user did not steer by
 * keyboard: a click (WebKit counts the script ``focus()`` that gives a
 * clicked button focus as keyboard focus and draws the ring), a tab switch
 * that moves focus onto the new tab, or focus handed back on page load.
 * index.css drops the outline while ``data-quiet-focus`` is set; it clears
 * once focus moves elsewhere, so the next control reached with the keyboard
 * shows its ring. A window or app switch also fires ``blur`` but leaves the
 * element active, and the browser refocuses it on return: the flag stays.
 */
export function focusQuietly(el: HTMLElement, options: FocusOptions = { preventScroll: true }): void {
  if (!el.hasAttribute(QUIET)) {
    el.setAttribute(QUIET, '')
    const onBlur = () => {
      if (document.activeElement === el) return
      el.removeAttribute(QUIET)
      el.removeEventListener('blur', onBlur)
    }
    el.addEventListener('blur', onBlur)
  }
  if (document.activeElement !== el) el.focus(options)
  if (document.activeElement !== el) el.removeAttribute(QUIET)
}
