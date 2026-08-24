/**
 * `GET /team/agents` request coalescing.
 *
 * The endpoint re-globs and re-parses every agent `.md` server-side per request,
 * and it has two independent callers that fire in the same window when a session
 * opens: the team store's `loadTeamStatus()` (which cannot use TanStack) and the
 * header's `useTeamAgentsQuery`. TanStack dedupes its own observers but knows
 * nothing about the store's direct call, so the client coalesces in-flight
 * requests per workspace.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { setApiBaseUrl } from '@/api/base-url'
import { listTeamAgents, teamStatus } from '@/api/client'

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
      agents: [{ name: 'lead', is_lead: true, model: 'm' }],
      blueprints: [],
    }))
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return { calls, release: () => release!(), fetchMock }
}

describe('listTeamAgents coalescing', () => {
  it('collapses concurrent calls for the same workspace into one request', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const a = listTeamAgents('/tmp/workspace')
    const b = listTeamAgents('/tmp/workspace')
    release()
    const [ra, rb] = await Promise.all([a, b])

    expect(calls).toHaveLength(1)
    // Same settled value handed to both callers.
    expect(ra).toBe(rb)
  })

  it('shares one request between the store path (teamStatus) and the query path', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const viaStore = teamStatus('/tmp/workspace')
    const viaQuery = listTeamAgents('/tmp/workspace')
    release()
    const [status, agents] = await Promise.all([viaStore, viaQuery])

    expect(calls).toHaveLength(1)
    expect(status?.lead.name).toBe('lead')
    expect(agents.agents).toHaveLength(1)
  })

  it('keeps separate requests per workspace', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const a = listTeamAgents('/ws-one')
    const b = listTeamAgents('/ws-two')
    release()
    await Promise.all([a, b])

    expect(calls).toHaveLength(2)
  })

  it('does not cache responses — a later call refetches', async () => {
    setApiBaseUrl('')
    const { calls, release } = deferredFetch()

    const first = listTeamAgents('/tmp/workspace')
    release()
    await first

    const { calls: secondCalls, release: releaseSecond } = deferredFetch()
    const second = listTeamAgents('/tmp/workspace')
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

    await expect(listTeamAgents('/tmp/workspace')).rejects.toBeDefined()
    // A stuck rejected promise would poison every later caller.
    await expect(listTeamAgents('/tmp/workspace')).rejects.toBeDefined()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
