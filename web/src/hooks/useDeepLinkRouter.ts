import { useEffect } from 'react'
import { useRouter } from '@tanstack/react-router'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { apiBaseUrl } from '@/api/base-url'
import { withTokenParam } from '@/api/auth'
import { useToastStore } from '@/stores/useToastStore'
import { useUIStore } from '@/stores/useUIStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { startNewSession } from '@/lib/new-session'
import { loadLastWorkspace } from '@/utils/workspace'
import { isMobileApp } from '@/lib/mobile-app'
import { deliveredKey, linkSequence } from '@/lib/link-sequence'
import { isTelemetryRange, type TelemetryRange } from '@/stores/useTelemetryStore'

/** Longest ``prompt`` a ``new`` link fills in; the rest is cut. */
export const DEEP_LINK_PROMPT_MAX = 8000

/**
 * The server a session link names: `srv` (the app's own opaque token, from
 * a home-screen widget), or `device` (an account computer) and `server` (an
 * address). Without one the link opens on the server in use; with a token
 * the app no longer knows, it opens nothing and says so.
 */
export interface DeepLinkServer {
  token?: string
  deviceId?: string
  baseUrl?: string
}

export type DeepLinkParsed =
  | { kind: 'auth_callback'; provider: string; code: string }
  /** A connector's sign-in code, sent on by the relay page (`openagentd://mcp-oauth?code=…&state=…`). */
  | { kind: 'mcp_oauth'; search: string }
  | { kind: 'navigate'; path: string; server?: DeepLinkServer }
  /**
   * A new-session draft (home-screen widget); in the last folder when
   * ``workspace`` is null, with ``prompt`` filled in (never sent) when set.
   */
  | { kind: 'new_session'; workspace: string | null; prompt?: string }
  /** The scheduler, on one task when ``task`` is set (home-screen widget). */
  | { kind: 'open_scheduler'; task: string | null }
  /** Settings, on ``section`` when set (an unknown one opens its first page). */
  | { kind: 'open_settings'; section: string | null }
  /** The telemetry view, on a range, trace or session when set. */
  | { kind: 'open_telemetry'; days?: TelemetryRange; traceId?: string; session?: string }
  | { kind: 'unknown' }

function nonEmptyParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim()
  return value ? value : null
}

function linkServer(url: URL): DeepLinkServer | undefined {
  const token = nonEmptyParam(url, 'srv')
  const deviceId = nonEmptyParam(url, 'device')
  const server = nonEmptyParam(url, 'server')
  let baseUrl: string | null = null
  if (server) {
    try {
      const parsed = new URL(server)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') baseUrl = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
    } catch {
      baseUrl = null
    }
  }
  if (!token && !deviceId && !baseUrl) return undefined
  return {
    ...(token ? { token } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  }
}

/**
 * Host and path of an ``openagentd://host/path`` link. Older Chromium (the
 * Android System WebView on many phones) parses a custom scheme as an empty
 * host and a ``//host/path`` pathname, so split that form by hand.
 */
export function deepLinkParts(url: Pick<URL, 'host' | 'pathname'>): { host: string; pathname: string } {
  if (url.host || !url.pathname.startsWith('//')) return { host: url.host, pathname: url.pathname }
  const rest = url.pathname.slice(2)
  const slash = rest.indexOf('/')
  return slash === -1
    ? { host: rest, pathname: '' }
    : { host: rest.slice(0, slash), pathname: rest.slice(slash) }
}

export function parseDeepLinkUrl(urlStr: string): DeepLinkParsed {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== 'openagentd:' && url.protocol !== 'openagentd-dev:') {
      return { kind: 'unknown' }
    }

    const parts = deepLinkParts(url)
    const host = parts.host
    const pathname = parts.pathname.replace(/^\/+/, '')

    if (host === 'auth' && parts.pathname === '/callback') {
      const provider = url.searchParams.get('provider')?.trim()
      const rawCode = url.searchParams.get('code')
      if (!provider || !rawCode?.trim()) return { kind: 'unknown' }

      const state = url.searchParams.get('state')
      const code = state && !rawCode.includes('#') ? `${rawCode}#${state}` : rawCode
      return { kind: 'auth_callback', provider, code }
    }

    if (host === 'mcp-oauth' && pathname === '') {
      return { kind: 'mcp_oauth', search: url.search }
    }

    if (host === 'session') {
      // One session id at most: other app paths have their own hosts.
      if (pathname.includes('/')) return { kind: 'unknown' }
      const target = `/${pathname}`.replace(/\/+$/, '')
      const server = target ? linkServer(url) : undefined
      return server ? { kind: 'navigate', path: target, server } : { kind: 'navigate', path: target || '/' }
    }

    // `/` reopens the last session, so a widget's "New session" needs its own host.
    if (host === 'new' && pathname === '') {
      const workspace = nonEmptyParam(url, 'workspace')
      const prompt = url.searchParams.get('prompt')
      return prompt?.trim()
        ? { kind: 'new_session', workspace, prompt: prompt.slice(0, DEEP_LINK_PROMPT_MAX) }
        : { kind: 'new_session', workspace }
    }

    if (host === 'scheduler' && pathname === '') {
      return { kind: 'open_scheduler', task: nonEmptyParam(url, 'task') }
    }

    if (host === 'settings' && !pathname.includes('/')) {
      return { kind: 'open_settings', section: pathname || null }
    }

    if (host === 'telemetry' && pathname === '') {
      const days = Number(nonEmptyParam(url, 'days'))
      const traceId = nonEmptyParam(url, 'traceId')
      const session = nonEmptyParam(url, 'session')
      return {
        kind: 'open_telemetry',
        ...(isTelemetryRange(days) ? { days } : {}),
        ...(traceId ? { traceId } : {}),
        ...(session ? { session } : {}),
      }
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

const DELIVERED_STORAGE_KEY = 'openagentd.deepLink.delivered'

/**
 * Links already handled in this app run. The plugin keeps reporting the last
 * opened URL from `getCurrent()` for the life of the app, so after a reload
 * (a server switch, or iOS ending the page in the background) it would open
 * the session again, start another draft, or repeat a one-time OAuth code.
 * sessionStorage survives those reloads; live `onOpenUrl` links always run.
 * A link is remembered with the shell's link count (`lib/link-sequence.ts`),
 * so a widget's row tapped again after iOS ended the page runs.
 */
function loadDelivered(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(DELIVERED_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function rememberDelivered(key: string): void {
  const delivered = loadDelivered().filter((known) => known !== key)
  delivered.push(key)
  try {
    window.sessionStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify(delivered.slice(-8)))
  } catch {
    // Storage unavailable: a reload may run the link again.
  }
}

async function listenToDeepLinks(onUrls: (urls: string[], replayed: boolean) => void): Promise<(() => void) | undefined> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  if (getCurrentWindow().label !== 'main') return undefined
  const stopListening = await onOpenUrl((urls) => { void onUrls(urls, false) })
  const initial = await getCurrent()
  if (initial) void onUrls(initial, true)
  return stopListening
}

/**
 * Open a session link that names its server on that server (phone: switch
 * first when needed). Returns false when the link is not for that, so the
 * caller navigates as usual.
 */
async function openOnLinkServer(path: string, server: DeepLinkServer | undefined): Promise<boolean> {
  if (!server || !isMobileApp()) return false
  const sessionId = /^\/([^/]+)$/.exec(path)?.[1]
  if (!sessionId) return false
  const [{ serverForToken }, { openSessionOnServer, sessionServerUnknown }] = await Promise.all([
    import('@/lib/server-refs'),
    import('@/lib/open-on-server'),
  ])
  const ref = server.token ? serverForToken(server.token) : { deviceId: server.deviceId, baseUrl: server.baseUrl }
  if (server.token && !ref) {
    await sessionServerUnknown()
    return true
  }
  if (!ref || (!ref.deviceId && !ref.baseUrl)) return false
  await openSessionOnServer({
    sessionId: decodeURIComponent(sessionId),
    ...(ref.deviceId ? { deviceId: ref.deviceId } : {}),
    ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}),
  })
  return true
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
      } else if (parsed.kind === 'mcp_oauth') {
        if (handledOAuthCallbacks.has(parsed.search)) return
        handledOAuthCallbacks.add(parsed.search)
        const { finishSignInFromPage } = await import('@/oauth-done/finish')
        const result = await finishSignInFromPage(parsed.search)
        void queryClient.invalidateQueries({ queryKey: queryKeys.mcp.all() })
        useToastStore.getState().push({ tone: result.ok ? 'success' : 'error', title: result.title, description: result.ok ? undefined : result.detail })
      } else if (parsed.kind === 'navigate') {
        if (await openOnLinkServer(parsed.path, parsed.server).catch(() => false)) return
        void router.navigate({ href: parsed.path })
      } else if (parsed.kind === 'new_session') {
        const workspace = parsed.workspace ?? loadLastWorkspace()?.path ?? null
        // The draft is what the link asked to see: no overlay left over it.
        useUIStore.getState().closeAll()
        useSettingsStore.getState().closeSettings()
        if (workspace) {
          if (parsed.prompt) useUIStore.getState().requestComposerPrefill(workspace, parsed.prompt)
          startNewSession({ navigate: router.navigate, workspace })
        } else {
          void router.navigate({ href: '/' })
        }
      } else if (parsed.kind === 'open_scheduler') {
        useUIStore.getState().requestSchedulerOpen(parsed.task)
      } else if (parsed.kind === 'open_settings') {
        // The /settings pages open the Settings modal and return to the workspace.
        void router.navigate({ href: parsed.section ? `/settings/${encodeURIComponent(parsed.section)}` : '/settings' })
      } else if (parsed.kind === 'open_telemetry') {
        const search = new URLSearchParams()
        if (parsed.days) search.set('days', String(parsed.days))
        if (parsed.traceId) search.set('traceId', parsed.traceId)
        if (parsed.session) search.set('session', parsed.session)
        const query = search.toString()
        void router.navigate({ href: query ? `/telemetry?${query}` : '/telemetry' })
      }
    }

    let unlisten: (() => void) | undefined
    let disposed = false
    const handleUrls = async (urls: string[], replayed: boolean) => {
      const sequence = await linkSequence()
      const fresh = replayed ? urls.filter((url) => !loadDelivered().includes(deliveredKey(url, sequence))) : urls
      for (const url of fresh) rememberDelivered(deliveredKey(url, sequence))
      await Promise.all(fresh.map(handleUrl))
    }

    void listenToDeepLinks((urls, replayed) => {
      void handleUrls(urls, replayed)
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
