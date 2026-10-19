/**
 * Receives `openagentd://connect` links (the QR code from the desktop's
 * Network access card) and turns them into a pending connect request for
 * the Backend connection dialog.
 *
 * Mounted in `App`, above the router: a phone with no saved server never
 * gets past the loading screen, so `useDeepLinkRouter` (in the root route)
 * would never see the link. Nothing connects until the user confirms.
 *
 * Every live `onOpenUrl` event is a fresh scan, so it always opens the
 * dialog, even for a QR code this phone already used. Only the `getCurrent()`
 * replay is deduplicated: the plugin keeps reporting the last opened URL for
 * the life of the app, including after Save & Connect reloads the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppBackendPrefill } from '@/components/AppBackendDialog'
import { parseConnectLink } from '@/lib/connect-link'
import { pingServer } from '@/lib/server-probe'

const DELIVERED_STORAGE_KEY = 'openagentd.connectLink.delivered'

/** Links already shown in this app run; sessionStorage survives page reloads. */
function loadDelivered(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(DELIVERED_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function rememberDelivered(delivered: Set<string>, raw: string): void {
  delivered.add(raw)
  try {
    window.sessionStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify([...delivered].slice(-8)))
  } catch {
    // Storage unavailable: the in-memory set still covers this page.
  }
}

/** The first address that answers, else the first one so the dialog can explain the failure. */
export async function pickReachableUrl(urls: string[]): Promise<string> {
  for (const url of urls) {
    if (await pingServer(url)) return url
  }
  return urls[0]
}

async function listenForLinks(onUrls: (urls: string[], replayed: boolean) => void): Promise<(() => void) | undefined> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  if (getCurrentWindow().label !== 'main') return undefined
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  const stop = await onOpenUrl((urls) => onUrls(urls, false))
  const initial = await getCurrent()
  if (initial) onUrls(initial, true)
  return stop
}

export function useConnectLink(): { request: AppBackendPrefill | null; clear: () => void } {
  const [request, setRequest] = useState<AppBackendPrefill | null>(null)
  const delivered = useRef<Set<string> | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    delivered.current ??= loadDelivered()
    const seen = delivered.current

    const handle = async (raw: string, replayed: boolean) => {
      const link = parseConnectLink(raw)
      if (!link || (replayed && seen.has(raw))) return
      const baseUrl = await pickReachableUrl(link.urls)
      // Marked only once delivered: a disposed listener (StrictMode remount)
      // leaves the link to the next one.
      if (disposed || (replayed && seen.has(raw))) return
      rememberDelivered(seen, raw)
      setRequest({ baseUrl, accessKey: link.key })
    }

    void listenForLinks((urls, replayed) => {
      for (const url of urls) void handle(url, replayed)
    }).then((stop) => {
      if (disposed) stop?.()
      else unlisten = stop
    }).catch(() => {})

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const clear = useCallback(() => setRequest(null), [])
  return { request, clear }
}
