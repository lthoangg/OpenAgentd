/**
 * Receives `openagentd://connect` links (the QR code from the desktop's
 * Network access card) and turns them into a pending connect request for
 * the Backend connection dialog.
 *
 * Mounted in `App`, above the router: a phone with no saved server never
 * gets past the loading screen, so `useDeepLinkRouter` (in the root route)
 * would never see the link. Nothing connects until the user confirms.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppBackendPrefill } from '@/components/AppBackendDialog'
import { parseConnectLink } from '@/lib/connect-link'
import { pingServer } from '@/lib/server-probe'

/** The first address that answers, else the first one so the dialog can explain the failure. */
export async function pickReachableUrl(urls: string[]): Promise<string> {
  for (const url of urls) {
    if (await pingServer(url)) return url
  }
  return urls[0]
}

async function listenForLinks(onUrls: (urls: string[]) => void): Promise<(() => void) | undefined> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  if (getCurrentWindow().label !== 'main') return undefined
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  const stop = await onOpenUrl(onUrls)
  const initial = await getCurrent()
  if (initial) onUrls(initial)
  return stop
}

export function useConnectLink(): { request: AppBackendPrefill | null; clear: () => void } {
  const [request, setRequest] = useState<AppBackendPrefill | null>(null)
  const handled = useRef(new Set<string>())

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    const handle = async (raw: string) => {
      const link = parseConnectLink(raw)
      if (!link || handled.current.has(raw)) return
      const baseUrl = await pickReachableUrl(link.urls)
      // Marked only once delivered: a disposed listener (StrictMode remount)
      // leaves the link to the next one, and the cold-start URL is reported
      // again by every `getCurrent()`.
      if (disposed || handled.current.has(raw)) return
      handled.current.add(raw)
      setRequest({ baseUrl, accessKey: link.key })
    }

    void listenForLinks((urls) => {
      for (const url of urls) void handle(url)
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
