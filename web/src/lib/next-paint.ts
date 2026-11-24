/**
 * Resolves once the browser has drawn the current state: a task queued from
 * the next frame. A hidden page draws no frame, so it does not wait for one,
 * and a frame that never comes is given up on after a moment.
 */
export function nextPaint(): Promise<void> {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return Promise.resolve()
  return new Promise((resolve) => {
    const giveUp = setTimeout(resolve, 100)
    requestAnimationFrame(() => {
      clearTimeout(giveUp)
      setTimeout(resolve, 0)
    })
  })
}
