import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { apiBaseUrl } from '@/api/base-url'
import { withTokenParam } from '@/api/auth'
import { useToastStore } from '@/stores/useToastStore'

export type DeepLinkParsed =
  | { kind: 'auth_callback'; provider: string; code: string }
  | { kind: 'navigate'; path: string }
  | { kind: 'unknown' }

export function parseDeepLinkUrl(urlStr: string): DeepLinkParsed {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'openagentd:' && url.protocol !== 'openagentd-dev:') {
      return { kind: 'unknown' }
    }

    const host = url.host
    const pathname = url.pathname.replace(/^\/+/, '')

    if (host === 'auth' && url.pathname === '/callback') {
      const provider = url.searchParams.get('provider')?.trim()
      const rawCode = url.searchParams.get('code')
      if (!provider || !rawCode?.trim()) return { kind: 'unknown' }

      const state = url.searchParams.get('state')
      const code = state && !rawCode.includes('#') ? `${rawCode}#${state}` : rawCode
      return { kind: 'auth_callback', provider, code }
    }

    if (host === 'cockpit' || host === 'coding' || host === 'session') {
      const target = `/coding/${pathname}`
      return { kind: 'navigate', path: target.replace(/\/+$/, '') }
    }

    return { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  }
}

export async function processOAuthCallback(provider: string, code: string): Promise<boolean> {
  try {
    const res = await fetch(withTokenParam(`${apiBaseUrl()}/auth/${encodeURIComponent(provider)}/callback`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    return res.ok
  } catch {
    return false
  }
}

async function listenToDeepLinks(onUrls: (urls: string[]) => void): Promise<(() => void) | undefined> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  if (getCurrentWindow().label !== 'main') return undefined
  const stopListening = await onOpenUrl((urls) => { void onUrls(urls) })
  const initial = await getCurrent()
  if (initial) void onUrls(initial)
  return stopListening
}

export function useDeepLinkRouter(): void {
  const router = useRouter()

  useEffect(() => {
    const handledOAuthCallbacks = new Set<string>()
    const handleUrl = async (urlStr: string) => {
      const parsed = parseDeepLinkUrl(urlStr)
      if (parsed.kind === 'auth_callback') {
        const callbackKey = JSON.stringify([parsed.provider, parsed.code])
        if (handledOAuthCallbacks.has(callbackKey)) return
        handledOAuthCallbacks.add(callbackKey)
        const ok = await processOAuthCallback(parsed.provider, parsed.code)
        if (ok) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
          useToastStore.getState().push({ tone: 'success', title: 'Authentication connected' })
        } else {
          handledOAuthCallbacks.delete(callbackKey)
          useToastStore.getState().push({ tone: 'error', title: 'Authentication failed' })
        }
      } else if (parsed.kind === 'navigate') {
        void router.navigate({ href: parsed.path })
      }
    }

    let unlisten: (() => void) | undefined
    let disposed = false
    const handleUrls = async (urls: string[]) => {
      await Promise.all(urls.map(handleUrl))
    }

    void listenToDeepLinks((urls) => {
      void handleUrls(urls)
    }).then((stop) => {
      if (disposed) {
        stop?.()
      } else {
        unlisten = stop
      }
    }).catch(() => {})

    return () => {
      disposed = true
      if (unlisten) unlisten()
    }
  }, [router])
}
