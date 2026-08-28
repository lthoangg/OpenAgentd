/**
 * Tests for ``api/auth.ts`` — desktop session-token injection.
 *
 * This is a **security-critical** module: it attaches the per-launch
 * desktop token to every same-origin ``/api/*`` request. Bugs here
 * cause one of two equally-bad outcomes:
 *
 *   1. Token *leaks to cross-origin requests* → an attacker's third-party
 *      script could read it from outbound headers.
 *   2. Token *fails to attach* to legit ``/api`` calls → user-facing 401s.
 *
 * Key invariants we verify:
 *
 *   - ``installDesktopAuth()`` is a no-op when ``window.__OAD_TOKEN__``
 *     is not set (CLI / dev mode).
 *   - When a token IS set, ``fetch('/api/...')`` gains ``Authorization: Bearer <token>``.
 *   - ``fetch('https://example.com/...')`` MUST NOT get the header
 *     (cross-origin token leak prevention).
 *   - When the caller passes a ``Request`` object, the patch must
 *     reconstruct it with ``new Request(input, { headers })`` so that
 *     method/body/credentials/signal are preserved — this was a real
 *     audit finding (#23).
 *   - When the caller already set ``Authorization``, we do NOT overwrite
 *     it (let user code win).
 *   - The patch is idempotent — calling ``installDesktopAuth()`` twice
 *     does not double-wrap fetch.
 *   - The XHR interceptor: same rules, plus ``setRequestHeader`` after
 *     ``open()`` correctly opts out of the auto-injection.
 *   - ``withTokenParam()`` appends ``_token=`` to URLs in desktop mode,
 *     uses ``&`` vs ``?`` based on existing query string, and is a
 *     no-op without a token.
 *   - ``isDesktopMode()`` reflects whether ``__OAD_TOKEN__`` is set.
 *
 * Each test uses a fresh module import (``?nonce=...``) so the
 * ``installed`` flag and any monkey-patched globals don't leak between
 * cases. Originals are restored in ``afterEach``.
 */
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test"

const invoke = mock(async (..._args: unknown[]): Promise<unknown> => null)
mock.module('@tauri-apps/api/core', () => ({ invoke }))
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri: true }) }))

type AuthModule = typeof import("@/api/auth")

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open
const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send
const ORIGINAL_XHR_SET_HEADER = XMLHttpRequest.prototype.setRequestHeader

/**
 * Get a fresh copy of ``api/auth`` so the ``installed`` flag inside
 * the module is reset for each test.
 */
async function freshAuth(): Promise<AuthModule> {
  const path = `@/api/auth?nonce=${Math.random()}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import(/* @vite-ignore */ path as any)) as AuthModule
}

/** Restore *all* globals the module may have patched. */
function restoreGlobals(): void {
  globalThis.fetch = ORIGINAL_FETCH
  XMLHttpRequest.prototype.open = ORIGINAL_XHR_OPEN
  XMLHttpRequest.prototype.send = ORIGINAL_XHR_SEND
  XMLHttpRequest.prototype.setRequestHeader = ORIGINAL_XHR_SET_HEADER
}

/** Replace ``window.fetch`` with a spy that records call args + returns OK. */
function spyFetch(): {
  fn: typeof fetch
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>
} {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  // Bun's ``mock`` generic constraint chokes on the ``RequestInfo | URL``
  // union, so cast through ``unknown`` rather than fighting the inference.
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch
  globalThis.fetch = fn
  window.fetch = fn
  return { fn, calls }
}

// The test setup (``__tests__/setup.ts``) configures happy-dom with
// ``url: "http://localhost:5173/"`` so ``window.location.origin`` is a
// real string and same-origin URL parsing works inside the patched
// fetch + XHR paths.

beforeEach(() => {
  // Wipe any token from a prior test.
  delete (window as { __OAD_TOKEN__?: string }).__OAD_TOKEN__
  window.localStorage.clear()
  invoke.mockClear()
})

afterEach(() => {
  restoreGlobals()
  delete (window as { __OAD_TOKEN__?: string }).__OAD_TOKEN__
  window.localStorage.clear()
})

// ════════════════════════════════════════════════════════════════════════════
//  installDesktopAuth — gating
// ════════════════════════════════════════════════════════════════════════════
describe("access key storage", () => {
  it("deduplicates concurrent native reads and reuses the cached credential", async () => {
    let resolveRead!: (value: string | null) => void
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]) !== 'secure_get_access_key') return undefined
      return await new Promise<string | null>((resolve) => { resolveRead = resolve })
    })
    const auth = await freshAuth()

    const first = auth.getStoredAccessKey('https://example.com/api')
    const second = auth.getStoredAccessKey('https://example.com/api')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke.mock.calls.filter((call: unknown[]) => call[0] === 'secure_get_access_key')).toHaveLength(1)

    resolveRead('native-key')
    await expect(Promise.all([first, second])).resolves.toEqual(['native-key', 'native-key'])
    await expect(auth.getStoredAccessKey('https://example.com/api')).resolves.toBe('native-key')
    expect(invoke.mock.calls.filter((call: unknown[]) => call[0] === 'secure_get_access_key')).toHaveLength(1)
  })

  it("migrates a scoped key only after native storage succeeds and caches it for requests", async () => {
    window.localStorage.setItem('openagentd.accessKey:https://example.com', 'legacy-key')
    invoke.mockImplementation(async (...args: unknown[]) => String(args[0]) === 'secure_get_access_key' ? null : undefined)
    const auth = await freshAuth()

    await expect(auth.getStoredAccessKey('https://example.com/api')).resolves.toBe('legacy-key')
    expect(invoke).toHaveBeenCalledWith('secure_set_access_key', { origin: 'https://example.com', key: 'legacy-key' })
    expect(window.localStorage.getItem('openagentd.accessKey:https://example.com')).toBeNull()
  })

  it('keeps legacy storage when native migration fails', async () => {
    window.localStorage.setItem('openagentd.accessKey:https://example.com', 'legacy-key')
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]) === 'secure_get_access_key') return null
      throw new Error('store unavailable')
    })
    const auth = await freshAuth()

    await expect(auth.getStoredAccessKey('https://example.com')).rejects.toThrow('store unavailable')
    expect(window.localStorage.getItem('openagentd.accessKey:https://example.com')).toBe('legacy-key')
  })

  it('migrates the pre-scoping global key for an explicitly selected saved server', async () => {
    window.localStorage.setItem('openagentd.accessKey', 'legacy-global-key')
    invoke.mockImplementation(async (...args: unknown[]) => String(args[0]) === 'secure_get_access_key' ? null : undefined)
    const auth = await freshAuth()

    await expect(auth.getStoredAccessKey('http://192.168.1.20:4082')).resolves.toBe('legacy-global-key')
    expect(invoke).toHaveBeenCalledWith('secure_set_access_key', {
      origin: 'http://192.168.1.20:4082',
      key: 'legacy-global-key',
    })
    expect(window.localStorage.getItem('openagentd.accessKey')).toBeNull()
  })

  it("stores and retrieves access keys per backend origin", async () => {
    const auth = await freshAuth()

    auth.setAccessKey('alpha', 'http://127.0.0.1:4082')
    auth.setAccessKey('beta', 'http://192.168.1.20:4082')

    expect(auth.getAccessKey('http://127.0.0.1:4082')).toBe('alpha')
    expect(auth.getAccessKey('http://192.168.1.20:4082')).toBe('beta')
    expect(auth.getAccessKey('http://127.0.0.1:4999')).toBeUndefined()
  })

  it("falls back to the legacy global key when no per-backend key exists", async () => {
    window.localStorage.setItem('openagentd.accessKey', 'legacy-secret')
    const auth = await freshAuth()

    expect(auth.getAccessKey('http://127.0.0.1:4082')).toBe('legacy-secret')
  })

  it("removes only the targeted backend key when cleared", async () => {
    const auth = await freshAuth()

    auth.setAccessKey('alpha', 'http://127.0.0.1:4082')
    auth.setAccessKey('beta', 'http://192.168.1.20:4082')
    auth.setAccessKey('', 'http://127.0.0.1:4082')

    expect(auth.getAccessKey('http://127.0.0.1:4082')).toBeUndefined()
    expect(auth.getAccessKey('http://192.168.1.20:4082')).toBe('beta')
  })

  it("prefers origin-scoped access key over bundled sidecar token", async () => {
    window.__OAD_TOKEN__ = "sidecar-token"
    const auth = await freshAuth()
    auth.setAccessKey("external-secret-key", "http://192.168.1.50:4082")

    expect(auth.getToken("http://192.168.1.50:4082/api/session/status")).toBe("external-secret-key")
    expect(auth.getToken("http://127.0.0.1:4082/api/session/status")).toBe("sidecar-token")
  })

  it("injects external access key on requests when connected to external backend", async () => {
    window.__OAD_TOKEN__ = "sidecar-token"
    window.__OAD_API_BASE_URL__ = "http://192.168.1.50:4082"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.setAccessKey("external-secret-key", "http://192.168.1.50:4082")
    auth.installDesktopAuth()

    await window.fetch("http://192.168.1.50:4082/api/health/ready")

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer external-secret-key")
    delete window.__OAD_API_BASE_URL__
  })

  it("resolves external access key for relative /api paths and withTokenParam", async () => {
    window.__OAD_API_BASE_URL__ = "http://192.168.1.50:4082"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.setAccessKey("external-secret-key", "http://192.168.1.50:4082")
    auth.installDesktopAuth()

    expect(auth.getToken("/api/session/status")).toBe("external-secret-key")
    expect(auth.withTokenParam("/api/session/workspace/files/read?path=note.txt")).toBe(
      "/api/session/workspace/files/read?path=note.txt&_token=external-secret-key",
    )

    await window.fetch("/api/session/status")
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer external-secret-key")
    delete window.__OAD_API_BASE_URL__
  })
})

describe("installDesktopAuth — no token", () => {
  it("is a no-op when __OAD_TOKEN__ is not set", async () => {
    const { fn, calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()
    // The exported fetch reference should be unchanged.
    expect(window.fetch).toBe(fn)
    await window.fetch("/api/session/status")
    // Header must not have been injected.
    expect(calls[0]?.init?.headers).toBeUndefined()
  })

  it("does nothing if token is empty string", async () => {
    window.__OAD_TOKEN__ = ""
    const { fn } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()
    // Empty string is falsy → no install.
    expect(window.fetch).toBe(fn)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  installDesktopAuth — fetch with string URL
// ════════════════════════════════════════════════════════════════════════════
describe("installDesktopAuth — fetch with string URL", () => {
  it("attaches Bearer header to relative /api/* paths", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/api/session/status")

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tok-abc")
  })

  it("attaches header to absolute same-origin /api/* URL", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch(`${window.location.origin}/api/session/status`)

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tok-abc")
  })

  it("does NOT attach to /static/, /assets/, or other non-/api/ paths", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/assets/app.js")
    await window.fetch("/favicon.ico")

    for (const c of calls) {
      const h = new Headers(c.init?.headers)
      expect(h.get("Authorization")).toBeNull()
    }
  })

  it("does NOT attach to cross-origin URLs (token-leak prevention)", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("https://evil.example.com/api/exfiltrate")

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBeNull()
  })

  it("does not overwrite a pre-existing Authorization header on init", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/api/session/status", {
      headers: { Authorization: "Bearer custom" },
    })

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer custom")
  })

  it("merges with caller-supplied non-Authorization headers", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/api/session/status", {
      headers: { "X-Trace-Id": "abc123" },
    })

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tok-abc")
    expect(headers.get("X-Trace-Id")).toBe("abc123")
  })

  it("matches the bare /api path (no trailing slash)", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/api")

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tok-abc")
  })

  it("treats a path /api-fake as cross-origin-like (NO token)", async () => {
    // ``startsWith('/api/')`` requires the trailing slash — a clever
    // ``/api-fake`` path must not get auth.
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    await window.fetch("/api-fake")

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBeNull()
  })

  it("accepts URL objects pointing at /api/*", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const url = new URL("/api/session/status", window.location.origin)
    await window.fetch(url)

    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tok-abc")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  installDesktopAuth — fetch with Request object (audit fix #23)
// ════════════════════════════════════════════════════════════════════════════
describe("installDesktopAuth — fetch with Request input", () => {
  it("preserves method (POST) when reconstructing the Request", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("/api/foo", { method: "POST", body: "hello" })
    await window.fetch(req)

    // The downstream fetch must have received a Request, NOT a string.
    expect(calls[0].input).toBeInstanceOf(Request)
    expect((calls[0].input as Request).method).toBe("POST")
  })

  it("preserves Authorization on the Request's own headers", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("/api/foo", {
      method: "POST",
      headers: { Authorization: "Bearer existing" },
    })
    await window.fetch(req)

    const downstream = calls[0].input as Request
    expect(downstream.headers.get("Authorization")).toBe("Bearer existing")
  })

  it("injects Authorization when Request has no auth header", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("/api/foo", { method: "GET" })
    await window.fetch(req)

    const downstream = calls[0].input as Request
    expect(downstream.headers.get("Authorization")).toBe("Bearer tok-abc")
  })

  it("init.headers override wins over Request.headers (Headers merge order)", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("/api/foo", {
      method: "POST",
      headers: { "X-Trace-Id": "from-request" },
    })
    await window.fetch(req, {
      headers: { "X-Trace-Id": "from-init" },
    })

    const downstream = calls[0].input as Request
    expect(downstream.headers.get("X-Trace-Id")).toBe("from-init")
  })

  it("does not double-set headers (strips init.headers after merging)", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("/api/foo", { method: "GET" })
    await window.fetch(req, { headers: { "X-Test": "1" } })

    // The init forwarded to originalFetch must NOT carry headers
    // (they'd be duplicates of what the new Request already has).
    expect(calls[0].init?.headers).toBeUndefined()
  })

  it("does NOT inject Bearer for a cross-origin Request", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    const { calls } = spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const req = new Request("https://evil.example.com/api/exfiltrate", { method: "POST" })
    await window.fetch(req)

    // For cross-origin we short-circuit before touching headers, so
    // the input is the original Request, unmodified.
    expect(calls[0].input).toBe(req)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  Idempotency
// ════════════════════════════════════════════════════════════════════════════
describe("installDesktopAuth — idempotency", () => {
  it("does not double-wrap fetch when called twice", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const auth = await freshAuth()
    auth.installDesktopAuth()
    const wrapped = window.fetch
    auth.installDesktopAuth()
    // Second call must be a no-op — same wrapped function reference.
    expect(window.fetch).toBe(wrapped)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  XHR interceptor
// ════════════════════════════════════════════════════════════════════════════
/**
 * Wrap ``XMLHttpRequest.prototype.setRequestHeader`` **before** the
 * auth module installs its patch, so that:
 *
 *   - The auth module captures *our spy* as ``origSetHeader``.
 *   - Every call (auto-injected from inside the patched send AND
 *     manual ones from the test) flows through our recorder.
 *
 * This must be set up BEFORE ``installDesktopAuth()`` runs.
 */
function preInstallXhrHeaderSpy(): {
  headers: Array<[string, string]>
} {
  const headers: Array<[string, string]> = []
  const real = XMLHttpRequest.prototype.setRequestHeader
  XMLHttpRequest.prototype.setRequestHeader = function (n: string, v: string) {
    headers.push([n, v])
    return real.call(this, n, v)
  }
  return { headers }
}

function stubXhrSend(): void {
  XMLHttpRequest.prototype.send = function () {}
}

describe("installDesktopAuth — XHR interceptor", () => {
  it("injects Authorization on /api/* XHR requests", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const { headers } = preInstallXhrHeaderSpy()
    stubXhrSend()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const xhr = new XMLHttpRequest()
    xhr.open("GET", "/api/session/status")
    xhr.send()

    const auths = headers.filter(([n]) => n.toLowerCase() === "authorization")
    expect(auths.length).toBe(1)
    expect(auths[0][1]).toBe("Bearer tok-abc")
  })

  it("does NOT inject when caller already set Authorization manually", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const { headers } = preInstallXhrHeaderSpy()
    stubXhrSend()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const xhr = new XMLHttpRequest()
    xhr.open("GET", "/api/session/status")
    xhr.setRequestHeader("Authorization", "Bearer manual")
    xhr.send()

    const auths = headers.filter(([n]) => n.toLowerCase() === "authorization")
    expect(auths.length).toBe(1)
    expect(auths[0][1]).toBe("Bearer manual")
  })

  it("does NOT inject for cross-origin XHR", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const { headers } = preInstallXhrHeaderSpy()
    stubXhrSend()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const xhr = new XMLHttpRequest()
    xhr.open("GET", "https://evil.example.com/api/exfil")
    xhr.send()

    const auths = headers.filter(([n]) => n.toLowerCase() === "authorization")
    expect(auths.length).toBe(0)
  })

  it("does NOT inject on non-/api/ XHR paths", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const { headers } = preInstallXhrHeaderSpy()
    stubXhrSend()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const xhr = new XMLHttpRequest()
    xhr.open("GET", "/assets/app.js")
    xhr.send()

    const auths = headers.filter(([n]) => n.toLowerCase() === "authorization")
    expect(auths.length).toBe(0)
  })

  it("accepts URL objects passed to open()", async () => {
    window.__OAD_TOKEN__ = "tok-abc"
    spyFetch()
    const { headers } = preInstallXhrHeaderSpy()
    stubXhrSend()
    const auth = await freshAuth()
    auth.installDesktopAuth()

    const xhr = new XMLHttpRequest()
    xhr.open("GET", new URL("/api/x", window.location.origin))
    xhr.send()

    const auths = headers.filter(([n]) => n.toLowerCase() === "authorization")
    expect(auths.length).toBe(1)
    expect(auths[0][1]).toBe("Bearer tok-abc")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  withTokenParam
// ════════════════════════════════════════════════════════════════════════════
describe("withTokenParam", () => {
  it("returns the URL unchanged when no token is set", async () => {
    const auth = await freshAuth()
    expect(auth.withTokenParam("/api/files/x")).toBe("/api/files/x")
  })

  it("appends _token= with ? when no query string is present", async () => {
    window.__OAD_TOKEN__ = "abc"
    const auth = await freshAuth()
    expect(auth.withTokenParam("/api/files/x")).toBe("/api/files/x?_token=abc")
  })

  it("appends _token= with & when a query string is already present", async () => {
    window.__OAD_TOKEN__ = "abc"
    const auth = await freshAuth()
    expect(auth.withTokenParam("/api/files/x?foo=1")).toBe(
      "/api/files/x?foo=1&_token=abc",
    )
  })

  it("URL-encodes token characters that have special meaning", async () => {
    window.__OAD_TOKEN__ = "a b+c/d=e"
    const auth = await freshAuth()
    const got = auth.withTokenParam("/api/files/x")
    // Space → %20, + → %2B, / → %2F, = → %3D
    expect(got).toBe("/api/files/x?_token=a%20b%2Bc%2Fd%3De")
  })

  it("does not double-add when called twice (caller's responsibility, but we don't re-parse)", async () => {
    window.__OAD_TOKEN__ = "abc"
    const auth = await freshAuth()
    const once = auth.withTokenParam("/api/files/x")
    const twice = auth.withTokenParam(once)
    // ``withTokenParam`` is deliberately dumb — it doesn't dedupe.
    // This test documents that. If we ever add dedupe, flip it.
    expect(twice).toBe("/api/files/x?_token=abc&_token=abc")
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  isDesktopMode
// ════════════════════════════════════════════════════════════════════════════
describe("isDesktopMode", () => {
  it("is false when __OAD_TOKEN__ is unset", async () => {
    const auth = await freshAuth()
    expect(auth.isDesktopMode()).toBe(false)
  })

  it("is true when __OAD_TOKEN__ is a non-empty string", async () => {
    window.__OAD_TOKEN__ = "abc"
    const auth = await freshAuth()
    expect(auth.isDesktopMode()).toBe(true)
  })

  it("is true even for empty-string token (token is *defined*, just blank)", async () => {
    // The current contract is: ``getToken() !== undefined`` — an empty
    // string still counts as "desktop mode" even though the install
    // path treats it as no-op. This test pins that semantics so a
    // future refactor doesn't change behaviour silently.
    window.__OAD_TOKEN__ = ""
    const auth = await freshAuth()
    expect(auth.isDesktopMode()).toBe(true)
  })
})
