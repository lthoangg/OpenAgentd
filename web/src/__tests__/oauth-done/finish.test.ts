/** `oauth-done.html`: finishing a sign-in the relay page sent back. */
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

import { finishSignInFromPage } from '@/oauth-done/finish'

const server = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  server.listen({ onUnhandledFrame: 'error' })
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch!(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init)) as typeof fetch
})

afterEach(() => {
  server.resetHandlers()
  server.close()
  if (originalFetch) globalThis.fetch = originalFetch
})

const STATE = `r.${btoa(JSON.stringify({ v: 1, server: 'notion', return_to: 'x' }))}`

it('says which connector it signed in to', async () => {
  server.use(http.post('http://localhost/api/mcp/oauth/finish', () => HttpResponse.json({ status: 'done', name: 'notion' })))
  const r = await finishSignInFromPage(`?code=c&state=${encodeURIComponent(STATE)}`)
  expect(r).toEqual({ ok: true, title: 'Signed in to notion', detail: 'You can close this window and go back to OpenAgentd.' })
})

it('shows why the server refused the code', async () => {
  server.use(http.post('http://localhost/api/mcp/oauth/finish', () => HttpResponse.json({ detail: 'This sign-in has expired or already finished. Start it again.' }, { status: 409 })))
  const r = await finishSignInFromPage(`?code=c&state=${encodeURIComponent(STATE)}`)
  expect(r.ok).toBe(false)
  expect(r.detail).toContain('expired')
})

it('has nothing to finish without a code', async () => {
  expect((await finishSignInFromPage('')).title).toBe('Nothing to finish')
})
