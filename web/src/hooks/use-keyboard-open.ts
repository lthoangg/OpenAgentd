import { useSyncExternalStore } from 'react'

/**
 * Whether the soft keyboard is up, as decided by `useMobileViewportGuards`
 * (it toggles `data-keyboard-open` on `<html>`). Always false on desktop and
 * wherever the guards don't run.
 */
function isKeyboardOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-keyboard-open')
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-keyboard-open'] })
  return () => observer.disconnect()
}

export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(subscribe, isKeyboardOpen, () => false)
}
