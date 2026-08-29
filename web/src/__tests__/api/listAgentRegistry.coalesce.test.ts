/**
 * `GET /agent/agents` request coalescing.
 *
 * The endpoint re-globs and re-parses every agent `.md` server-side per request,
 * and it has two independent callers that fire in the same window when a session
 * opens: the agent store's `loadAgentStatus()` (which cannot use TanStack) and the
 * header's `useAgentsQuery`. TanStack dedupes its own observers but knows
 * nothing about the store's direct call, so the client coalesces in-flight
 * requests per workspace.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { setApiBaseUrl } from '@/api/base-url'
import { listSessionAgents, agentStatus } from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function deferredFetch() {
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const fetchMock = mock(async (url: unknown) => {
    calls.push(String(url))
    await gate
    return new Response(JSON.stringify({
      agents: [{ name: 'code', description: '', model: 'm', tools: [] }],
    }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return { calls, release: () => release!(), fetchMock }
}

describe('listSessionAgents coalescing', () => {
  it('collapses concurrent calls for the same workspace into one request', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const a = listSessionAgents('/tmp/workspace')
    const b = listSessionAgents('/tmp/workspace')
    release()
    const [ra, rb] = await Promise.all([a, b])

    expect(calls).toHaveLength(1)
    // Same settled value handed to both callers.
    expect(ra).toBe(rb)
  })

  it('shares one request between the store path (agentStatus) and the query path', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const viaStore = agentStatus('/tmp/workspace')
    const viaQuery = listSessionAgents('/tmp/workspace')
    release()
    const [status, agents] = await Promise.all([viaStore, viaQuery])

    expect(calls).toHaveLength(1)
    expect(status?.lead.name).toBe('code')
    expect(agents.agents).toHaveLength(1)
  })

  it('keeps separate requests per workspace', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const a = listSessionAgents('/ws-one')
    const b = listSessionAgents('/ws-two')
    release()
    await Promise.all([a, b])

    expect(calls).toHaveLength(2)
  })

  it('does not cache responses — a later call refetches', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const first = listSessionAgents('/tmp/workspace')
    release()
    await first

    const { calls: secondCalls, release: releaseSecond } = deferredFetch()
    const second = listSessionAgents('/tmp/workspace')
    releaseSecond()
    await second

    expect(calls).toHaveLength(1)
    expect(secondCalls).toHaveLength(1)
  })

  it('clears the in-flight entry after a failure so the next call retries', async () => {
    setApiBaseUrl('')
    globalThis.fetch = mock(async () =>
      new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch

    await expect(listSessionAgents('/tmp/workspace')).rejects.toBeDefined()
    // A stuck rejected promise would poison every later caller.
    await expect(listSessionAgents('/tmp/workspace')).rejects.toBeDefined()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
