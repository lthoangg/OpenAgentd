import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/queries/keys'
import { apiBaseUrl } from '@/api/base-url'
import { withTokenParam } from '@/api/auth'

export type DeepLinkParsed =
  | { kind: 'auth_callback'; provider: string; code: string }
  | { kind: 'navigate'; path: string }
  | { kind: 'unknown' }

export function parseDeepLinkUrl(urlStr: string): DeepLinkParsed {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'openagentd:') return { kind: 'unknown' }

    const host = url.host
    const pathname = url.pathname.replace(/^\/+/, '')
    const fullPath = host ? `${host}/${pathname}`.replace(/\/+$/, '') : pathname.replace(/\/+$/, '')

    if (fullPath.startsWith('auth/callback') || fullPath.startsWith('auth-callback')) {
      const provider = url.searchParams.get('provider') || 'codex'
      const rawCode = url.searchParams.get('code') || ''
      const state = url.searchParams.get('state')
      const code = state && !rawCode.includes('#') ? `${rawCode}#${state}` : rawCode
      return { kind: 'auth_callback', provider, code }
    }

    if (host === 'cockpit' || host === 'coding' || host === 'session') {
      const target = host === 'session' ? `/cockpit/${pathname}` : `/${host}/${pathname}`
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

export function useDeepLinkRouter(): void {
  const router = useRouter()
  const queryClient = useQueryClient()

  useEffect(() => {
    const handleUrl = async (urlStr: string) => {
      const parsed = parseDeepLinkUrl(urlStr)
      if (parsed.kind === 'auth_callback') {
        const ok = await processOAuthCallback(parsed.provider, parsed.code)
        if (ok) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
        }
      } else if (parsed.kind === 'navigate') {
        void router.navigate({ href: parsed.path })
      }
    }

    const customListener = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (typeof detail === 'string') {
        void handleUrl(detail)
      }
    }
    window.addEventListener('openagentd-deep-link', customListener)

    let unlisten: (() => void) | undefined
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<string>('deep-link', (event) => {
          if (event.payload) {
            void handleUrl(event.payload)
          }
        }).then((fn) => { unlisten = fn }).catch(() => {})
      }).catch(() => {})
    }

    return () => {
      window.removeEventListener('openagentd-deep-link', customListener)
      if (unlisten) unlisten()
    }
  }, [router, queryClient])
}
