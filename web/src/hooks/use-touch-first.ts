/**
 * Whether the device is driven by touch first (`pointer: coarse`): a tablet,
 * not a laptop with a touchscreen and a trackpad. Layout follows the input:
 * a tablet gets iPadOS-style overlays, a desktop window pushes its columns.
 */
import { useSyncExternalStore } from 'react'

const QUERY = '(pointer: coarse)'

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

function subscribe(onChange: () => void) {
  const list = media()
  if (!list) return () => {}
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }
  list.addListener?.(onChange)
  return () => list.removeListener?.(onChange)
}

const read = () => media()?.matches ?? false
const fallback = () => false

export function useTouchFirst(): boolean {
  return useSyncExternalStore(subscribe, read, fallback)
}
