import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { closePreview, isLocalBackend, isLoopbackHost, lastPreviewUrl, openPreview, previewMode, previewTargetKey } from '@/api/preview'

const invokeMock = mock(async (..._args: unknown[]) => ({ port: 61000, origin: 'http://127.0.0.1:61000' }))
mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const originalFetch = globalThis.fetch

function info(port: number) {
  return { id: 'p1', workspace: '/ws', kind: 'url', target: 'http://localhost:5173', port, origin: `http://127.0.0.1:${port}`, path: '/', url: `http://127.0.0.1:${port}/`, console_errors: 0 }
}

describe('openPreview', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('posts the target and reuses the last port for it next time', async () => {
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = mock(async (url: unknown, raw: unknown) => {
      const init = raw as RequestInit | undefined
      expect(String(url)).toContain('/api/preview')
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(info(52011)), { status: 200 })
    }) as typeof fetch

    const first = await openPreview('/ws', { kind: 'url', url: 'http://localhost:5173/pricing' })
    expect(first.origin).toBe('http://127.0.0.1:52011')
    await openPreview('/ws', { kind: 'url', url: 'http://localhost:5173/other' })
    expect(bodies[0]).toEqual({ workspace: '/ws', url: 'http://localhost:5173/pricing' })
    expect(bodies[1]).toEqual({ workspace: '/ws', url: 'http://localhost:5173/other', preferred_port: 52011 })
    expect(lastPreviewUrl('/ws')).toBe('http://localhost:5173/other')
  })

  it('sends workspace files as a path', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = mock(async (_url: unknown, raw: unknown) => {
      const init = raw as RequestInit | undefined
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ...info(52012), kind: 'file' }), { status: 200 })
    }) as typeof fetch
    await openPreview('/ws', { kind: 'file', path: 'designs/a.html' })
    expect(body).toEqual({ workspace: '/ws', path: 'designs/a.html' })
  })

  it('surfaces the server detail', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ detail: 'Only local servers can be previewed.' }), { status: 422 })) as typeof fetch
    await expect(openPreview('/ws', { kind: 'url', url: 'http://example.com' })).rejects.toThrow('Only local servers can be previewed.')
  })

  describe('through the native relay', () => {
    const win = window as { __OAD_API_BASE_URL__?: string; __TAURI_INTERNALS__?: unknown }
    beforeEach(() => {
      win.__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
      win.__TAURI_INTERNALS__ = {}
      invokeMock.mockClear()
    })
    afterEach(() => {
      delete win.__OAD_API_BASE_URL__
      delete win.__TAURI_INTERNALS__
    })

    it('frames the relay origin and keeps the server port for next time', async () => {
      const bodies: Record<string, unknown>[] = []
      globalThis.fetch = mock(async (_url: unknown, raw: unknown) => {
        bodies.push(JSON.parse(String((raw as RequestInit).body)))
        return new Response(JSON.stringify({ ...info(52011), path: '/pricing' }), { status: 200 })
      }) as typeof fetch
      const opened = await openPreview('/ws', { kind: 'url', url: 'http://localhost:5173/pricing' })
      expect(invokeMock).toHaveBeenCalledWith('preview_relay_open', { previewId: 'p1', port: 52011 })
      expect(opened.origin).toBe('http://127.0.0.1:61000')
      expect(opened.url).toBe('http://127.0.0.1:61000/pricing')
      expect(opened.port).toBe(52011)
      await openPreview('/ws', { kind: 'url', url: 'http://localhost:5173/pricing' })
      expect(bodies[1].preferred_port).toBe(52011)
    })

    it('closes the relay with the preview', async () => {
      globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as typeof fetch
      await closePreview('p1')
      await new Promise((r) => setTimeout(r, 0))
      expect(invokeMock).toHaveBeenCalledWith('preview_relay_close', { previewId: 'p1' })
    })
  })

  it('treats a missing preview as already closed', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ detail: 'Preview not found.' }), { status: 404 })) as typeof fetch
    await expect(closePreview('gone')).resolves.toBeUndefined()
  })
})

describe('preview helpers', () => {
  afterEach(() => {
    delete (window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__
  })

  it('recognises loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.3.2.1', '[::1]']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['192.168.1.4', 'example.com', 'localhost.example.com']) expect(isLoopbackHost(h)).toBe(false)
  })

  it('knows when the backend is on this computer', () => {
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'http://127.0.0.1:4082'
    expect(isLocalBackend()).toBe(true)
    ;(window as { __OAD_API_BASE_URL__?: string }).__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
    expect(isLocalBackend()).toBe(false)
  })

  it('previews directly, through the app relay, or not at all', () => {
    const win = window as { __OAD_API_BASE_URL__?: string; __TAURI_INTERNALS__?: unknown }
    win.__OAD_API_BASE_URL__ = 'http://127.0.0.1:4082'
    expect(previewMode()).toBe('direct')
    win.__OAD_API_BASE_URL__ = 'http://192.168.1.20:4082'
    expect(previewMode()).toBe('unavailable')
    win.__TAURI_INTERNALS__ = {}
    expect(previewMode()).toBe('relay')
    delete win.__TAURI_INTERNALS__
  })

  it('keys url targets by origin', () => {
    expect(previewTargetKey({ kind: 'url', url: 'http://localhost:5173/a?b' })).toBe('url:http://localhost:5173')
    expect(previewTargetKey({ kind: 'url', url: 'localhost:3000' })).toBe('url:http://localhost:3000')
    expect(previewTargetKey({ kind: 'file', path: 'a.html' })).toBe('file:a.html')
  })
})
