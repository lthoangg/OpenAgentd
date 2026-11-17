/**
 * Connector sign-in from the device in hand: where the code comes back to,
 * what a returned address carries, and the start → wait flow against the
 * server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { codeFromReturn, deliverSignInCode, serverFromState, signInReturnTo, signInToMcpServer, waitForSignIn } from '@/lib/mcp-sign-in'

const server = setupServer()
let originalFetch: typeof fetch | undefined
let originalOpen: typeof window.open

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch!(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)) as typeof fetch
  originalOpen = window.open
})

afterEach(() => {
  server.resetHandlers()
  server.close()
  if (originalFetch) globalThis.fetch = originalFetch
  window.open = originalOpen
})

function state(info: object): string {
  return `rand.${btoa(JSON.stringify(info)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

describe('signInReturnTo', () => {
  it('is the oauth-done page beside the app in a browser', () => {
    expect(signInReturnTo({ origin: 'http://192.168.1.20:5173', pathname: '/abc-session' })).toBe('http://192.168.1.20:5173/oauth-done.html')
    expect(signInReturnTo({ origin: 'https://agent.example', pathname: '/app/index.html' })).toBe('https://agent.example/app/oauth-done.html')
  })
})

describe('a returned address', () => {
  it('gives its code, state and issuer', () => {
    expect(codeFromReturn(new URLSearchParams('code=c1&state=s1&iss=https%3A%2F%2Fas'))).toEqual({ code: 'c1', state: 's1', iss: 'https://as' })
  })

  it('gives the error a declined sign-in came back with', () => {
    expect(codeFromReturn(new URLSearchParams('error=access_denied&state=s1'))).toEqual({ error: 'access_denied', state: 's1' })
  })

  it('is nothing without a code and state', () => {
    expect(codeFromReturn(new URLSearchParams('code=c1'))).toBeNull()
  })

  it('names the server a relayed state is for', () => {
    expect(serverFromState(state({ v: 1, server: 'notion', return_to: 'openagentd://mcp-oauth' }))).toBe('notion')
    expect(serverFromState('plainrandom')).toBeNull()
    expect(serverFromState('rand.not-base64-json')).toBeNull()
  })
})

describe('deliverSignInCode', () => {
  it('hands the code to the server', async () => {
    let body: unknown = null
    server.use(http.post('http://localhost/api/mcp/oauth/finish', async ({ request }) => {
      body = await request.json()
      return HttpResponse.json({ status: 'done', name: 'notion', server: { name: 'notion', state: 'ready' } })
    }))
    const res = await deliverSignInCode({ code: 'c1', state: 's1', iss: null })
    expect(body).toEqual({ code: 'c1', state: 's1', iss: null })
    expect(res.name).toBe('notion')
  })

  it('cancels a sign-in the person declined at the service', async () => {
    let cancelled = false
    server.use(http.post('http://localhost/api/mcp/servers/notion/oauth/cancel', () => {
      cancelled = true
      return HttpResponse.json({ name: 'notion' })
    }))
    await expect(deliverSignInCode({ error: 'access_denied', state: state({ v: 1, server: 'notion', return_to: 'x' }) })).rejects.toThrow('declined')
    expect(cancelled).toBe(true)
  })
})

describe('signInToMcpServer', () => {
  it('opens the sign-in page in the window it opened on the click, then waits for the server', async () => {
    const popup = { opener: {}, closed: false, location: { href: '' }, close() { this.closed = true } }
    window.open = (() => popup) as unknown as typeof window.open
    let returnTo: string | null = null
    let polls = 0
    server.use(
      http.post('http://localhost/api/mcp/servers/notion/oauth/start', async ({ request }) => {
        returnTo = ((await request.json()) as { return_to: string }).return_to
        return HttpResponse.json({ status: 'sign_in', auth_url: 'https://mcp.notion.com/authorize?x=1', return: 'relay' })
      }),
      http.get('http://localhost/api/mcp/servers/notion/oauth/status', () => {
        polls += 1
        return HttpResponse.json(polls < 2 ? { status: 'waiting' } : { status: 'done', server: { name: 'notion', state: 'ready' } })
      }),
    )
    const p = signInToMcpServer('notion')
    const st = await p
    expect(popup.opener).toBeNull()
    expect(popup.location.href).toBe('https://mcp.notion.com/authorize?x=1')
    expect(String(returnTo).endsWith('/oauth-done.html')).toBe(true)
    expect(st.state).toBe('ready')
  })

  it('closes its window when the server connects without asking', async () => {
    const popup = { opener: {}, closed: false, location: { href: '' }, close() { this.closed = true } }
    window.open = (() => popup) as unknown as typeof window.open
    server.use(http.post('http://localhost/api/mcp/servers/docs/oauth/start', () => HttpResponse.json({ status: 'done', server: { name: 'docs', state: 'ready' } })))
    await signInToMcpServer('docs')
    expect(popup.closed).toBe(true)
  })

  it('reports a failed sign-in', async () => {
    server.use(http.get('http://localhost/api/mcp/servers/x/oauth/status', () => HttpResponse.json({ status: 'failed', error: 'Registration failed: 400' })))
    await expect(waitForSignIn('x', { pollMs: 1 })).rejects.toThrow('Registration failed')
  })
})
