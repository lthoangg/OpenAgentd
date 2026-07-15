/**
 * Desktop session token injection.
 *
 * When the app is launched inside the Tauri desktop shell, the shell
 * generates a per-launch random token and injects it into the page
 * via Tauri's `initialization_script`, which runs *before* any of our
 * JS evaluates:
 *
 *     window.__OAD_TOKEN__ = "<random>"
 *
 * The backend rejects protected /api/* requests that don't carry that token
 * in either `Authorization: Bearer …` or `?_token=…`.
 *
 * Rather than touch every `fetch('/api/…')` call site, we monkey-patch
 * `window.fetch` exactly once at boot to attach the header to same-origin
 * /api/* requests. This is invisible to the rest of the codebase, so the
 * web UI works identically in `bun dev` (no token, middleware disabled)
 * and inside the desktop shell (token attached automatically).
 *
 * The patch is a no-op when `__OAD_TOKEN__` is not set.
 */

import { apiBaseUrl } from './base-url'
import { getPlatform } from '@/hooks/use-platform'

declare global {
  interface Window {
    __OAD_TOKEN__?: string
  }
}

const TOKEN_KEY = '__OAD_TOKEN__'
const ACCESS_KEY_STORAGE = 'openagentd.accessKey'
const ACCESS_KEY_STORAGE_PREFIX = 'openagentd.accessKey:'
const nativeAccessKeys = new Map<string, string>()
const nativeAccessKeyMisses = new Set<string>()
const nativeAccessKeyReads = new Map<string, Promise<string | undefined>>()

function normalizeAccessKeyScope(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed, window.location.origin)
    return parsed.origin
  } catch {
    return null
  }
}

function accessKeyStorageKey(baseUrl: string | undefined): string | null {
  const scope = normalizeAccessKeyScope(baseUrl)
  return scope ? `${ACCESS_KEY_STORAGE_PREFIX}${scope}` : null
}

export function getAccessKey(baseUrl?: string): string | undefined {
  if (typeof window === 'undefined') return undefined
  const scopedKey = accessKeyStorageKey(baseUrl)
  if (scopedKey) {
    const scoped = window.localStorage.getItem(scopedKey)
    if (scoped) return scoped
  }
  return window.localStorage.getItem(ACCESS_KEY_STORAGE) || undefined
}

/** Uses the shell credential store when available; browsers and dev retain the
 * existing localStorage behavior. A legacy value is removed only after the
 * shell confirms its secure write. */
export async function getStoredAccessKey(baseUrl?: string): Promise<string | undefined> {
  const origin = normalizeAccessKeyScope(baseUrl)
  if (!origin || typeof window === 'undefined') return getAccessKey(baseUrl)
  if (!getPlatform().isTauri) return getAccessKey(baseUrl)
  const cached = nativeAccessKeys.get(origin)
  if (cached) return cached
  if (nativeAccessKeyMisses.has(origin)) return undefined
  const pending = nativeAccessKeyReads.get(origin)
  if (pending) return pending

  const read = (async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const stored = await invoke<string | null>('secure_get_access_key', { origin })
    if (stored) {
      nativeAccessKeys.set(origin, stored)
      nativeAccessKeyMisses.delete(origin)
      installDesktopAuth()
      return stored
    }
    const scopedLegacyKey = `${ACCESS_KEY_STORAGE_PREFIX}${origin}`
    const scopedLegacy = window.localStorage.getItem(scopedLegacyKey)
    const globalLegacy = window.localStorage.getItem(ACCESS_KEY_STORAGE)
    const legacyStorageKey = scopedLegacy ? scopedLegacyKey : globalLegacy ? ACCESS_KEY_STORAGE : null
    const legacy = scopedLegacy || globalLegacy
    if (legacy && legacyStorageKey) {
      await invoke('secure_set_access_key', { origin, key: legacy })
      nativeAccessKeys.set(origin, legacy)
      nativeAccessKeyMisses.delete(origin)
      installDesktopAuth()
      window.localStorage.removeItem(legacyStorageKey)
      return legacy
    }
    nativeAccessKeyMisses.add(origin)
    return undefined
  })()
  nativeAccessKeyReads.set(origin, read)
  try {
    return await read
  } finally {
    nativeAccessKeyReads.delete(origin)
  }
}

/** Load the active shell credential before application requests begin. */
export async function primeStoredAccessKey(baseUrl: string = apiBaseUrl()): Promise<void> {
  await getStoredAccessKey(baseUrl)
}

export async function setStoredAccessKey(key: string, baseUrl?: string): Promise<void> {
  const origin = normalizeAccessKeyScope(baseUrl)
  if (!origin || typeof window === 'undefined' || !getPlatform().isTauri) {
    setAccessKey(key, baseUrl)
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  if (key.trim()) {
    await invoke('secure_set_access_key', { origin, key: key.trim() })
    nativeAccessKeys.set(origin, key.trim())
    nativeAccessKeyMisses.delete(origin)
    installDesktopAuth()
  } else {
    await invoke('secure_delete_access_key', { origin })
    nativeAccessKeys.delete(origin)
    nativeAccessKeyMisses.add(origin)
  }
  window.localStorage.removeItem(`${ACCESS_KEY_STORAGE_PREFIX}${origin}`)
}

function getToken(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const origin = normalizeAccessKeyScope(apiBaseUrl())
  return window[TOKEN_KEY] || (origin ? nativeAccessKeys.get(origin) : undefined) || getAccessKey(apiBaseUrl()) || undefined
}

export function setAccessKey(key: string, baseUrl?: string): void {
  if (typeof window === 'undefined') return
  const trimmed = key.trim()
  const scopedKey = accessKeyStorageKey(baseUrl)
  if (trimmed) {
    if (scopedKey) {
      window.localStorage.setItem(scopedKey, trimmed)
    } else {
      window.localStorage.setItem(ACCESS_KEY_STORAGE, trimmed)
    }
    installDesktopAuth()
    return
  }
  if (scopedKey) {
    window.localStorage.removeItem(scopedKey)
    return
  }
  window.localStorage.removeItem(ACCESS_KEY_STORAGE)
}

/**
 * Returns true if the URL is a protected endpoint on the backend origin.
 * The token must NEVER be attached to any other origin.
 */
function isLocalApiRequest(url: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const requestUrl = new URL(url, window.location.origin)
    const apiUrl = new URL(apiBaseUrl(), window.location.origin)
    return (
      requestUrl.origin === apiUrl.origin &&
      (requestUrl.pathname === apiUrl.pathname ||
        requestUrl.pathname.startsWith(`${apiUrl.pathname}/`))
    )
  } catch {
    return false
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

let installed = false

export function installDesktopAuth(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return
  if (!getToken()) return // CLI / dev — middleware disabled, nothing to do

  installed = true
  const originalFetch = window.fetch.bind(window)

  window.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlOf(input)
    if (!isLocalApiRequest(url)) {
      return originalFetch(input, init)
    }
    const token = getToken()
    if (!token) return originalFetch(input, init)

    // ── Case 1: input is a Request object ────────────────────────────────
    // We MUST NOT pass `{ ...init, headers }` as init for a Request input —
    // that drops method, body, mode, credentials, signal, etc. Instead,
    // build a new Request from the original (which copies all of those)
    // and override only the headers.
    if (input instanceof Request) {
      // Compose: existing Request headers ⊕ init.headers override.
      const headers = new Headers(input.headers)
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => headers.set(k, v))
      }
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      // Strip headers from init so we don't double-set; the new Request
      // already carries them.
      const { headers: _omit, ...rest } = init ?? {}
      void _omit
      return originalFetch(new Request(input, { headers }), rest)
    }

    // ── Case 2: input is a string or URL ─────────────────────────────────
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return originalFetch(input, { ...init, headers })
  }) as typeof fetch

  installXhrInterceptor()
}

/**
 * Patch ``XMLHttpRequest`` for any library that still uses XHR
 * (older analytics SDKs, some MCP transports). The fetch monkey-patch
 * does not cover them.
 *
 * We capture the URL at ``open()`` time and, if it points at our
 * /api/* surface, attach ``Authorization: Bearer <token>`` just before
 * ``send()`` runs.
 */
function installXhrInterceptor(): void {
  if (typeof XMLHttpRequest === 'undefined') return

  const xhrProto = XMLHttpRequest.prototype
  const origOpen = xhrProto.open
  const origSend = xhrProto.send

  const URL_PROP = Symbol('oad-url')
  const AUTH_SET = Symbol('oad-auth-set')

  // We can't override readonly props on XHR via TS easily — escape via any.
  type AnyXhr = XMLHttpRequest & {
    [URL_PROP]?: string
    [AUTH_SET]?: boolean
  }

  xhrProto.open = function (
    this: AnyXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    this[URL_PROP] = typeof url === 'string' ? url : url.toString()
    this[AUTH_SET] = false
    // Forward the actual call. The signature of XHR.open is variadic
    // (async, user, password) — pass through unchanged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origOpen.apply(this, [method, url, ...rest] as any)
  } as typeof xhrProto.open

  const origSetHeader = xhrProto.setRequestHeader
  xhrProto.setRequestHeader = function (
    this: AnyXhr,
    name: string,
    value: string,
  ): void {
    if (name.toLowerCase() === 'authorization') {
      this[AUTH_SET] = true
    }
    return origSetHeader.call(this, name, value)
  }

  xhrProto.send = function (
    this: AnyXhr,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const url = this[URL_PROP]
    const token = getToken()
    if (token && url && isLocalApiRequest(url) && !this[AUTH_SET]) {
      try {
        origSetHeader.call(this, 'Authorization', `Bearer ${token}`)
      } catch {
        // setRequestHeader throws if readyState != OPENED — ignore.
      }
    }
    return origSend.call(this, body)
  }
}

/**
 * For raw URLs that must carry the token in the query string (e.g.
 * `<a download href="/api/...">` links the browser can't add headers to).
 */
export function withTokenParam(url: string): string {
  const token = getToken()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_token=${encodeURIComponent(token)}`
}

export function isDesktopMode(): boolean {
  if (typeof window === 'undefined') return false
  return window[TOKEN_KEY] !== undefined || Boolean(window.localStorage.getItem(ACCESS_KEY_STORAGE))
}
