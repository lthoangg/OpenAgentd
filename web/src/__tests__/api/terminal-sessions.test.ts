import { afterEach, describe, expect, it, mock } from 'bun:test'

import { deleteTerminalSession, listTerminalSessions } from '@/api/terminal-sessions'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('listTerminalSessions', () => {
  it('queries by workspace and returns sessions oldest first', async () => {
    let url = ''
    globalThis.fetch = mock(async (u: unknown) => {
      url = String(u)
      return new Response(
        JSON.stringify({
          sessions: [
            { session_id: 'b', workspace: '/a b', created_at: 20, attached: false, busy: false },
            { session_id: 'a', workspace: '/a b', created_at: 10, attached: true, busy: true },
          ],
        }),
      )
    }) as unknown as typeof fetch
    const list = await listTerminalSessions('/a b')
    expect(url).toContain('/api/terminal/sessions?workspace=%2Fa%20b')
    expect(list.map((s) => s.session_id)).toEqual(['a', 'b'])
  })

  it('an old server (404) is an empty list; other failures throw', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    expect(await listTerminalSessions('/w')).toEqual([])
    globalThis.fetch = mock(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    await expect(listTerminalSessions('/w')).rejects.toThrow('500')
  })
})

describe('deleteTerminalSession', () => {
  it('DELETEs the session; 204 and 404 both succeed', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    globalThis.fetch = mock((async (u: unknown, init?: RequestInit) => {
      calls.push({ url: String(u), method: init?.method })
      return new Response(null, { status: calls.length === 1 ? 204 : 404 })
    }) as (...args: unknown[]) => unknown) as unknown as typeof fetch
    await deleteTerminalSession('sess/1')
    await deleteTerminalSession('sess/1')
    expect(calls[0]).toEqual({ url: expect.stringContaining('/api/terminal/sessions/sess%2F1'), method: 'DELETE' })
    expect(calls).toHaveLength(2)
  })

  it('other failures throw', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    await expect(deleteTerminalSession('x')).rejects.toThrow('500')
  })
})
