import { useEffect, useRef } from 'react'

import { getPlatform } from '@/hooks/use-platform'
import { topLayer } from '@/lib/keyboard/layers'

/**
 * Android Back (button or gesture), handled the way native apps do:
 *
 * 1. close the top layer (dialog, palette, menu): the same thing Escape
 *    closes, via the keyboard layer stack;
 * 2. else close the latest surface registered with ``registerBackHandler``
 *    (the mobile drawers, which are not layers);
 * 3. else go back in history: what Tauri's default Back did;
 * 4. else, on the first screen, send the app to the background. The default
 *    finished the activity, so the next launch started cold.
 *
 * Registering a listener replaces Tauri's default for every press, so step 3
 * must stay to keep plain Back navigation.
 */

type BackHandler = () => void

let handlers: BackHandler[] = []

/** Close ``close`` on Back while it is registered; the latest one wins. */
export function registerBackHandler(close: BackHandler): () => void {
  handlers = [...handlers, close]
  return () => {
    handlers = handlers.filter((handler) => handler !== close)
  }
}

/** Register ``close`` for Back while ``active`` is true. */
export function useBackHandler(active: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    return registerBackHandler(() => closeRef.current())
  }, [active])
}

export type BackAction = 'layer' | 'handler' | 'history' | 'background'

export function handleBackPress(canGoBack: boolean): BackAction {
  const layer = topLayer()
  if (layer) {
    layer.close()
    return 'layer'
  }
  const handler = handlers.at(-1)
  if (handler) {
    handler()
    return 'handler'
  }
  if (canGoBack) {
    window.history.back()
    return 'history'
  }
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('app_move_to_background'))
    .catch(() => {})
  return 'background'
}

/** Take over Back in the Android shell. Returns a stop function. */
export function installAndroidBackButton(): () => void {
  const { isTauri, os } = getPlatform()
  if (!isTauri || os !== 'android') return () => {}
  let stopped = false
  let unregister: (() => Promise<void>) | undefined
  void import('@tauri-apps/api/app')
    .then(({ onBackButtonPress }) => onBackButtonPress(({ canGoBack }) => { handleBackPress(canGoBack) }))
    .then((listener) => {
      if (stopped) void listener.unregister()
      else unregister = () => listener.unregister()
    })
    .catch(() => {})
  return () => {
    stopped = true
    void unregister?.()
  }
}

export function _resetBackHandlersForTests(): void {
  handlers = []
}
